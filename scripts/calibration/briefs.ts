/*
 * Run 5.5 — les DEUX briefs de test de la definition of done.
 * Identiques aux cas de la page /admin/test-moteur (mêmes hex, mêmes mots)
 * pour que le verdict humain du client se fasse sur le même terrain.
 */

import type { ProjectLike } from '../../src/lib/engine/compiler'
import { parseLogoAnswersV3, type LogoAnswersV3 } from '../../src/lib/engine/logo-brief'

export type CalibrationBrief = {
  id: 'fruitz' | 'azure'
  project: ProjectLike
  answers: LogoAnswersV3
}

export const FRUITZ: CalibrationBrief = {
  id: 'fruitz',
  project: {
    name: 'Fruitz',
    sector: 'fivem',
    ambiance: { styleAnswers: { universe: 'ete_plage', energie: 45, modernite: 75, couleur: '#FF6B4A' } },
    palette: [],
  },
  answers: parseLogoAnswersV3({
    type: 'nom',
    sujet: 'fruit, été, juteux',
    ambiance: 'ete',
    couleurs: { mode: 'degrade', couleurs: ['#FF6B4A', '#FFC4A3'], angle: 45 },
  })!,
}

export const AZURE: CalibrationBrief = {
  id: 'azure',
  project: {
    name: 'Azure Bay',
    sector: 'fivem',
    ambiance: { styleAnswers: { universe: 'ete_plage', energie: 25, modernite: 70, couleur: '#118AB2' } },
    palette: [],
  },
  answers: parseLogoAnswersV3({
    type: 'nom',
    sujet: 'dauphin, océan',
    ambiance: 'ete',
    couleurs: { mode: 'degrade', couleurs: ['#118AB2', '#06D6A0'], angle: 90 },
  })!,
}

export const BRIEFS: Record<string, CalibrationBrief> = { fruitz: FRUITZ, azure: AZURE }
