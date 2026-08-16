/*
 * Run 5.5 — LE JURY : mesurable, pas un ressenti.
 *
 * 1. Notation comparative : le candidat est noté 0-10 contre 3-5 VRAIS logos
 *    du corpus sur relief_3d, glow, matières, fond/présentation, construction
 *    du lettrage/emblème, et FiveM-ness globale. Chaque critère < 7 exige le
 *    défaut nommé en une phrase concrète.
 * 2. Test à l'aveugle : 4 logos (3 corpus + candidat, ordre aléatoire),
 *    « lequel n'appartient pas à la famille ? », répété 3 fois avec des trios
 *    différents. Intrus identifié <= 1 fois sur 3 → le candidat « passe ».
 *
 * Les prompts sont VERSIONNÉS (JURY_PROMPT_VERSION) : toute évolution du
 * jury = nouvelle version tracée au journal, jamais un ajustement silencieux.
 */

import { geminiMultimodal, type GeminiPart } from '../../src/lib/ai/gemini'
import { sampleGoldStratified, toCorpusEncoding, type CorpusImage } from './corpus'
import { setBudgetLabel } from './budget4'

export const JURY_MODEL = 'gemini-3.5-flash'
// v2 : échelle ANCRÉE après calibrage de l'instrument (2 vrais logos corpus
// scoraient 6/10 en v1 — le jury notait contre les seules ancres 3D, alors
// que l'ADN mesuré donne relief>=6 sur 22 % du corpus seulement : les
// silhouettes plates premium sont des membres pleins de la famille).
// v3 (run 5.6) : le verdict client a prouvé que le rubric v2 était mal
// calibré — AUCUN critère de fond travaillé, biais relief résiduel. v3 :
//   1. critère fond_travaille /10 (couche texture/scène/motif quasi invisible
//      à la fourchette corpus — un fond VIDE plafonne la note globale à 6,
//      plafond appliqué MÉCANIQUEMENT en code) ;
//   2. biais relief supprimé : 3 familles de rendu mesurées (plat premium
//      46 %, semi-flat biseauté 32 %, dimensionnelle 22 %), aucune supérieure,
//      le candidat se juge DANS la famille qu'il a choisie ;
//   3. matières durcies : candy gloss uniforme = défaut de matières.
// Loi du run 5.6 : si rubric et aveugle se contredisent, l'AVEUGLE gagne et
// c'est le rubric qu'on corrige — jamais l'inverse.
// v4 (run 5.7) : pénalité « SIGNATURE 2015 » bornée par la distribution PSD
// mesurée (13 PSD pros décomposés) : les contours pros sont FINS ET CLAIRS
// (médiane 3 px, p25-p75 [2-4], couleurs #ffffff×8/#8fff97×3 — AUCUN triple
// contour noir épais dans le corpus pro), le biseau quasi absent (médiane
// 0 px). Triple contour noir épais, italique badge par défaut, biseau chrome
// candy = signature esport 2015 → fivemness plafonnée à 6 EN CODE.
// v4.1 : le flag 2015 sur-déclenchait (vu iter3-57-fruitz-plat : aveugle 0/3
// mais flag sur UN liseré blanc — couleur claire ×11 dans la distribution PSD
// — et sur un emblème qui CHEVAUCHE le lettrage). Loi 5.6 appliquée :
// l'aveugle contredit le rubric → on corrige le rubric. Les marqueurs (a) et
// (d) exigent maintenant : contours SOMBRES et EMPILÉS (>= 2 anneaux), et
// mascotte/blason SÉPARÉ ne touchant pas le lettrage.
// v4.2 : v4.1 surcorrigait (balancier du 5.6) — le « when in doubt, do NOT
// flag » global a fait remonter le VRAI positif candy (final56-fruitz-dim,
// LE rendu rejeté par le client) à 9/10. v4.2 : le doute ne protège que les
// marqueurs (a)/(d) — le marqueur (c) candy/chrome uniforme garde tout son
// mordant, même poli.
// v4.3 : v4.2 restait non-répétable sur flash (dim candy non flagué, plat mat
// flagué candy+mascotte). Le flag se recentre sur LE LETTRAGE SEUL — le prior
// « esport 2015 » du verdict client est un prior de lettrage, les marqueurs
// de layout (a)/(d) produisaient 100 % des faux positifs, et pour les
// candidats du pipeline calques ils sont déjà bornés EN CODE par le
// validateur de recette (logo-stack.ts). L'emblème reste couvert par
// `matieres` (candy = défaut) et l'aveugle reste l'arbitre final.
// v5 (run 5.9) : le checkpoint 5.8 validé par jury-v4.3 a été REJETÉ par
// l'opérateur — le jury donnait 9/10 zéro défaut à un sticker à contour blanc
// candy-gloss sur fond clair (iter10b) et 8/10 à « FRU VTZ » avec épi de blé
// (iter11). Deux causes : la barre était la MOYENNE du corpus (panel médian),
// et aucun détecteur des échecs réellement vus. v5 :
//   1. la barre devient le GOLD SET (_gold-set.json — les pépites niveau
//      cible : vrai wordmark Fruitz, badge ALYA, South District chrome…) ;
//   2. quatre détecteurs ÉLIMINATOIRES relevés du checkpoint rejeté —
//      bordure sticker autour du lockup ENTIER, vernis candy uniforme,
//      glyphes déformés/illisibles, fond qui domine la marque — chacun
//      plafonne fivemness à 4 EN CODE.
export const JURY_PROMPT_VERSION = 'jury-v5 (2026-08-16, barre = gold set + 4 détecteurs éliminatoires du checkpoint rejeté)'
// aveugle-v2 : les trios sortent de la SOUS-FAMILLE PREMIUM (relief>=5 ou
// glow>=7 au manifest v4) — un candidat tiré contre 3 pièces faibles du
// corpus hétérogène se faisait repérer POUR EXCÈS DE QUALITÉ (vu iter2 :
// 3/3 « highly polished whereas the others are flat »), l'inverse du but.
// aveugle-v3 : le juge interprétait « n'appartient pas » comme « n'est pas du
// même NIVEAU » — un candidat plus poli que son trio se faisait exclure pour
// excès de qualité (vu final-fruitz-1 : « highly polished whereas the others
// are simpler community-made »). v3 dit explicitement que la famille couvre
// plusieurs langues de rendu et que le polish seul n'identifie pas l'intrus.
// aveugle-v4 (run 5.9) : les trios sortent du GOLD SET — se fondre dans la
// moyenne du corpus ne prouvait rien (iter10b passait l'aveugle 1/3 tout en
// étant un sticker) ; se fondre parmi les pépites est la vraie barre.
export const BLIND_VERSION = 'aveugle-v4 (2026-08-16, trios tirés du GOLD SET, stratifiés >=1 dimensionnelle + >=1 plate/semi)'

