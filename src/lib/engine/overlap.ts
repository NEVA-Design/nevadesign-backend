/*
 * Run 6 (§7.1) — LA GÉOMÉTRIE DE COMPOSITION, partagée.
 *
 * Une seule formule d'overlap dans tout le projet : celle que le validateur du
 * DA impose au blockout (§5) est EXACTEMENT celle que la mesure vérifie sur le
 * rendu (§7.1). Sans ce partage, on conditionnerait la composition sur un
 * critère et on la noterait sur un autre — l'erreur qui a fait valider trois
 * checkpoints rejetés.
 *
 * Hypothèse sourcée, pas une vérité : sur 5 pièces gold, l'overlap mesuré est
 * de 0,4 à 0,8 ; sur les rendus rejetés (integ1-3 et les deux images du run
 * 5.10), il tombe à ~0,05-0,15. E1 (scripts/calibration/e1-mesure.ts) teste ce
 * lien pour ~0,10 € AVANT toute dépense image.
 */

export type Bbox = [number, number, number, number] // [x, y, w, h] normalisés 0..1

/** LEGACY — le seuil PLAT appliqué par erreur pendant E1. Conservé pour
 *  rejouer E1 à l'identique (scripts/calibration/e1-mesure.ts) et pour rien
 *  d'autre : il recale FLASH MOOD (pièce gold, 0,292). La décision passe par
 *  decideOverlapPourArchetype. */
export const OVERLAP_PASSAGE = 0.3
/** LEGACY, même raison. */
export const OVERLAP_ELIMINATOIRE = 0.2

/** Plancher imposé au blockout selon l'archétype (§5) — les constructions qui
 *  portent la barre exigent davantage de recouvrement. */
export const OVERLAP_BLOCKOUT_CONTENANT = 0.35
export const OVERLAP_BLOCKOUT_AUTRES = 0.2

/*
 * PATCH v6 P1 — LES SEUILS SONT PAR ARCHÉTYPE, jamais plats.
 *
 * E1 a appliqué 0,30 / 0,20 à tout le monde. Mesuré sur le gold set, ce seuil
 * plat RECALE FLASH MOOD (0,292), une pièce de la barre. Les seuils de la spec
 * sont rétablis : ce que l'on exige d'un CONTENANT n'a rien à voir avec ce que
 * l'on exige d'un blason.
 *
 * Et la conséquence dure, mesurée : FLASH MOOD (gold, GLYPH_FUSION) sort à
 * 0,292 quand integ1 (rejeté par l'opérateur) sort à 0,217. Écart 0,075, un
 * point contre un point : sur GLYPH_FUSION, l'overlap NE DISCRIMINE PAS. Cet
 * archétype quitte la rotation de production (voir ARCHETYPES_ROTATION dans
 * logo-director-v6.ts) ; son seuil reste ici pour mesurer les pièces héritées.
 */
export const SEUILS_OVERLAP: Record<string, number> = {
  CONTAINER: 0.35,
  ENTWINED: 0.35,
  CREST: 0.2,
  SCENE: 0.2,
  // hors rotation — conservé pour mesurer FLASH MOOD et les rendus du 5.10
  GLYPH_FUSION: 0.2,
}

/** Le seuil de passage d'un archétype, ou null quand la mesure ne s'applique
 *  pas (marque sans emblème séparé du lettrage). */
export function seuilOverlap(archetype: string | null): number | null {
  if (!archetype) return null
  if (ARCHETYPES_SANS_EMBLEME.has(archetype)) return null
  return SEUILS_OVERLAP[archetype] ?? null
}

export function aire([, , w, h]: Bbox): number {
  return Math.max(0, w) * Math.max(0, h)
}

export function intersection(a: Bbox, b: Bbox): number {
  const x = Math.max(a[0], b[0])
  const y = Math.max(a[1], b[1])
  const right = Math.min(a[0] + a[2], b[0] + b[2])
  const bottom = Math.min(a[1] + a[3], b[1] + b[3])
  return Math.max(0, right - x) * Math.max(0, bottom - y)
}

