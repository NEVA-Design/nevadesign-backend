/*
 * Run 6 — LA MESURE v6 : sortir du rubric saturé.
 *
 * Trois candidats notés 8-9/10 avec aveugle 0/3 ont été rejetés par
 * l'opérateur (5.8, 5.9, 5.10). Un barème qui donne 9/10 à ce que l'opérateur
 * refuse n'est pas mal calibré : il est SATURÉ, il ne discrimine plus dans le
 * haut. Ce module ajoute deux instruments qui, eux, discriminent :
 *
 *   §7.1  overlap_ratio — un appel flash renvoie DEUX BBOXES (emblème,
 *         lettrage) ; la DÉCISION est en code. Mesuré sur les pièces gold :
 *         0,4 à 0,8. Mesuré sur les rendus rejetés : ~0,05 à 0,15. C'est
 *         « l'audace de composition » rendue chiffrable — l'emblème CONTIENT
 *         le lettrage au lieu d'être posé à côté.
 *
 *   §7.2  duel forcé contre le gold set — remplace le score absolu comme
 *         critère de livraison. Un duel par pièce gold, joué DEUX FOIS avec
 *         A/B inversés ; seuls les verdicts cohérents comptent (le biais de
 *         position d'un juge flash est mesurable et il fausse tout).
 *
 * Le jury v5 et l'aveugle restent — pour TRIER les essais, jamais pour
 * livrer. La loi tient : le verdict final est humain.
 */

import sharp from 'sharp'
import { geminiMultimodal, type GeminiPart } from '../../src/lib/ai/gemini'
import {
  aire,
  decideOverlap,
  decideOverlapPourArchetype,
  decideDebordement,
  contratComposition,
  intersection,
  normaliseBbox,
  overlapRatio,
  parseBox2d,
  seuilOverlap,
  tauxDebordement,
  ARCHETYPES_SANS_EMBLEME,
  DEBORDEMENT_MAX,
  DEBORDEMENT_MIN,
  OVERLAP_ELIMINATOIRE,
  OVERLAP_PASSAGE,
  SEUILS_OVERLAP,
  type Bbox,
  type Masque,
  type VerdictOverlap,
} from '../../src/lib/engine/overlap'
import { goldSetImages, toCorpusEncoding, type CorpusImage } from './corpus'
import { setBudgetLabel } from './budget6'

// La géométrie vit dans le moteur (src/lib/engine/overlap.ts) : le validateur
// du DA impose au blockout EXACTEMENT la formule que cette mesure vérifie sur
// le rendu. On la réexporte pour que les scripts de calibration n'aient qu'un
// point d'entrée.
export {
  aire,
  decideOverlap,
  decideOverlapPourArchetype,
  decideDebordement,
  contratComposition,
  intersection,
  normaliseBbox,
  overlapRatio,
  parseBox2d,
  seuilOverlap,
  tauxDebordement,
  ARCHETYPES_SANS_EMBLEME,
  DEBORDEMENT_MAX,
  DEBORDEMENT_MIN,
  OVERLAP_ELIMINATOIRE,
  OVERLAP_PASSAGE,
  SEUILS_OVERLAP,
}
export type { Bbox, Masque, VerdictOverlap }

export const MESURE_MODEL = 'gemini-3.5-flash'
export const MESURE_VERSION = 'mesure-v6 (2026-08-16, overlap_ratio en code + duel forcé A/B inversé contre le gold set)'

// ── §7.2 — LES SEUILS DU DUEL ────────────────────────────────────────────────
export const DUEL_BARRE = 4 // victoires sur 8 : à la barre
export const DUEL_REJET = 2 // victoires sur 8 : rejet