export type JuryScores = {
  relief_3d: number
  glow: number
  matieres: number
  fond_presentation: number
  // v3 : le fond TRAVAILLÉ — texture/scène/motif subtil présent, opacités
  // dans la fourchette corpus. Un fond vide plafonne fivemness à 6 (en code).
  fond_travaille: number
  construction: number
  fivemness: number
  // v4 : signature esport 2015 détectée (marqueurs hors distribution PSD) —
  // plafonne fivemness à 6 EN CODE.
  signature_2015: { detectee: boolean; marqueurs: string[] }
  // v5 : les quatre détecteurs éliminatoires du checkpoint 5.8 rejeté —
  // chacun plafonne fivemness à 4 EN CODE.
  eliminatoires: {
    sticker_border: boolean
    candy_coat: boolean
    glyphes_casses: boolean
    fond_dominant: boolean
  }
  defauts: Array<{ critere: string; defaut: string }>
}

export type BlindRound = {
  candidatePosition: number
  intrusChoisi: number
  identified: boolean
  raison: string
  trio: string[]
}

export type BlindResult = {
  rounds: BlindRound[]
  identifiedCount: number
  passed: boolean
}

function clamp10(n: unknown): number {
  const v = Number(n)
  return Number.isFinite(v) ? Math.max(0, Math.min(10, Math.round(v * 10) / 10)) : 0
}

