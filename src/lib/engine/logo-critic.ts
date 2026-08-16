import sharp from 'sharp'
import { geminiMultimodal, type GeminiPart, type GeminiUsage } from '../ai/gemini'
import { adnFor } from './adn'
import { logGeneration } from './guards'
import type { LogoAnswersV3 } from './logo-brief'
import type { LogoConcept } from './logo-director'

// ── Étage 3 : la relecture critique de concept (run 5.3 → 5.8) ───────────────
// Run 5.4, LOT 3 : après l'OCR gate (inchangé), chaque rendu est relu CONTRE
// SON BRIEF **ET CONTRE L'ADN** : thème présent, dégradé/hex respectés, fond
// conforme, CONFORMITÉ ADN (relief mesuré quand le concept est en rendu
// relief, glow quand l'ADN le porte, verdict « logo de serveur ou icône
// d'appli ? ») et LISIBILITÉ 64 px (la vignette réduite voyage dans l'appel).
// Run 5.8 (chantier 4) : la critique devient COMPARATIVE — 1-2 références de
// la même famille de rendu sont jointes à l'appel comme étalon (iter10b :
// la critique sans étalon lisait relief 2 sur un rendu que le jury notait 8).
// Deux champs nouveaux : `premium` 0-10 (écart de finition avec les
// références jointes — < 6 déclenche la régénération ciblée) et
// `calque_fautif` fond|lockup|null (remplace la détection regex calqueCible
// qui ratait dès qu'un défaut était formulé autrement).
// Verdict structuré avec scores ; en cas d'échec, la route régénère UNE fois
// avec les défauts nommés, puis affiche le meilleur des deux. C'est de
// l'analyse mécanique, pas de la création : flash + thinkingBudget 0.

const CRITIC_MODEL = 'gemini-3.5-flash'

// Le seuil de finition : en dessous, régénération ciblée (chantier 4).
export const PREMIUM_SEUIL = 6

export type ConceptScores = {
  relief: number
  glow: number
  /** run 5.8 : écart de finition avec les références jointes, 0-10 */
  premium: number
}

export type CalqueFautif = 'fond' | 'lockup' | null

export type ConceptVerdict = {
  ok: boolean
  themeOk: boolean
  couleursOk: boolean
  fondOk: boolean
  // conformité ADN : relief conforme au rendu demandé + glow si l'ADN le
  // porte + verdict « logo de serveur » (pas une icône d'appli)
  adnOk: boolean
  serveurLogo: boolean
  lisible64: boolean
  scores: ConceptScores
  /** run 5.8 : le calque que la critique désigne comme fautif (structuré) */
  calqueFautif: CalqueFautif
  // défauts nommés — réinjectés tels quels dans le prompt de régénération
  defauts: string[]
  usage: GeminiUsage
}

type CriticReading = {
  theme_present: boolean
  colors_respected: boolean
  background_conform: boolean
  server_logo_not_app_icon: boolean
  relief_score: number
  glow_score: number
  premium_score: number
  faulty_layer: string | null
  legible_at_64px: boolean
  // Run 5.9 (chantier 2) : détecteurs ÉLIMINATOIRES — les quatre échecs
  // exacts du checkpoint 5.8 rejeté par l'opérateur.
  sticker_border: boolean // contour unique autour du lockup ENTIER (iter10b)
  candy_coat: boolean // vernis candy/gel uniforme sur les lettres (iter10b)
  glyphs_intact: boolean // toutes les formes de lettres propres (iter11/12 : non)
  fond_discret: boolean // le fond se sent, ne se regarde pas (iter12 : non)
  defects: string[]
}

function clampScore(n: unknown): number {
  const v = Number(n)
  return Number.isFinite(v) ? Math.max(0, Math.min(10, Math.round(v * 10) / 10)) : 0
}