export type CompositionMesure = {
  emblemPresent: boolean
  emblemBbox: Bbox | null
  wordBbox: Bbox | null
  overlapRatio: number
  /** PATCH P1 : le verdict dépend de l'ARCHÉTYPE visé, jamais d'un seuil plat.
   *  `non_mesure` = l'instrument n'a rien pu lire — ce n'est PAS un échec du
   *  candidat (voir mesurable ci-dessous). */
  verdict: VerdictOverlap | 'non_mesure'
  /** false = aucune boîte exploitable après 3 essais. Un overlap de 0,000 dans
   *  ce cas ne veut rien dire et ne doit JAMAIS être présenté comme un
   *  éliminatoire : relevé sur le rejeu d'azure, dont l'anneau traverse
   *  visiblement le mot alors que la mesure publiait 0,000. */
  mesurable: boolean
  /** le seuil réellement appliqué (null = mesure non applicable) */
  seuil: number | null
  /** l'archétype sous lequel la mesure a été jugée */
  archetype: string | null
  /** ce que le modèle dit voir — trace, jamais une décision */
  note: string
  /** nombre d'appels qu'il a fallu pour obtenir une mesure au contrat */
  essais: number
  tokensIn: number
  tokensOut: number
}

// Les 503/429 transitoires de flash ne coûtent rien au grand livre : on
// retente avec backoff avant d'abandonner (même loi que le jury).
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

// ── §7.1 — l'appel de mesure : DEUX BBOXES, rien d'autre ─────────────────────
// Le modèle ne juge RIEN ici. Il localise deux objets ; le verdict est calculé
// en code. C'est exactement ce qui manquait au rubric : un critère que le juge
// ne peut pas saturer.

const BBOX_PROMPT = `You are an object detection instrument. You do not judge quality. You locate two objects in the image and report their bounding boxes.

1. THE LETTERING — the server-name letters drawn in the logo (the wordmark or the monogram letter). If several text blocks exist, take the MAIN one (largest, the server name).
2. THE EMBLEM — the pictorial element of the mark: the shape, symbol, creature, object, slice, crest, badge, ring or container that the mark is built around. NOT the background, NOT a texture, NOT a scene element far behind the mark, NOT a glow.

Report each box in your standard detection format: "box_2d": [ymin, xmin, ymax, xmax], as INTEGERS between 0 and 1000, origin at the top-left of the image.
Report the TIGHT box of the object AS IT IS ACTUALLY DRAWN, including the parts that pass behind or in front of the other object. The two boxes routinely overlap — that is expected and must be visible in the numbers: when the lettering sits inside, across or through the emblem, the emblem box CONTAINS or CROSSES the lettering box.
If the mark carries NO pictorial emblem at all (pure lettering), set "emblem_present" to false and "emblem_box_2d" to null.

Answer ONLY with JSON:
{"emblem_present": true|false, "emblem_box_2d": [ymin,xmin,ymax,xmax]|null, "word_box_2d": [ymin,xmin,ymax,xmax]|null, "note": "one short English sentence naming what the emblem is and how it sits relative to the lettering"}`

// Garde de cohérence : quand la note DÉCRIT un chevauchement mais que les
// nombres disent zéro, ce sont les nombres qui mentent (relevé E1 : « the
// lettering layered across its center » avec un overlap de 0,000). On rejoue.
const MOTS_CHEVAUCHEMENT =
  /\b(inside|within|across|through|over|behind|cradl\w*|wrap\w*|encircl\w*|surround\w*|contain\w*|nested|replac\w*|interlock\w*|overlap\w*|pierc\w*|cross\w*)\b/i