// Les 503 transitoires de gemini-3.5-flash tuaient une manche d'aveugle en
// plein vol (vu 2× au run 5.6, déjà 1× au 5.5). Un 503/429 ne coûte rien au
// grand livre (pas d'usage) : on retente 3× avec backoff avant d'abandonner.
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const status = (err as { status?: number })?.status
      if (status !== 503 && status !== 429) throw err
      const waitMs = 10_000 * (attempt + 1)
      console.log(`   … Gemini ${status}, nouvelle tentative dans ${waitMs / 1000}s`)
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }
  throw lastErr
}

// Secours sur JSON malformé : scores par regex + paires critère/défaut.
function salvageScores(text: string): Partial<JuryScores> | null {
  const num = (key: string): number | undefined => {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*([\\d.]+)`))
    return m ? Number(m[1]) : undefined
  }
  const keys = ['relief_3d', 'glow', 'matieres', 'fond_presentation', 'fond_travaille', 'construction', 'fivemness'] as const
  const values = Object.fromEntries(keys.map((k) => [k, num(k)]))
  if (keys.every((k) => values[k] === undefined)) return null
  const defauts = [...text.matchAll(/"critere"\s*:\s*"([^"]+)"\s*[,:]\s*(?:"defaut"\s*:\s*)?"([^"]+)"/g)].map((m) => ({
    critere: m[1]!,
    defaut: m[2]!,
  }))
  // jury-v4 : récupère aussi le booléen signature_2015 d'un JSON malformé
  const sig = text.match(/"detectee"\s*:\s*(true|false)/)
  const signature_2015 = sig
    ? { detectee: sig[1] === 'true', marqueurs: [...text.matchAll(/"marqueurs"\s*:\s*\[([^\]]*)\]/g)].flatMap((m) => (m[1] ?? '').split(',').map((s) => s.replace(/"/g, '').trim()).filter(Boolean)) }
    : undefined
  // jury-v5 : récupère les 4 détecteurs éliminatoires
  const boolOf = (key: string): boolean | undefined => {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*(true|false)`))
    return m ? m[1] === 'true' : undefined
  }
  const sb = boolOf('sticker_border')
  const eliminatoires =
    sb === undefined
      ? undefined
      : {
          sticker_border: sb,
          candy_coat: boolOf('candy_coat') ?? false,
          glyphes_casses: boolOf('glyphes_casses') ?? false,
          fond_dominant: boolOf('fond_dominant') ?? false,
        }
  return { ...values, defauts, signature_2015, eliminatoires } as Partial<JuryScores>
}