// Run 5.5 : extracteur de secours sur JSON malformé — la calibration a montré
// (iter0) qu'une lecture illisible déclenchait le verdict permissif silencieux
// (scores à 0, ok=true). À température 0 le modèle refait LA MÊME faute de
// syntaxe : on récupère les booléens/scores par regex avant d'abandonner.
function salvageReading(text: string): CriticReading | null {
  const bool = (key: string): boolean | undefined => {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*(true|false)`))
    return m ? m[1] === 'true' : undefined
  }
  const num = (key: string): number | undefined => {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*([\\d.]+)`))
    return m ? Number(m[1]) : undefined
  }
  const theme = bool('theme_present')
  const colors = bool('colors_respected')
  const background = bool('background_conform')
  if (theme === undefined && colors === undefined && background === undefined) return null
  const faulty = text.match(/"faulty_layer"\s*:\s*"(fond|lockup)"/)
  return {
    theme_present: theme ?? true,
    colors_respected: colors ?? true,
    background_conform: background ?? true,
    server_logo_not_app_icon: bool('server_logo_not_app_icon') ?? true,
    relief_score: num('relief_score') ?? 0,
    glow_score: num('glow_score') ?? 0,
    premium_score: num('premium_score') ?? PREMIUM_SEUIL,
    faulty_layer: faulty?.[1] ?? null,
    legible_at_64px: bool('legible_at_64px') ?? true,
    sticker_border: bool('sticker_border') ?? false,
    candy_coat: bool('candy_coat') ?? false,
    glyphs_intact: bool('glyphs_intact') ?? true,
    fond_discret: bool('fond_discret') ?? true,
    defects: [...text.matchAll(/"defects"\s*:\s*\[([^\]]*)\]/g)]
      .flatMap((m) => [...(m[1] ?? '').matchAll(/"([^"]+)"/g)].map((d) => d[1]!))
      .slice(0, 5),
  }
}