/** overlap = aire(emblem ∩ word) / aire(word) — la part du LETTRAGE couverte
 *  par l'emblème. Dénominateur = le mot : un emblème géant qui contient le
 *  lettrage donne 1, un emblème posé à côté donne 0, et la taille absolue de
 *  l'emblème n'y change rien. */
export function overlapRatio(emblem: Bbox | null, word: Bbox | null): number {
  if (!emblem || !word) return 0
  const aireWord = aire(word)
  if (aireWord <= 0) return 0
  return Math.round((intersection(emblem, word) / aireWord) * 1000) / 1000
}

export function decideOverlap(ratio: number): 'passage' | 'sous_barre' | 'eliminatoire' {
  if (ratio >= OVERLAP_PASSAGE) return 'passage'
  if (ratio < OVERLAP_ELIMINATOIRE) return 'eliminatoire'
  return 'sous_barre'
}

/**
 * Les archétypes SANS emblème séparé — mesuré à E1 sur le gold set lui-même :
 * le R or fracturé, le script « Sweety Life » et la planche South District
 * sortent à 0,000 parce qu'il n'y a AUCUN emblème distinct du lettrage. Le
 * critère ne les juge pas mal : il ne s'applique pas à eux. Les déclarer
 * éliminatoires reviendrait à recaler trois pièces de la barre.
 *
 * PATCH v6 P1 : il en manquait DEUX. `HERO_MONOGRAM` seul couvrait le R or ;
 * le script Sweety Life (marque 100 % typographique) et la planche South
 * District (emblème et lettrage empilés, aucune intersection) tombaient encore
 * sous le seuil. Les trois zéros du gold set sont maintenant couverts.
 */
export const ARCHETYPES_SANS_EMBLEME = new Set([
  'HERO_MONOGRAM',
  'WORDMARK_PUR', // marque 100 % typographique, aucun emblème (Sweety Life)
  'LOCKUP_EMPILE', // emblème et lettrage empilés sans intersection (South District)
  // brief sans lettrage : il n'y a pas de mot, donc pas de dénominateur
  'EMBLEM_ONLY',
])

export type VerdictOverlap = 'passage' | 'sous_barre' | 'eliminatoire' | 'non_applicable'

/**
 * Le verdict d'overlap DANS le contexte de l'archétype visé (run 6, E1 + P1).
 * Pour une construction sans emblème séparé, l'overlap est une trace
 * informative, jamais un éliminatoire.
 *
 * Éliminatoire = MOINS DE LA MOITIÉ du seuil de l'archétype (patch P1) : la
 * zone grise entre les deux garde son statut de « sous la barre », qui trie
 * sans recaler.
 */
export function decideOverlapPourArchetype(
  ratio: number,
  archetype: string | null
): { verdict: VerdictOverlap; note: string; seuil: number | null } {
  if (archetype && ARCHETYPES_SANS_EMBLEME.has(archetype)) {
    return {
      verdict: 'non_applicable',
      seuil: null,
      note: `${archetype} n'a pas d'emblème séparé du lettrage — l'overlap ne s'y applique pas (mesuré à 0 sur 3 pièces gold)`,
    }
  }
  const seuil = archetype ? SEUILS_OVERLAP[archetype] : undefined
  if (seuil === undefined) {
    // archétype inconnu : on RAPPORTE, on ne décide pas (jamais de seuil
    // inventé sur une construction que la spec ne nomme pas)
    return {
      verdict: 'non_applicable',
      seuil: null,
      note: `archétype "${archetype ?? 'inconnu'}" hors barème — overlap ${ratio.toFixed(3)} rapporté sans verdict`,
    }
  }
  const verdict: VerdictOverlap = ratio >= seuil ? 'passage' : ratio < seuil / 2 ? 'eliminatoire' : 'sous_barre'
  return {
    verdict,
    seuil,
    note: `overlap ${ratio.toFixed(3)} pour ${archetype} (passage >= ${seuil}, éliminatoire < ${seuil / 2})`,
  }
}

