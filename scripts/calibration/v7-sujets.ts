/*
 * Run 7 — les DEUX sujets de la session, et le chargement des bornes.
 *
 * Exactement deux, du mandat, et choisis pour casser sur des axes opposés :
 * NOX porte du lettrage et rien d'autre, VULCAIN n'en porte aucun. Si la
 * séparation des moteurs marche sur les deux, elle ne marche pas par accident
 * de sujet.
 */

import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { V7_DIR } from './budget7'
import type { Resume } from './v7-lib'

const RACINE = resolve(import.meta.dir, '../../..')
export const DOSSIER_LOGOS = join(RACINE, 'entrainement IA fivem', 'logo serveur fivem gtarp')

export type Sujet = {
  id: string
  nom: string
  /** Le lettrage à tracer, ou null pour un emblème pur. */
  lettrage: string | null
  /** L'archétype visé, du mandat — pas une invention du DA. */
  archetype: 'monogramme' | 'emblem_only'
  cible: string
  cibleChemin: string
  /** Ce que la cible fait, en une ligne, à l'œil. Sert d'ancrage, pas de prompt. */
  cibleNote: string
}

export const SUJETS: Sujet[] = [
  {
    id: 'nox',
    nom: 'NOX',
    lettrage: 'NOX',
    archetype: 'monogramme',
    cible: 'black-world1',
    cibleChemin: join(DOSSIER_LOGOS, 'black-world1.png'),
    cibleNote:
      'one heavy flat letterform, off-white, filling the centre of the frame, with a single cyan area cut into its lower right lobe, over a very dark and very low-contrast blurred night skyline',
  },
  {
    id: 'vulcain',
    nom: 'VULCAIN',
    lettrage: null,
    archetype: 'emblem_only',
    cible: 'vulcainlogo',
    cibleChemin: join(DOSSIER_LOGOS, 'vulcainlogo.png'),
    cibleNote:
      'one single winged silhouette — a V whose two arms open into swept wings, cut as ONE closed shape with thin dark slivers of negative space between the feathers, pale ice tone, over a dark desaturated ground',
  },
]

export function sujet(id: string): Sujet {
  const s = SUJETS.find((x) => x.id === id)
  if (!s) throw new Error(`Sujet inconnu : ${id} (attendus : ${SUJETS.map((x) => x.id).join(', ')})`)
  return s
}

// ─── Les bornes de la phase 1 ────────────────────────────────────────────────

export type Bornes = {
  source: string
  n: number
  nb_elements_max: number
  nb_couleurs_max: number
  contour: string
  contour_couleur: string
  trame: string
  type: string
  /** Nombre de pièces qui ont réellement un fond (transparence < 50 %). */
  n_fond: number
  fond_type: string
  luminance_fond: Resume
  contraste_fond: Resume
  saturation_fond: Resume
  ratio_marque_cadre: Resume
  cote_marque_cadre: Resume
  taux_remplissage_boite: Resume
  n_masse: number
  part_neutre_marque: Resume
  palette_marque: {
    entrees: number
    part_neutre: number
    neutre_dominant: string
    familles_accent: Array<[number, number]>
    familles_retenues: number[]
  }
}

export type Canonique = {
  slug: string
  chemin: string
  distance: number
  resume: {
    type: string
    nb_elements: number | null
    nb_couleurs: number | null
    contour: string
    trame: string
    fond_type: string
    luminance_fond: number
    contraste_fond: number
    ratio_marque_cadre: number | null
    palette: string[]
    natif: string
  }
}

export type ReglesCorpus = {
  genere_le: string
  bornes: Bornes
  canoniques: Canonique[]
  sous_ensemble_marque: { n: number; numeriques: Record<string, Resume>; categoriels: Record<string, Record<string, number>>; palettes_top: Array<[string, number]> }
  corpus_global: { n: number; numeriques: Record<string, Resume>; categoriels: Record<string, Record<string, number>> }
  inventaire: { fichiers: number; analysables: number; releves: number; boites_invalides: number }
}

export const CHEMIN_REGLES = join(V7_DIR, 'corpus-regles.json')

export function chargeRegles(): ReglesCorpus {
  if (!existsSync(CHEMIN_REGLES)) {
    throw new Error(
      `Bornes absentes (${CHEMIN_REGLES}). La phase 1 n'a pas tourné — aucune phase suivante ne doit dépenser sans bornes mesurées.`
    )
  }
  return JSON.parse(readFileSync(CHEMIN_REGLES, 'utf-8')) as ReglesCorpus
}

/** L'étiquette d'un exemplaire canonique, construite depuis ses MESURES. */
export function etiquetteCanonique(c: Canonique, i: number): string {
  const r = c.resume
  return (
    `CANONICAL ${i + 1} — "${c.slug}": measured as ${r.type}, ${r.nb_elements} separated shape(s), ` +
    `${r.nb_couleurs} mark colour(s), outline ${r.contour}, texture ${r.trame}, background ${r.fond_type} ` +
    `at luminance ${r.luminance_fond} and contrast ${r.contraste_fond}, mark filling ${r.ratio_marque_cadre} of the frame:`
  )
}

/** Le bloc de bornes, en anglais, tel qu'il est envoyé aux modèles. */
export function blocBornes(b: Bornes): string {
  return [
    `MEASURED BOUNDS — taken from ${b.n} mark-bearing pieces of the real corpus. These are hard limits, enforced in code, not preferences:`,
    `  separated shapes composing the mark: AT MOST ${b.nb_elements_max} (median of the corpus)`,
    `  distinct mark colours, outline excluded: AT MOST ${b.nb_couleurs_max}`,
    `  outline: ${b.contour}${b.contour !== 'none' ? ` in ${b.contour_couleur}` : ''}`,
    `  texture over the mark: ${b.trame}`,
    `  dominant mark type in the corpus: ${b.type}`,
    `  background type: ${b.fond_type}, luminance ${b.luminance_fond.mediane} (p25 ${b.luminance_fond.p25} / p75 ${b.luminance_fond.p75}) on a 0-1 scale, contrast ${b.contraste_fond.mediane}, saturation ${b.saturation_fond.mediane}`,
    `  the mark's bounding box covers ${b.ratio_marque_cadre.mediane} of the frame area, its longest side ${b.cote_marque_cadre.mediane} of the frame`,
    `  NEUTRAL DOMINANCE — ${Math.round(b.part_neutre_marque.mediane * 100)}% of the ink of a corpus mark is NEUTRAL (white, grey, near-white); the accent is an accent. A mark whose neutral share falls under ${b.part_neutre_marque.p25} is rejected in code. A saturated field with a neutral hole is the inverse of this corpus.`,
    `  MASS — the mark's own ink fills ${b.taux_remplissage_boite.mediane} of its bounding box (p25 ${b.taux_remplissage_boite.p25}). This is the structural trait the corpus shares: HEAVY, compact letterforms. A mark below ${b.taux_remplissage_boite.p25} is rejected in code — an airy shape passes every hygiene check and still does not belong here.`,
  ].join('\n')
}
