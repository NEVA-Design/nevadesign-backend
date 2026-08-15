import sharp from 'sharp'
import { geminiMultimodal, type GeminiPart, type GeminiUsage } from '../ai/gemini'
import { adnFor } from './adn'
import { logGeneration } from './guards'
import type { LogoAnswersV3 } from './logo-brief'
import type { LogoConcept } from './logo-director'

// ── Étage 3 : la relecture critique de concept (run 5.3 → 5.4) ───────────────
// Run 5.4, LOT 3 : après l'OCR gate (inchangé), chaque rendu est relu CONTRE
// SON BRIEF **ET CONTRE L'ADN** : thème présent, dégradé/hex respectés, fond
// conforme, CONFORMITÉ ADN (relief mesuré quand le concept est en rendu
// relief, glow quand l'ADN le porte, verdict « logo de serveur ou icône
// d'appli ? ») et LISIBILITÉ 64 px (la vignette réduite voyage dans l'appel).
// Verdict structuré avec scores ; en cas d'échec, la route régénère UNE fois
// avec les défauts nommés, puis affiche le meilleur des deux. C'est de
// l'analyse mécanique, pas de la création : flash + thinkingBudget 0.

const CRITIC_MODEL = 'gemini-3.5-flash'

export type ConceptScores = {
  relief: number
  glow: number
}

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
  legible_at_64px: boolean
  defects: string[]
}

function clampScore(n: unknown): number {
  const v = Number(n)
  return Number.isFinite(v) ? Math.max(0, Math.min(10, Math.round(v * 10) / 10)) : 0
}

export async function reviewLogoAgainstConcept(opts: {
  dataUrl: string
  concept: LogoConcept
  answers: LogoAnswersV3
  projectName: string
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
    'BACKGROUND: expected a flat uniform neutral studio background (light grey, for cutout). A busy scene or full-bleed decorated background behind the mark = background_conform false.',
    `DNA CONFORMITY (this concept is declared "${concept.rendu}"):`,
    concept.rendu === 'relief'
      ? '- relief_score: measure the 3D relief/bevel/extrusion of the mark, 0 (flat) to 10 (deep dimensional). This concept REQUIRES relief_score >= 5.'
      : '- relief_score: measure it anyway (0-10) — this concept is a flat premium silhouette, low relief is expected and fine.',
    `- glow_score: measure the contour/rim glow 0-10.${glowAttendu ? ` The corpus DNA carries glow on ${adn.frequences.glow_pct}% of references — a completely glow-less mark (glow_score < 3) is a DNA failure for a relief concept.` : ''}`,
    '- server_logo_not_app_icon: TRUE only if this reads as a FiveM/esport SERVER LOGO (dimensional emblem/lettering, dramatic finish) — FALSE if it reads as a flat corporate app icon, sticker or startup mark.',
    'LEGIBILITY: the second attached image is the 64 px version of the same logo (upscaled for viewing). legible_at_64px = TRUE only if the subject and lettering remain identifiable there.',
    answers.interdits ? `USER FORBIDS: "${answers.interdits}" — if violated, name it in defects.` : '',
  ].filter(Boolean).join('\n')

  let usage: GeminiUsage = { tokensIn: 0, tokensOut: 0 }
  const parts: GeminiPart[] = [
    {
      text: [
        `The FIRST image is a logo proposal for the server "${opts.projectName}", generated from the concept "${concept.nom}" (declared render: ${concept.rendu}). The SECOND image is its 64 px thumbnail.`,
        `CONCEPT INTENT: ${concept.justification}`,
        'Review the render STRICTLY against these expectations:',
        expectations,
        'Answer as JSON: {"theme_present": bool, "colors_respected": bool, "background_conform": bool, "server_logo_not_app_icon": bool, "relief_score": 0-10, "glow_score": 0-10, "legible_at_64px": bool, "defects": ["each failed expectation as one short imperative fix instruction in English, e.g. \'deepen the bevel and extrusion of the lettering\', \'add a controlled rim glow around the emblem\', \'apply the coral-to-peach gradient on the wordmark\'"]}. Empty defects array if everything passes.',
      ].join('\n'),
    },
    { inlineData: { mimeType: 'image/jpeg', data: small.toString('base64') } },
    { inlineData: { mimeType: 'image/png', data: thumb64.toString('base64') } },
  ]

  let reading: CriticReading | null = null
  try {
    const text = await geminiMultimodal({
      model: CRITIC_MODEL,
      parts,
      json: true,
      temperature: 0,
      maxOutputTokens: 500,
      thinkingBudget: 0,
      onUsage: (u) => {
        usage = { tokensIn: usage.tokensIn + u.tokensIn, tokensOut: usage.tokensOut + u.tokensOut }
      },
    })
    reading = JSON.parse(text) as CriticReading
  } catch {
    reading = null
  }

  // Vision illisible : on ne bloque pas le produit — verdict permissif tracé.
  let verdict: ConceptVerdict
  if (!reading) {
    verdict = {
      ok: true, themeOk: true, couleursOk: true, fondOk: true, adnOk: true,
      serveurLogo: true, lisible64: true, scores: { relief: 0, glow: 0 }, defauts: [], usage,
    }
  } else {
    const scores = { relief: clampScore(reading.relief_score), glow: clampScore(reading.glow_score) }
    const serveurLogo = Boolean(reading.server_logo_not_app_icon)
    const reliefConforme = concept.rendu !== 'relief' || scores.relief >= 5
    const glowConforme = !glowAttendu || concept.rendu !== 'relief' || scores.glow >= 3
    const adnOk = serveurLogo && reliefConforme && glowConforme
    const lisible64 = Boolean(reading.legible_at_64px)
    verdict = {
      themeOk: Boolean(reading.theme_present),
      couleursOk: Boolean(reading.colors_respected),
      fondOk: Boolean(reading.background_conform),
      adnOk,
      serveurLogo,
      lisible64,
      scores,
      defauts: (reading.defects ?? []).map((d) => String(d)).slice(0, 5),
      ok: Boolean(reading.theme_present && reading.colors_respected && reading.background_conform) && adnOk && lisible64,
      usage,
    }
    // échec ADN sans défaut nommé par le modèle : on nomme le défaut nous-mêmes
    if (!verdict.ok && !verdict.defauts.length) {
      if (!serveurLogo) verdict.defauts.push('make it read as a dimensional FiveM server logo, not a flat app icon')
      if (!reliefConforme) verdict.defauts.push('deepen the 3D bevel/extrusion — this concept is a relief render')
      if (!glowConforme) verdict.defauts.push('add a controlled contour/rim glow as the corpus DNA carries')
      if (!lisible64) verdict.defauts.push('simplify the construction so the mark stays identifiable at 64 px')
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
