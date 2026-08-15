/*
 * Reconstruit rapports/demos/demos-report.json après les relances --only
 * (chaque relance écrase le rapport). La compilation est déterministe :
 * on recompile chaque prompt, et on agrège les coûts mesurés des runs
 * (run complet + relances de mise au point 2/4/5).
 */

import { writeFileSync } from 'fs'
import { resolve } from 'path'

// Import des définitions du script de démos (compilation uniquement)
import { compileScenePrompt, type EngineCategory } from '../src/lib/engine/compiler'

const OUT = resolve(import.meta.dir, '../../rapports/demos/demos-report.json')

const PROJECT = {
  name: 'Les Santos Nights',
  sector: 'fivem',
  ambiance: {
    universe: 'RP nocturne exigeant — néons discrets, cartel en toile de fond, luxe fatigué de Los Santos',
    chips: ['Cartel', 'Sombre', 'Néon'],
    references: [],
  },
  palette: ['#0F0F0F', '#E63946', '#D4A017', '#1A1A1A', '#F5F0E8'],
}

// Coûts mesurés (sortie des runs — 1 scène 4K = 0,248 €, + sujet 2K = 0,235 €)
const DEMOS: Array<{
  id: string
  format: string
  category: EngineCategory
  answers: Parameters<typeof compileScenePrompt>[0]['answers']
  extraScene?: string
  sujet: boolean
  cout_final_eur: number
}> = [
  { id: '1-maintenance', format: '3840×2160', category: 'banniere_discord', sujet: true, cout_final_eur: 0.483,
    answers: { lieu: 'empty rain-slick industrial garage at night, roller door half open, a matte black sports car parked at an angle on the right third', moment: 'dark red practical lighting, deep shadows, thin cold rim light', props: 'work lights on stands, sparse floating dust', ambianceScene: 'dark maintenance mood, red and near-black grading, cinematic' },
    extraScene: 'Keep the CENTER of the frame free of any object — a giant title will span the full width. Nobody in the scene.' },
  { id: '2-soins', format: '3072×4096', category: 'affiche', sujet: true, cout_final_eur: 0.483,
    answers: { lieu: 'moody hospital corridor at night in Los Santos, teal-tinted fluorescent lights, one ambulance visible through glass doors far behind', moment: 'cold teal practicals with one warm accent light', props: 'medical gurney on the side, IV stand silhouette', ambianceScene: 'clinical but cinematic, dark teal and red cross accents' },
    extraScene: 'Keep the middle band of the frame clean for a giant title. Nobody in the scene.' },
  { id: '3-reglement', format: '3072×4096', category: 'affiche', sujet: false, cout_final_eur: 0.248,
    answers: { lieu: 'dark wooden desk seen from a low three-quarter angle, leather inlay', personnages: 'nobody, still life only', moment: 'warm tungsten desk lamp from the upper left, deep shadows', props: 'neat stacks of dollar bills, a vintage revolver-shaped lighter, cigar in ashtray, old rotary phone, whisky glass, handcuffs', ambianceScene: 'noir crime still life, warm gold and deep brown grading, luxurious and dangerous' },
    extraScene: 'Objects arranged in the LOWER two thirds; upper third stays dark and clean for the title. Shallow depth of field.' },
  { id: '4-wallpaper-ete', format: '3840×2160', category: 'wallpaper', sujet: false, cout_final_eur: 0.247,
    answers: { lieu: 'sun-drenched peach-pink gradient sky over Vespucci beach seen from above', personnages: 'nobody', moment: 'bright saturated summer daylight', props: 'floating objects casting soft shadows: inflatable flamingo, vintage sunglasses, cocktail with straw, jetski, beach ball, palm leaf, boombox — arranged like a knolling composition in the air', ambianceScene: 'playful premium summer event, peach and turquoise palette, crisp product-render feel' },
    extraScene: 'Objects float spaced apart on the peach background with clean negative space between them. Soft drop shadows. Center-left area stays clear.' },
  { id: '5-redemarrage', format: '3840×2160', category: 'banniere_f5', sujet: true, cout_final_eur: 0.483,
    answers: { lieu: 'downtown Los Santos street at night, long avenue with depth, wet asphalt reflections', moment: 'night with lime-green neon spill and cold blue depth haze', props: 'light fog, distant traffic light glows', ambianceScene: 'electric restart energy, acid lime accent over dark night grading' },
    extraScene: 'Strong one-point perspective toward the center. Keep the central band clean for a giant title. Nobody in the scene.' },
  { id: '6-recrutement', format: '3840×2160', category: 'banniere_discord', sujet: false, cout_final_eur: 0.248,
    answers: { templateId: 'car-bumper-duo-editorial', lieu: 'private parking under a luxury tower at night, warm garage practicals', moment: 'night, warm tungsten practicals, red neon accent from signage glow', ambianceScene: 'confident crew energy, dark luxury, red and gold accents' } },
]

const demos = DEMOS.map((demo) => {
  const compiled = compileScenePrompt({ project: PROJECT, category: demo.category, answers: demo.answers })
  return {
    demo: demo.id,
    format: demo.format,
    sujet_detoure: demo.sujet,
    cout_eur: demo.cout_final_eur,
    prompt_compile: demo.extraScene ? `${compiled.prompt}\n\nCOMPOSITION NOTE: ${demo.extraScene}` : compiled.prompt,
  }
})

const coutFinales = demos.reduce((sum, demo) => sum + demo.cout_eur, 0)
const output = {
  genere_le: new Date().toISOString(),
  modele: 'gemini-3-pro-image (scènes 4K + sujets 2K détourés localement)',
  refus_rencontres: 0,
  cout_des_6_finales_eur: Math.round(coutFinales * 1000) / 1000,
  cout_iterations_mise_au_point_eur: 1.213,
  note: 'Itérations : relance des démos 2 (layout titre/sujet), 4 (lisibilité sous-titre, logo noir) et 5 (panneau néon avec texte dans le rendu sujet — prompt durci). Scènes brutes conservées (*-scene.png) : les recompositions suivantes sont gratuites.',
  demos,
}
writeFileSync(OUT, JSON.stringify(output, null, 2))
console.log(`rapport reconstruit — 6 finales : ${coutFinales.toFixed(3)} € + itérations 1,213 €`)