/*
 * PATCH v6 P2 — LE TAUX DE DÉBORDEMENT : la seconde métrique, gratuite.
 *
 * Pourquoi elle existe : l'overlap de bbox est maximal (≈ 1,00) pour « mot
 * posé sur une plaque pleine » — exactement la signature sticker combattue
 * depuis le 5.7. La mesure a été validée sur des rendus puis utilisée comme
 * CIBLE du générateur de blockout : quatre formes sur six sont devenues des
 * badges. Une mesure cesse d'être une mesure au moment où elle devient un
 * objectif ; il faut donc la borner PAR LE HAUT avec un second critère que le
 * badge échoue.
 *
 *   debordement = aire(masque_mot \ masque_emblème) / aire(masque_mot)
 *
 * CONVENTION, explicite parce qu'elle change tout : le masque d'emblème est sa
 * SILHOUETTE PLEINE (contour extérieur, trous bouchés). Un anneau dont le mot
 * occupe le creux n'est pas « un mot posé à côté » — c'est le gold Fruitz.
 * Mesurer contre les pixels réellement peints ferait sortir un anneau à ~0,9
 * et classerait la meilleure construction du corpus en défaut.
 */
export const DEBORDEMENT_MIN = 0.05
export const DEBORDEMENT_MAX = 0.35
/** au-delà : le mot est posé à côté — le défaut du 5.10 */
export const DEBORDEMENT_POSE_A_COTE = 0.7

export type Masque = { data: Uint8Array; width: number; height: number }
export type VerdictDebordement = 'badge' | 'contenant_reel' | 'entre_deux' | 'pose_a_cote' | 'non_applicable'

/** Un pixel est « peint » au-dessus de la moitié de l'échelle — les masques
 *  viennent d'un canal alpha ou d'une luminance, jamais d'un booléen. */
const OPAQUE = 127

/**
 * aire(masque_mot \ masque_emblème) / aire(masque_mot), en pixels.
 * Les deux masques doivent avoir la MÊME géométrie : un décalage d'un pixel
 * entre les deux rasters inventerait du débordement.
 */
export function tauxDebordement(mot: Masque, emblemeSilhouette: Masque): number {
  if (mot.width !== emblemeSilhouette.width || mot.height !== emblemeSilhouette.height) {
    throw new Error(
      `masques de géométries différentes (${mot.width}×${mot.height} vs ${emblemeSilhouette.width}×${emblemeSilhouette.height}) — le débordement se mesure sur le même raster`
    )
  }
  let aireMot = 0
  let dehors = 0
  for (let i = 0; i < mot.data.length; i += 1) {
    if ((mot.data[i] ?? 0) <= OPAQUE) continue
    aireMot += 1
    if ((emblemeSilhouette.data[i] ?? 0) <= OPAQUE) dehors += 1
  }
  if (aireMot === 0) return 0
  return Math.round((dehors / aireMot) * 1000) / 1000
}

export function decideDebordement(taux: number): VerdictDebordement {
  if (taux > DEBORDEMENT_POSE_A_COTE) return 'pose_a_cote'
  if (taux < DEBORDEMENT_MIN) return 'badge'
  if (taux <= DEBORDEMENT_MAX) return 'contenant_reel'
  return 'entre_deux'
}

/**
 * Le contrat de composition du patch P2, pour CONTAINER et ENTWINED :
 *   overlap_bbox >= 0,35  ET  0,05 <= debordement <= 0,35
 * Le badge (débordement nul) et le « posé à côté » (overlap nul) sont recalés
 * par les deux bouts. Les autres archétypes ne portent que le contrat overlap.
 */