export async function reviewLogoAgainstConcept(opts: {
  dataUrl: string
  concept: LogoConcept
  answers: LogoAnswersV3
  projectName: string
  /** run 5.8 : 1-2 références de la MÊME famille de rendu — l'étalon premium */
  references?: Array<{ data: string; mimeType: string }>
  log: { userId: string; projectId?: string | null; assetId?: string | null; kind: string }
}): Promise<ConceptVerdict> {
  const { answers, concept } = opts
  const base64 = opts.dataUrl.split(',').pop() ?? ''
  const source = Buffer.from(base64, 'base64')
  const small = await sharp(source)
    .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer()
  // La vignette 64 px, remontée en 256 px au plus proche voisin : le modèle
  // voit EXACTEMENT la dégradation qu'un avatar Discord subira.
  const thumb64 = await sharp(await sharp(source).resize(64, 64, { fit: 'inside' }).png().toBuffer())
    .resize(256, 256, { kernel: 'nearest', fit: 'inside' })
    .png()
    .toBuffer()

  // Les attentes ADN sont CHIFFRÉES — mêmes seuils que le validateur.
  const adn = adnFor('logo')
  const glowAttendu = (adn.frequences.glow_pct ?? 0) >= 60

  const expectations = [
    answers.sujet
      ? `THEME: the logo must visibly embody the theme "${answers.sujet}" (given by the user). A generic compass/crest/badge with no trace of this theme = theme_present false.`
      : 'THEME: none required (pure lettering brief) — theme_present is true unless an unrequested foreign theme dominates.',
    answers.couleurs.mode === 'degrade'
      ? `COLORS: the mark must carry a gradient close to ${answers.couleurs.couleurs.join(' → ')} (direction ~${answers.couleurs.angle}°). Flat single-color rendering or wrong hue family = colors_respected false.`
      : answers.couleurs.mode === 'unie'
        ? `COLORS: the dominant color must be close to ${answers.couleurs.couleur}. A clearly different hue family = colors_respected false.`
        : 'COLORS: free palette — colors_respected is true unless the render is muddy or colorless.',
    // Run 5.6 : le fond fait partie du logo — le corpus mesuré (LOT 1) est
    // travaillé à 90 % (micro-scène 68 %, texture 63 %, quasi invisible).
    // Le fond VIDE du 5.5 (« EMPTY and calm ») est désormais un ÉCHEC.
    'BACKGROUND: expected the corpus presentation backdrop — a deep dark nuanced base (directional gradient, vignette, soft glow behind the mark) CARRYING one barely-visible worked layer at ~8-20% opacity: a thematic motif, a contextual micro-scene (palm/skyline silhouettes, foliage), or a graphic texture (halftone, topographic lines, arcs, grain). background_conform is FALSE if: flat white/light studio background, OR an EMPTY dark backdrop (plain gradient/light spot with NO texture, motif or scene layer), OR a loud busy scene with sharp objects/readable text competing with the mark.',
    `DNA CONFORMITY (this concept is declared "${concept.rendu}"):`,
    concept.rendu === 'relief'
      ? '- relief_score: measure the 3D relief/bevel/extrusion of the mark, 0 (flat) to 10 (deep dimensional). This concept REQUIRES relief_score >= 5.'
      : '- relief_score: measure it anyway (0-10) — this concept is a flat premium silhouette, low relief is expected and fine.',
    `- glow_score: measure the contour/rim glow 0-10.${glowAttendu ? ` The corpus DNA carries glow on ${adn.frequences.glow_pct}% of references — a completely glow-less mark (glow_score < 3) is a DNA failure for a relief concept.` : ''}`,
    '- server_logo_not_app_icon: TRUE only if this reads as a FiveM/esport SERVER LOGO (dimensional emblem/lettering, dramatic finish) — FALSE if it reads as a flat corporate app icon, sticker or startup mark.',
    'LEGIBILITY: the second attached image is the 64 px version of the same logo (upscaled for viewing). legible_at_64px = TRUE only if the subject and lettering remain identifiable there.',
    answers.interdits ? `USER FORBIDS: "${answers.interdits}" — if violated, name it in defects.` : '',
  ].filter(Boolean).join('\n')

  // Run 5.8 : l'étalon comparatif — 1-2 vraies références de la même famille.
  const refs = (opts.references ?? []).slice(0, 2)

  let usage: GeminiUsage = { tokensIn: 0, tokensOut: 0 }
  const parts: GeminiPart[] = [
    {
      text: [
        `The FIRST image is a logo proposal for the server "${opts.projectName}", generated from the concept "${concept.nom}" (declared render: ${concept.rendu}). The SECOND image is its 64 px thumbnail.`,
        refs.length
          ? `The ${refs.length === 2 ? 'THIRD and FOURTH images are' : 'THIRD image is'} REAL reference logo${refs.length === 2 ? 's' : ''} of the same render family (${concept.famille}) from the corpus — the finish bar the proposal must reach.`
          : '',
        `CONCEPT INTENT: ${concept.justification}`,
        'Review the render STRICTLY against these expectations:',
        expectations,
        refs.length
          ? `PREMIUM GAP: premium_score (0-10) measures how close the proposal's finish comes to the attached reference logos — materials, lettering treatment, edge control, glow discipline, backdrop work. 10 = same studio quality, ${PREMIUM_SEUIL - 1} or below = clearly cheaper (flat fills, stock font feel, sticker look, muddy edges).`
          : `PREMIUM GAP: premium_score (0-10) measures the overall finish level — 10 = premium studio quality, ${PREMIUM_SEUIL - 1} or below = clearly cheap.`,
        'FAULTY LAYER: faulty_layer names the layer carrying the worst defects — "fond" (the backdrop layer) or "lockup" (the mark itself: lettering, emblem, materials, glow), or null if nothing fails.',
        'ELIMINATORY DETECTORS (each one alone is a FAIL):',
        '- sticker_border: TRUE if ONE thick continuous outline/border wraps around the ENTIRE lockup as a single blob (the sticker/die-cut look). An outline hugging EACH letterform separately is fine and does NOT count.',
        '- candy_coat: TRUE if the letter faces carry a uniform wet candy/gel/gloss coating or a glossy sweep across the whole wordmark. Satin/matte fills with ONE controlled specular accent do NOT count.',
        '- glyphs_intact: FALSE if ANY letterform is deformed, swallowed by the emblem, split across lines, has a spurious dot, or would NOT be read correctly at first glance by a stranger who does not know the word.',
        '- fond_discret: FALSE if the backdrop competes with the mark — patterns dominate the image, OR any geometric figure (rings, arcs, burst, disc) draws the eye more than the mark, OR the base reads light/washed-out instead of deep and dark. The backdrop must be sensed, never watched.',
        'Answer as JSON: {"theme_present": bool, "colors_respected": bool, "background_conform": bool, "server_logo_not_app_icon": bool, "relief_score": 0-10, "glow_score": 0-10, "premium_score": 0-10, "faulty_layer": "fond"|"lockup"|null, "legible_at_64px": bool, "sticker_border": bool, "candy_coat": bool, "glyphs_intact": bool, "fond_discret": bool, "defects": ["each failed expectation as one short imperative fix instruction in English, e.g. \'deepen the bevel and extrusion of the lettering\', \'add a controlled rim glow around the emblem\', \'apply the coral-to-peach gradient on the wordmark\'"]}. Empty defects array if everything passes.',
      ].filter(Boolean).join('\n'),
    },
    { inlineData: { mimeType: 'image/jpeg', data: small.toString('base64') } },
    { inlineData: { mimeType: 'image/png', data: thumb64.toString('base64') } },
    ...refs.map((r) => ({ inlineData: { mimeType: r.mimeType, data: r.data } })),
  ]

  let reading: CriticReading | null = null
  try {
    const text = await geminiMultimodal({
      model: CRITIC_MODEL,
      parts,
      json: true,
      temperature: 0,
      maxOutputTokens: 700,
      thinkingBudget: 0,
      onUsage: (u) => {
        usage = { tokensIn: usage.tokensIn + u.tokensIn, tokensOut: usage.tokensOut + u.tokensOut }
      },
    })
    const cleaned = text.replace(/^```(?:json)?|```$/g, '').trim()
    try {
      reading = JSON.parse(cleaned) as CriticReading
    } catch {
      reading = salvageReading(cleaned)
    }
  } catch {
    reading = null
  }

  // Vision illisible : on ne bloque pas le produit — verdict permissif tracé.
  let verdict: ConceptVerdict
  if (!reading) {
    verdict = {
      ok: true, themeOk: true, couleursOk: true, fondOk: true, adnOk: true,
      serveurLogo: true, lisible64: true,
      scores: { relief: 0, glow: 0, premium: PREMIUM_SEUIL },
      calqueFautif: null, defauts: [], usage,
    }
  } else {
    const scores = {
      relief: clampScore(reading.relief_score),
      glow: clampScore(reading.glow_score),
      premium: clampScore(reading.premium_score),
    }
    const serveurLogo = Boolean(reading.server_logo_not_app_icon)
    const reliefConforme = concept.rendu !== 'relief' || scores.relief >= 5
    const glowConforme = !glowAttendu || concept.rendu !== 'relief' || scores.glow >= 3
    const adnOk = serveurLogo && reliefConforme && glowConforme
    const lisible64 = Boolean(reading.legible_at_64px)
    // Run 5.9 : les quatre détecteurs éliminatoires du checkpoint rejeté.
    const stickerBorder = Boolean(reading.sticker_border)
    const candyCoat = Boolean(reading.candy_coat)
    const glyphsIntact = reading.glyphs_intact !== false
    const fondDiscret = reading.fond_discret !== false
    const premiumOk = scores.premium >= PREMIUM_SEUIL
    const eliminatoireOk = !stickerBorder && !candyCoat && glyphsIntact && fondDiscret
    const calqueFautif: CalqueFautif =
      reading.faulty_layer === 'fond' || reading.faulty_layer === 'lockup'
        ? reading.faulty_layer
        : stickerBorder || candyCoat || !glyphsIntact
          ? 'lockup'
          : !fondDiscret
            ? 'fond'
            : null
    verdict = {
      themeOk: Boolean(reading.theme_present),
      couleursOk: Boolean(reading.colors_respected),
      fondOk: Boolean(reading.background_conform) && fondDiscret,
      adnOk,
      serveurLogo,
      lisible64,
      scores,
      calqueFautif,
      defauts: (reading.defects ?? []).map((d) => String(d)).slice(0, 5),
      ok:
        Boolean(reading.theme_present && reading.colors_respected && reading.background_conform) &&
        adnOk && lisible64 && eliminatoireOk && premiumOk,
      usage,
    }
    // échec sans défaut nommé par le modèle : on nomme le défaut nous-mêmes
    if (!verdict.ok && !verdict.defauts.length) {
      if (!serveurLogo) verdict.defauts.push('make it read as a dimensional FiveM server logo, not a flat app icon')
      if (!reliefConforme) verdict.defauts.push('deepen the 3D bevel/extrusion — this concept is a relief render')
      if (!glowConforme) verdict.defauts.push('add a controlled contour/rim glow as the corpus DNA carries')
      if (!lisible64) verdict.defauts.push('simplify the construction so the mark stays identifiable at 64 px')
      if (stickerBorder) verdict.defauts.push('remove the single thick border around the whole lockup — outline each letterform separately instead')
      if (candyCoat) verdict.defauts.push('replace the uniform candy-gloss coating with satin/matte fills and one controlled specular accent')
      if (!glyphsIntact) verdict.defauts.push('redraw every letterform clean and fully legible — no deformed, swallowed or split glyphs')
      if (!fondDiscret) verdict.defauts.push('quiet the backdrop: deep dark base, motifs at 8-20% opacity, no geometric figure competing with the mark')
      if (!premiumOk) verdict.defauts.push('raise the finish to the reference bar: layered satin fills, controlled edge light, disciplined glow')
    }
  }

  void logGeneration({
    userId: opts.log.userId,
    projectId: opts.log.projectId ?? null,
    assetId: opts.log.assetId ?? null,
    kind: verdict.ok ? opts.log.kind : `${opts.log.kind}_echec`,
    model: CRITIC_MODEL,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
  })

  return verdict
}