export const SCORING_PROMPT = `You are a senior art director judging whether a CANDIDATE logo reaches the TARGET BAR of a premium FiveM/GTA RP logo studio.
The FIRST image is the CANDIDATE. Every following image is a GOLD reference — the very best sellable pieces of the corpus. This is the bar. Not the average: the bar.

SCALE — anchor every score on THE GOLD REFERENCES:
- 10 = equals the best gold pieces. 9 = same league.
- 8 = a client would accept it next to the gold pieces without hesitation.
- 6-7 = clearly below the gold bar — visible gap in finish, construction or discipline.
- <=5 = far outside — would embarrass the studio next to these references.
The family measurably spans THREE render families — flat premium marks (46% of the corpus: satin fills, thick contours), semi-flat beveled two-tone marks (32%: matte bevels, fractures, contour glow), and dimensional marks (22%: deep bevel, controlled chrome, rim glow). NO family is superior: judge the candidate WITHIN the render family it chose — a flat mark is never a defect, and deep 3D is never a bonus in itself.

Score the CANDIDATE 0-10 on each criterion BY DIRECT COMPARISON with the attached references:
- "relief_3d": quality of the dimensionality FOR ITS CHOSEN FAMILY — crisp confident flatness scores as high as a clean deep bevel; only sloppy, muddy or unconvincing execution scores low.
- "glow": contour/rim glow presence and control vs the references (tight edge glow, crisp falloff — in the families that carry it).
- "matieres": material quality — satin/matte premium fills, light grain, controlled accents (chrome, gold, glass, neon). A uniform candy-gloss/gel/wet coating over whole letterforms is a MATERIAL DEFECT, not richness.
- "fond_presentation": how the mark is staged — base nuance (directional gradient, vignette, glow halo behind the mark) vs how the references are presented.
- "fond_travaille": the WORKED background layer. The corpus backgrounds are never empty: 68% carry a barely-visible contextual micro-scene (palm/skyline silhouettes, foliage, figures), 63% a graphic texture (halftone, topographic lines, thin arcs, grain, particles), 41% combine both — desaturated, at roughly 8-20% visibility: sensed, never watched. Score 9-10 = worked layered backdrop in that discreet corpus range; 5-6 = a layer exists but is too faint to matter, or too loud and competing with the mark; <=3 = EMPTY backdrop (flat color/gradient/vignette/light spot alone, NO texture, motif or scene layer).
- "construction": lettering/emblem construction quality — custom letterforms, emblem-letter fusion, negative space, silhouette strength.
- "fivemness": OVERALL — could this candidate be dropped into the family without anyone noticing? This is the global verdict, not an average. HARD RULE: if the backdrop is empty (fond_travaille <= 3), fivemness CANNOT exceed 6.

SIGNATURE 2015 CHECK — LOOK ONLY AT THE LETTERING (the letters of the server name), ignore the emblem and the layout for this check. Measured on 13 decomposed professional PSDs: professional lettering is real typographic display type with thin light strokes (median 3px, white/pale — a single light keyline is normal, never a flag) and satin/matte fills. Flag "signature_2015" ONLY when the LETTERS show:
(b) a default aggressive slanted esport-badge letterstyle with spiky claw cuts and forced italic tension, OR
(c) a shiny wet candy/gel/chrome plastic coating over the letter faces — uniform high-gloss letters that look like wet sweets or liquid chrome. Test: would you describe the letters as "glossy candy" or "wet plastic"? Then flag. If the letters are satin/matte with at most a thin controlled edge highlight, do not flag.
The emblem's materials are judged in "matieres", not here. List the markers you see.

ELIMINATORY DETECTORS (v5) — check each one on the CANDIDATE, mechanically:
- "sticker_border": ONE thick continuous outline/border wrapping the ENTIRE lockup as a single die-cut blob (the corpus' number-one forbidden marker). An outline hugging EACH letterform separately is NOT a sticker border.
- "candy_coat": uniform wet candy/gel/gloss coating over the letter faces, or a glossy sweep across the whole wordmark. Satin/matte with one controlled specular accent does NOT count.
- "glyphes_casses": ANY letterform deformed, swallowed by the emblem, split across lines, carrying a spurious dot, or that a stranger would misread at first glance.
- "fond_dominant": the backdrop competes with the mark — patterns dominate, a geometric figure (rings, arcs, burst) draws the eye more than the mark, or the base reads light/washed-out instead of deep and dark.

For EVERY criterion scoring below 7, name the defect in ONE concrete sentence stating what the candidate does versus what the references do (e.g. "plain empty navy backdrop with a light spot instead of the barely-visible palm/skyline layer the references carry", "uniform candy-gloss coat instead of satin fills with one controlled specular").

Answer ONLY with JSON:
{"relief_3d": n, "glow": n, "matieres": n, "fond_presentation": n, "fond_travaille": n, "construction": n, "fivemness": n, "signature_2015": {"detectee": true|false, "marqueurs": ["..."]}, "eliminatoires": {"sticker_border": bool, "candy_coat": bool, "glyphes_casses": bool, "fond_dominant": bool}, "defauts": [{"critere": "...", "defaut": "one concrete sentence"}]}`