export async function mesureComposition(opts: {
  png: Buffer
  label: string
  /** l'archétype VISÉ par le candidat — il fixe le seuil (patch P1). Absent :
   *  on retombe sur le seuil plat legacy, celui d'E1. */
  archetype?: string | null
}): Promise<CompositionMesure> {
  /*
   * PIVOT IDIOME (17/08) — on ne mesure PAS ce qui n'est pas mesurable.
   *
   * Sur un archétype sans emblème séparé du lettrage (HERO_MONOGRAM en tête,
   * devenu l'archétype par défaut), l'overlap n'a pas d'objet : E1 l'a mesuré
   * sur le gold set lui-même, trois pièces de la barre sortent à 0,000 pour
   * cette raison exacte. Lancer l'appel quand même produirait une boîte
   * d'emblème inventée, jusqu'à trois essais, et un chiffre que le rapport
   * afficherait comme une note. On court-circuite : zéro appel, verdict
   * `non_applicable`, et `mesurable: true` — l'instrument n'a pas échoué, il
   * ne s'applique pas.
   */
  if (opts.archetype && ARCHETYPES_SANS_EMBLEME.has(opts.archetype)) {
    const juge = decideOverlapPourArchetype(0, opts.archetype)
    return {
      emblemPresent: false,
      emblemBbox: null,
      wordBbox: null,
      overlapRatio: 0,
      verdict: 'non_applicable',
      mesurable: true,
      seuil: null,
      archetype: opts.archetype,
      note: juge.note,
      essais: 0,
      tokensIn: 0,
      tokensOut: 0,
    }
  }

  setBudgetLabel(opts.label)
  const jpeg = await toCorpusEncoding(opts.png)
  const parts: GeminiPart[] = [
    { inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } },
    { text: 'Measure this logo image.' },
  ]

  let tokensIn = 0
  let tokensOut = 0
  let emblemBbox: Bbox | null = null
  let wordBbox: Bbox | null = null
  let emblemPresent = false
  let note = ''
  let essais = 0

  // 3 essais : une boîte hors contrat (échelles mélangées, ymax <= ymin) ou
  // une note qui contredit les nombres se REJOUE. Un appel flash coûte
  // ~0,0005 € ; un chiffre inventé coûte un run.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    essais = attempt + 1
    const text = await withRetry(() =>
      geminiMultimodal({
        model: MESURE_MODEL,
        parts,
        systemInstruction: BBOX_PROMPT,
        json: true,
        temperature: 0,
        // Piège n°5 de la passation : le thinking mange le budget de SORTIE.
        // À 400 tokens le JSON revenait tronqué (« réponse de mesure
        // illisible » sur 4 sujets/13 au 2e tir de E1). 1400 a tenu sur E3
        // sauf sur le rejeu d'azure — 3 essais, 3 réponses illisibles, sur une
        // image de rue nocturne chargée. Le raisonnement coûte plus cher quand
        // la scène est dense : 2400.
        maxOutputTokens: 2400,
        // localiser deux objets qui se chevauchent est une tâche de vision,
        // pas du parsing : le raisonnement coupé produisait des boîtes
        // disjointes sur des marques manifestement imbriquées (relevé E1).
        thinkingLevel: 'low',
        onUsage: (u) => {
          tokensIn += u.tokensIn
          tokensOut += u.tokensOut
        },
      })
    )
    try {
      const raw = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim()) as {
        emblem_present?: unknown
        emblem_box_2d?: unknown
        word_box_2d?: unknown
        note?: unknown
      }
      emblemPresent = Boolean(raw.emblem_present)
      emblemBbox = parseBox2d(raw.emblem_box_2d)
      wordBbox = parseBox2d(raw.word_box_2d)
      note = String(raw.note ?? '').slice(0, 240)
    } catch {
      note = 'réponse de mesure illisible'
      continue
    }
    if (!wordBbox) continue
    if (emblemPresent && !emblemBbox) continue
    // les nombres contredisent la description : on rejoue plutôt que de
    // publier un overlap de 0 sur une marque décrite comme imbriquée.
    if (emblemBbox && overlapRatio(emblemBbox, wordBbox) === 0 && MOTS_CHEVAUCHEMENT.test(note) && attempt < 2) continue
    break
  }

  const ratio = overlapRatio(emblemBbox, wordBbox)
  // Un échec d'instrument n'est pas un échec de candidat. Sans boîte de
  // lettrage exploitable — ou sans boîte d'emblème alors que le modèle en
  // déclare un — il n'y a pas de mesure : on le DIT, on ne publie pas un zéro.
  const mesurable = Boolean(wordBbox) && (!emblemPresent || Boolean(emblemBbox))
  if (!mesurable) {
    return {
      emblemPresent,
      emblemBbox,
      wordBbox,
      overlapRatio: 0,
      verdict: 'non_mesure',
      mesurable: false,
      seuil: null,
      archetype: opts.archetype ?? null,
      note: `${note} — AUCUNE mesure exploitable après ${essais} essais : ce candidat n'est ni validé ni recalé, il est NON MESURÉ`,
      essais,
      tokensIn,
      tokensOut,
    }
  }
  // P1 : sans archétype déclaré, on garde le barème plat d'E1 pour que les
  // relevés d'E1 restent rejouables à l'identique ; avec archétype, c'est le
  // seuil de la spec qui décide.
  const juge = opts.archetype
    ? decideOverlapPourArchetype(ratio, opts.archetype)
    : { verdict: decideOverlap(ratio) as VerdictOverlap, seuil: OVERLAP_PASSAGE, note: '' }
  return {
    emblemPresent,
    emblemBbox,
    wordBbox,
    overlapRatio: ratio,
    verdict: juge.verdict,
    mesurable: true,
    seuil: juge.seuil,
    archetype: opts.archetype ?? null,
    note: juge.note ? `${note} | ${juge.note}` : note,
    essais,
    tokensIn,
    tokensOut,
  }
}

