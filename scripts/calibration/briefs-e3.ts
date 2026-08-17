/*
 * Run 6 — LES 5 BRIEFS D'E3.
 *
 * E3 ne teste plus 3 concepts sur un seul brief : elle teste UN concept sur
 * CINQ briefs choisis pour casser sur cinq points distincts. Fruitz et Azure
 * Bay (scripts/calibration/briefs.ts) sont les deux briefs de la DoD depuis le
 * 5.5 — ils ont été joués des dizaines de fois, le moteur les connaît par
 * cœur, et c'est exactement pour ça qu'ils ne prouvent plus rien de neuf.
 *
 * Chaque brief ci-dessous porte UNE contrainte que le pipeline n'a jamais
 * rencontrée :
 *
 *   1. blackwood  sujet concret + thème sombre   — le corpus est à 78 % sombre
 *                                                  mais les briefs joués sont
 *                                                  tous « été / plage »
 *   2. azure      AUCUN sujet donné              — le DA doit INVENTER
 *                                                  l'emblème. C'est le cas le
 *                                                  plus fréquent chez un vrai
 *                                                  client et il n'a jamais été
 *                                                  testé une seule fois
 *   3. nox        nom de 3 lettres               — territoire du monogramme :
 *                                                  y a-t-il assez de matière
 *                                                  pour une construction ?
 *   4. northside  nom de 12 caractères, 2 mots   — stress de crénage et de
 *                                                  lisibilité, le point où
 *                                                  l'orthographe casse
 *   5. vulcain    emblème seul, ZÉRO lettrage    — le mode sans mot, jamais
 *                                                  exercé sur le chemin v6
 *
 * Les hex viennent d'un wizard plausible, pas d'un test : ils ne partent PAS
 * dans le prompt (interdits par le validateur v6) et servent au contrôle de
 * palette en post-rendu (§6).
 */

import type { ProjectLike } from '../../src/lib/engine/compiler'
import { parseLogoAnswersV3, type LogoAnswersV3 } from '../../src/lib/engine/logo-brief'

export type BriefE3 = {
  id: string
  /** ce que ce brief CASSE — repris tel quel dans le rapport et la planche */
  stress: string
  project: ProjectLike
  answers: LogoAnswersV3
}

function brief(
  id: string,
  stress: string,
  project: ProjectLike,
  answers: Record<string, unknown>
): BriefE3 {
  const parsed = parseLogoAnswersV3(answers)
  if (!parsed) throw new Error(`brief ${id} : réponses wizard invalides`)
  return { id, stress, project, answers: parsed }
}

export const BLACKWOOD = brief(
  'blackwood',
  'sujet concret + thème sombre (anthracite/or) — le corpus est sombre, les briefs joués ne l\'étaient jamais',
  {
    name: 'Blackwood',
    sector: 'fivem',
    ambiance: { styleAnswers: { universe: 'sombre_hardcore', energie: 55, modernite: 50, couleur: '#D4AF37' } },
    palette: [],
  },
  {
    type: 'nom',
    sujet: 'loup, forêt',
    ambiance: 'sombre',
    matiere: 'or',
    couleurs: { mode: 'degrade', couleurs: ['#2B2F33', '#D4AF37'], angle: 135 },
  }
)

export const AZURE_ABSTRAIT = brief(
  'azure',
  'nom abstrait, AUCUN sujet donné — le DA doit inventer l\'emblème (cas client le plus fréquent, jamais testé)',
  {
    name: 'Azure',
    sector: 'fivem',
    ambiance: { styleAnswers: { universe: 'rp_urbain', energie: 45, modernite: 75, couleur: '#1E5FA8' } },
    palette: [],
  },
  {
    type: 'nom',
    // vide EXPRÈS : « le client ne sait pas ce qu'il veut dessiner »
    sujet: '',
    ambiance: 'urbain',
    matiere: 'chrome',
    couleurs: { mode: 'degrade', couleurs: ['#1E5FA8', '#5FC8F5'], angle: 90 },
  }
)

export const NOX = brief(
  'nox',
  'nom de 3 lettres — territoire du monogramme, assez de matière pour une construction ?',
  {
    name: 'Nox',
    sector: 'fivem',
    ambiance: { styleAnswers: { universe: 'sombre_hardcore', energie: 70, modernite: 65, couleur: '#E63946' } },
    palette: [],
  },
  {
    type: 'nom',
    sujet: 'nuit, éclipse',
    ambiance: 'esport',
    matiere: 'chrome',
    couleurs: { mode: 'unie', couleur: '#E63946' },
  }
)

export const NORTHSIDE = brief(
  'northside',
  'nom de 12 caractères en 2 mots — stress de crénage, de lisibilité et d\'orthographe',
  {
    name: 'Northside RP',
    sector: 'fivem',
    ambiance: { styleAnswers: { universe: 'rp_urbain', energie: 60, modernite: 55, couleur: '#F2A649' } },
    palette: [],
  },
  {
    type: 'nom',
    sujet: 'pont, skyline',
    ambiance: 'urbain',
    matiere: 'chrome',
    couleurs: { mode: 'degrade', couleurs: ['#F2A649', '#2B3A55'], angle: 45 },
  }
)

export const VULCAIN = brief(
  'vulcain',
  'emblème seul, ZÉRO lettrage — mode sans mot, jamais exercé sur le chemin v6',
  {
    name: 'Vulcain',
    sector: 'fivem',
    ambiance: { styleAnswers: { universe: 'luxe', energie: 65, modernite: 45, couleur: '#C9A227' } },
    palette: [],
  },
  {
    type: 'embleme',
    sujet: 'ailes, forge',
    ambiance: 'sombre',
    matiere: 'or',
    couleurs: { mode: 'degrade', couleurs: ['#C9A227', '#8C2F1D'], angle: 120 },
  }
)

/** L'ordre EST celui du rapport et de la planche. */
export const BRIEFS_E3: BriefE3[] = [BLACKWOOD, AZURE_ABSTRAIT, NOX, NORTHSIDE, VULCAIN]

export function briefE3(id: string): BriefE3 {
  const trouve = BRIEFS_E3.find((b) => b.id === id)
  if (!trouve) throw new Error(`brief E3 inconnu : ${id} (disponibles : ${BRIEFS_E3.map((b) => b.id).join(', ')})`)
  return trouve
}

/** Le mot RÉELLEMENT attendu dans l'image — null pour un brief sans lettrage. */
export function motAttendu(b: BriefE3): string | null {
  if (b.answers.type === 'embleme') return null
  if (b.answers.type === 'lettre') return (b.project.name.trim()[0] ?? 'N').toUpperCase()
  return b.project.name.trim().toUpperCase()
}