export async function scoreCandidate(opts: {
  candidatePng: Buffer
  refs: CorpusImage[]
  label: string
}): Promise<JuryScores & { refsUtilisees: string[] }> {
  setBudgetLabel(opts.label)
  const candidateJpeg = await toCorpusEncoding(opts.candidatePng)
  const parts: GeminiPart[] = [
    { text: `Judge this candidate against ${opts.refs.length} real family references.` },
    { inlineData: { mimeType: 'image/jpeg', data: candidateJpeg.toString('base64') } },
    ...opts.refs.map((r) => ({ inlineData: { mimeType: 'image/jpeg', data: r.jpeg.toString('base64') } })),
  ]
  // 2 tentatives + extracteur de secours : à température 0 le modèle refait
  // LA MÊME faute de syntaxe (vu : {"critere": "x": "y"}) — le secours regex
  // récupère les 6 scores et les paires critère/défaut d'un JSON malformé.
  let raw: Partial<JuryScores> | null = null
  for (let attempt = 0; attempt < 2 && !raw; attempt += 1) {
    const text = await withRetry(() => geminiMultimodal({
      model: JURY_MODEL,
      parts,
      systemInstruction: SCORING_PROMPT,
      json: true,
      temperature: 0,
      maxOutputTokens: 1600,
      thinkingBudget: 0,
    }))
    const cleaned = text.replace(/^```(?:json)?|```$/g, '').trim()
    try {
      raw = JSON.parse(cleaned) as Partial<JuryScores>
    } catch {
      raw = salvageScores(cleaned)
    }
    // jury-v3 : une réponse sans fond_travaille est HORS CONTRAT — elle ne
    // doit ni plafonner sur un 0 fantôme ni passer : on la rejoue.
    if (raw && (raw.fond_travaille === undefined || raw.fond_travaille === null)) raw = null
    // jury-v4 : idem pour le check signature_2015.
    if (raw && (raw as Partial<JuryScores>).signature_2015?.detectee === undefined) raw = null
    // jury-v5 : idem pour le bloc éliminatoires.
    if (raw && (raw as Partial<JuryScores>).eliminatoires?.sticker_border === undefined) raw = null
  }
  if (!raw) throw new Error('jury illisible ou hors contrat (fond_travaille, signature_2015 ou eliminatoires absent) après 2 tentatives')
  const fondTravaille = clamp10(raw.fond_travaille)
  const signature = {
    detectee: Boolean(raw.signature_2015?.detectee),
    marqueurs: (raw.signature_2015?.marqueurs ?? []).map((m) => String(m).slice(0, 160)).slice(0, 6),
  }
  const eliminatoires = {
    sticker_border: Boolean(raw.eliminatoires?.sticker_border),
    candy_coat: Boolean(raw.eliminatoires?.candy_coat),
    glyphes_casses: Boolean(raw.eliminatoires?.glyphes_casses),
    fond_dominant: Boolean(raw.eliminatoires?.fond_dominant),
  }
  // Les plafonds « fond vide => 6 max » (v3), « signature 2015 => 6 max »
  // (v4) et « éliminatoire => 4 max » (v5) sont appliqués EN CODE, pas
  // seulement demandés au prompt — un rubric ne se fait pas confiance.
  const fivemnessBrute = clamp10(raw.fivemness)
  let fivemness = fondTravaille <= 3 ? Math.min(6, fivemnessBrute) : fivemnessBrute
  if (signature.detectee) fivemness = Math.min(6, fivemness)
  const eliminatoireActifs = (Object.entries(eliminatoires) as Array<[string, boolean]>).filter(([, v]) => v).map(([k]) => k)
  if (eliminatoireActifs.length) fivemness = Math.min(4, fivemness)
  const defauts = (raw.defauts ?? []).map((d) => ({
    critere: String(d.critere ?? '?').slice(0, 40),
    defaut: String(d.defaut ?? '').slice(0, 300),
  }))
  if (fondTravaille <= 3 && fivemnessBrute > 6) {
    defauts.push({
      critere: 'fond_travaille',
      defaut: `empty backdrop capped the global score in code (${fivemnessBrute} -> ${fivemness})`,
    })
  }
  if (signature.detectee) {
    defauts.push({
      critere: 'signature_2015',
      defaut: `2015-esport markers outside the measured PSD distribution capped the global score in code (${fivemnessBrute} -> ${fivemness}): ${signature.marqueurs.join(' ; ') || 'markers unnamed'}`,
    })
  }
  if (eliminatoireActifs.length) {
    defauts.push({
      critere: 'eliminatoire',
      defaut: `eliminatory detector(s) capped the global score in code (${fivemnessBrute} -> ${fivemness}): ${eliminatoireActifs.join(' ; ')}`,
    })
  }
  return {
    relief_3d: clamp10(raw.relief_3d),
    glow: clamp10(raw.glow),
    matieres: clamp10(raw.matieres),
    fond_presentation: clamp10(raw.fond_presentation),
    fond_travaille: fondTravaille,
    construction: clamp10(raw.construction),
    fivemness,
    signature_2015: signature,
    eliminatoires,
    defauts,
    refsUtilisees: opts.refs.map((r) => r.slug),
  }
}