// ── §7.2 — LE DUEL FORCÉ CONTRE LE GOLD SET ──────────────────────────────────
// Question unique, pas d'égalité possible, température 0, et surtout : chaque
// duel joué DEUX FOIS avec A/B inversés. Un juge flash a un biais de position
// mesurable ; sans l'inversion, on mesure ce biais et pas la qualité.

const DUEL_PROMPT = `You are shown TWO logos for FiveM / GTA RP servers, labelled A and B.

One single question: a FiveM server owner has 80 € to spend on ONE server logo, and both are available. Which one do they buy?

BOTH candidates are clean, legible and correctly rendered. Cleanliness, legibility and technical correctness are table stakes here — they do NOT decide this duel, and picking the "safer" or "tidier" one is the wrong instinct. The buyer pays for the one they would be proud to put on their Discord, their banner and their loading screen: the one that looks like a real GFX studio piece rather than a competent generic mark.
Ignore the subject matter, the colors and the theme — a citrus logo and a wolf logo are equally valid answers.

You MUST pick A or B. Ties, "both", "neither" and refusals are not valid answers.

Answer ONLY with JSON: {"gagnant": "A"|"B", "raison": "one short concrete English sentence naming the deciding difference"}`

export type DuelManche = {
  goldSlug: string
  /** verdict quand le candidat est en A, puis quand il est en B */
  candidatEnA: 'candidat' | 'gold' | null
  candidatEnB: 'candidat' | 'gold' | null
  coherent: boolean
  /** true seulement si les DEUX ordres donnent le candidat gagnant */
  victoire: boolean
  raisons: string[]
}

export type DuelResultat = {
  manches: DuelManche[]
  duels: number
  coherents: number
  victoires: number
  /** victoires / duels joués — le barème du §7.2 */
  tauxSur8: number
  verdict: 'barre' | 'entre_deux' | 'rejet'
  tokensIn: number
  tokensOut: number
}

export function decideDuel(victoires: number, duels: number): DuelResultat['verdict'] {
  // Barème §7.2 exprimé sur 8 duels — transposé au nombre réellement joué.
  const barre = (DUEL_BARRE / 8) * duels
  const rejet = (DUEL_REJET / 8) * duels
  if (victoires >= barre) return 'barre'
  if (victoires <= rejet) return 'rejet'
  return 'entre_deux'
}