export function contratComposition(opts: {
  archetype: string | null
  overlap: number
  debordement: number | null
}): { ok: boolean; overlap: ReturnType<typeof decideOverlapPourArchetype>; debordement: VerdictDebordement; raisons: string[] } {
  const overlap = decideOverlapPourArchetype(opts.overlap, opts.archetype)
  const contenant = opts.archetype === 'CONTAINER' || opts.archetype === 'ENTWINED'
  const debordement: VerdictDebordement =
    opts.debordement === null || !contenant ? 'non_applicable' : decideDebordement(opts.debordement)

  const raisons: string[] = []
  if (overlap.verdict === 'eliminatoire' || overlap.verdict === 'sous_barre') {
    raisons.push(overlap.note)
  }
  if (debordement === 'badge') {
    raisons.push(
      `débordement ${opts.debordement?.toFixed(3)} < ${DEBORDEMENT_MIN} — le mot tient entièrement dans la forme : c'est une plaque, pas un contenant`
    )
  }
  if (debordement === 'entre_deux' || debordement === 'pose_a_cote') {
    raisons.push(
      `débordement ${opts.debordement?.toFixed(3)} > ${DEBORDEMENT_MAX} — le lettrage sort trop de l'emblème (au-delà de ${DEBORDEMENT_POSE_A_COTE} il est simplement posé à côté)`
    )
  }
  const ok =
    (overlap.verdict === 'passage' || overlap.verdict === 'non_applicable') &&
    (debordement === 'contenant_reel' || debordement === 'non_applicable')
  return { ok, overlap, debordement, raisons }
}

/**
 * Le format NATIF de détection d'objets de Gemini : box_2d = [ymin, xmin,
 * ymax, xmax] en ENTIERS 0-1000. C'est le format sur lequel le modèle est
 * entraîné — E1 (run 6) a prouvé qu'en lui demandant [x, y, w, h] en 0..1 il
 * mélange les échelles À L'INTÉRIEUR D'UN MÊME TABLEAU (relevé :
 * [0.199, 339, 0.365, 0.507]), ce qui corrompait 5 mesures sur 13.
 *
 * Validation STRICTE, aucune heuristique de rattrapage : une boîte hors
 * contrat renvoie null et l'appelant rejoue la mesure. Mieux vaut un appel de
 * plus qu'un chiffre inventé — c'est la leçon des trois checkpoints rejetés.
 */
export function parseBox2d(raw: unknown): Bbox | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null
  const nums = raw.map((v) => Number(v))
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 1000)) return null
  const [ymin, xmin, ymax, xmax] = nums as [number, number, number, number]
  if (xmax <= xmin || ymax <= ymin) return null
  const bbox: Bbox = [xmin / 1000, ymin / 1000, (xmax - xmin) / 1000, (ymax - ymin) / 1000]
  // une boîte plus fine que 2 % du côté est une erreur de lecture, pas un objet
  if (bbox[2] < 0.02 || bbox[3] < 0.02) return null
  return bbox
}

/** Ancienne normalisation heuristique (0..1 / 0..1000 / pixels) — conservée
 *  pour les entrées héritées. Ne PAS l'utiliser pour lire une réponse de
 *  modèle : voir parseBox2d et le relevé E1 ci-dessus. */
export function normaliseBbox(raw: unknown, cotePx = 1024): Bbox | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null
  const nums = raw.map((v) => Number(v))
  if (nums.some((n) => !Number.isFinite(n))) return null
  const max = Math.max(...nums.map(Math.abs))
  const echelle = max <= 1.5 ? 1 : max <= 1000 ? 1000 : cotePx
  const [x, y, w, h] = nums.map((n) => n / echelle) as [number, number, number, number]
  if (w <= 0 || h <= 0) return null
  return [
    Math.max(0, Math.min(1, x)),
    Math.max(0, Math.min(1, y)),
    Math.max(0, Math.min(1, w)),
    Math.max(0, Math.min(1, h)),
  ]
}