const BLIND_PROMPT = `Here are 4 logos. Exactly THREE of them come from the same premium FiveM/GTA RP logo production family (same studio pipeline); ONE was produced elsewhere.
The family legitimately spans SEVERAL render styles: flat vector marks with neon glow, semi-flat beveled marks, script lettering, and dimensional glossy marks — so polish level alone does NOT identify the outsider, and neither does being simpler or shinier than the others.
Identify the outsider by PRODUCTION FINGERPRINT: edge treatment, glow falloff and control, material handling, lighting discipline, finish coherence, presentation craft — never by subject or color theme.
Answer ONLY with JSON: {"intrus": 1 | 2 | 3 | 4, "raison": "one concrete sentence"}`

export async function blindTest(opts: {
  candidatePng: Buffer
  rand: () => number
  label: string
  rounds?: number
  // run 5.6 : slugs exclus des trios — indispensable en mode calibrate-jury,
  // sinon la pièce sondée peut apparaître DANS son propre trio (doublon
  // d'image → manche structurellement faussée, mesurée ~60 % des runs).
  exclude?: string[]
}): Promise<BlindResult> {
  setBudgetLabel(opts.label)
  const candidateJpeg = await toCorpusEncoding(opts.candidatePng)
  const rounds: BlindRound[] = []
  const usedSlugs: string[] = [...(opts.exclude ?? [])]
  const targetRounds = opts.rounds ?? 3

  // une manche au verdict illisible est REDESSINÉE (nouveau trio) au lieu de
  // compter « non identifié » en faveur du candidat — 6 tirages max
  for (let draw = 0; rounds.length < targetRounds && draw < targetRounds * 2; draw += 1) {
    // trios différents à chaque manche — aucun corpus déjà tiré ne revient
    // (v4 : tirés du gold set ; répétition tolérée si le gold s'épuise)
    const trio = sampleGoldStratified(opts.rand, usedSlugs)
    usedSlugs.push(...trio.map((t) => t.slug))
    const candidatePosition = 1 + Math.floor(opts.rand() * 4)
    const images: Array<{ data: string }> = []
    let cursor = 0
    for (let pos = 1; pos <= 4; pos += 1) {
      if (pos === candidatePosition) images.push({ data: candidateJpeg.toString('base64') })
      else images.push({ data: trio[cursor++]!.jpeg.toString('base64') })
    }
    const parts: GeminiPart[] = [
      { text: 'The 4 logos follow, in order 1, 2, 3, 4.' },
      ...images.map((img) => ({ inlineData: { mimeType: 'image/jpeg', data: img.data } })),
    ]
    // une manche illisible se rejoue UNE fois — sinon elle compterait par
    // défaut comme « non identifié », en faveur du candidat
    let intrusChoisi = 0
    let raison = ''
    for (let attempt = 0; attempt < 2 && !intrusChoisi; attempt += 1) {
      const text = await withRetry(() => geminiMultimodal({
        model: JURY_MODEL,
        parts,
        systemInstruction: BLIND_PROMPT,
        json: true,
        temperature: 0,
        maxOutputTokens: 300,
        thinkingBudget: 0,
      }))
      try {
        const raw = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim()) as { intrus?: unknown; raison?: unknown }
        intrusChoisi = Number(raw.intrus) || 0
        raison = String(raw.raison ?? '').slice(0, 300)
      } catch {
        raison = 'réponse jury illisible (2 tentatives)'
      }
    }
    if (!intrusChoisi) continue // verdict illisible → la manche est redessinée
    rounds.push({
      candidatePosition,
      intrusChoisi,
      identified: intrusChoisi === candidatePosition,
      raison,
      trio: trio.map((t) => t.slug),
    })
  }

  const identifiedCount = rounds.filter((r) => r.identified).length
  return { rounds, identifiedCount, passed: identifiedCount <= 1 }
}