async function unDuel(opts: {
  candidatJpeg: Buffer
  goldJpeg: Buffer
  candidatEn: 'A' | 'B'
  onUsage: (tokensIn: number, tokensOut: number) => void
}): Promise<{ gagnant: 'candidat' | 'gold' | null; raison: string }> {
  const premier = opts.candidatEn === 'A' ? opts.candidatJpeg : opts.goldJpeg
  const second = opts.candidatEn === 'A' ? opts.goldJpeg : opts.candidatJpeg
  const parts: GeminiPart[] = [
    { text: 'LOGO A:' },
    { inlineData: { mimeType: 'image/jpeg', data: premier.toString('base64') } },
    { text: 'LOGO B:' },
    { inlineData: { mimeType: 'image/jpeg', data: second.toString('base64') } },
  ]
  const text = await withRetry(() =>
    geminiMultimodal({
      model: MESURE_MODEL,
      parts,
      systemInstruction: DUEL_PROMPT,
      json: true,
      temperature: 0,
      // idem : budget de sortie généreux, le thinking se sert dedans
      maxOutputTokens: 1200,
      // comparer deux images est une tâche de jugement : le raisonnement coupé
      // ramenait le verdict à « lequel est le plus propre » — exactement le
      // biais qui a validé les trois checkpoints rejetés.
      thinkingLevel: 'low',
      onUsage: (u) => opts.onUsage(u.tokensIn, u.tokensOut),
    })
  )
  try {
    const raw = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim()) as { gagnant?: unknown; raison?: unknown }
    const g = String(raw.gagnant ?? '').trim().toUpperCase()
    if (g !== 'A' && g !== 'B') return { gagnant: null, raison: 'verdict illisible' }
    const gagnant = g === opts.candidatEn ? 'candidat' : 'gold'
    return { gagnant, raison: String(raw.raison ?? '').slice(0, 200) }
  } catch {
    return { gagnant: null, raison: 'verdict illisible' }
  }
}

export async function duelContreGold(opts: {
  candidatPng: Buffer
  label: string
  /** pièces gold à affronter — par défaut le gold set entier */
  golds?: CorpusImage[]
}): Promise<DuelResultat> {
  setBudgetLabel(opts.label)
  const candidatJpeg = await toCorpusEncoding(opts.candidatPng)
  const golds = opts.golds ?? goldSetImages()
  let tokensIn = 0
  let tokensOut = 0
  const onUsage = (i: number, o: number) => {
    tokensIn += i
    tokensOut += o
  }

  const manches: DuelManche[] = []
  for (const gold of golds) {
    // les pièces gold sont déjà des JPEG d'exemplar HQ ; on les repasse par le
    // même encodage que le candidat pour qu'aucun des deux ne soit trahi par
    // sa compression (même loi que l'aveugle).
    const goldJpeg = await toCorpusEncoding(gold.jpeg)
    const enA = await unDuel({ candidatJpeg, goldJpeg, candidatEn: 'A', onUsage })
    const enB = await unDuel({ candidatJpeg, goldJpeg, candidatEn: 'B', onUsage })
    const coherent = enA.gagnant !== null && enA.gagnant === enB.gagnant
    manches.push({
      goldSlug: gold.slug,
      candidatEnA: enA.gagnant,
      candidatEnB: enB.gagnant,
      coherent,
      victoire: coherent && enA.gagnant === 'candidat',
      raisons: [enA.raison, enB.raison],
    })
  }

  const victoires = manches.filter((m) => m.victoire).length
  const coherents = manches.filter((m) => m.coherent).length
  return {
    manches,
    duels: manches.length,
    coherents,
    victoires,
    tauxSur8: Math.round((victoires / Math.max(1, manches.length)) * 8 * 100) / 100,
    verdict: decideDuel(victoires, manches.length),
    tokensIn,
    tokensOut,
  }
}

/** Charge un PNG/JPG de candidat depuis le disque, en buffer PNG exploitable. */
export async function chargeCandidat(path: string): Promise<Buffer> {
  return sharp(path).png().toBuffer()
}
