/*
 * Preuve LOT 3 : 5 prompts compilés d'exemple, écrits dans
 * ../rapports/run5-prompts-compiles.md avec, quand un template du .txt
 * client est utilisé, l'extrait source correspondant en regard.
 *
 * Usage : bun run scripts/compile-examples.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import {
  compileLogoPrompt,
  compileScenePrompt,
  getSceneTemplate,
} from '../src/lib/engine/compiler'

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

const SOURCE_TXT = resolve(import.meta.dir, '../../entrainement IA fivem/prompt for IA desgin.txt')
const OUT = resolve(import.meta.dir, '../../rapports/run5-prompts-compiles.md')

function sourceExcerpt(index: number): string {
  const raw = readFileSync(SOURCE_TXT, 'utf-8')
  const prompts = raw.split(/^-{20,}\s*$/m).map((p) => p.trim()).filter((p) => p.length > 200)
  const source = prompts[index - 1] ?? ''
  return source.slice(0, 1400) + (source.length > 1400 ? '\n[…]' : '')
}

const sections: string[] = [
  '# RUN 5 — LOT 3 : 5 prompts compilés d’exemple',
  '',
  `Projet de démonstration : **${PROJECT.name}** — « ${PROJECT.ambiance.universe} », chips ${PROJECT.ambiance.chips.join('/')}, palette ${PROJECT.palette.join(' ')}.`,
  '',
  'Chaque prompt est assemblé automatiquement : prompt système secteur + guide de style entraîné + DA projet + réponses wizard + template de scène + règle no-text finale. L’utilisateur ne voit jamais ce texte.',
  '',
]

// 1. Logo nom complet chrome
const logo = compileLogoPrompt({
  project: PROJECT,
  answers: { type: 'nom', style: 'chrome', palette: ['#E63946', '#D4A017', '#0F0F0F'] },
})
sections.push('## 1. Logo — nom complet, style chrome', '', '```', logo.prompt, '```', '')

// 2. Bannière Discord depuis le template « transat piscine » (prompt #1 du .txt)
const template1 = getSceneTemplate('fivem-summer-lounger-perspective')
const scene1 = compileScenePrompt({
  project: PROJECT,
  category: 'banniere_discord',
  answers: {
    templateId: template1?.id,
    lieu: 'rooftop pool of a Vinewood hotel at night, city lights below',
    moment: 'night, warm practicals and subtle neon spill',
  },
})
sections.push(
  '## 2. Bannière Discord — template « Perspective forcée au bord de la piscine » (dérivé du prompt #1 du .txt)',
  '',
  '### Source client (extrait)',
  '```',
  sourceExcerpt(1),
  '```',
  '### Prompt compilé',
  '```',
  scene1.prompt,
  '```',
  ''
)

// 3. Affiche sans template (construction directe depuis le wizard)
const scene2 = compileScenePrompt({
  project: PROJECT,
  category: 'affiche',
  answers: {
    lieu: 'dimly lit private lounge, leather seats, cigar smoke',
    personnages: 'one seated figure in a tailored suit, face half in shadow',
    moment: 'low-key warm tungsten light',
    props: 'stacks of cash on the table, vintage phone',
  },
})
sections.push('## 3. Affiche — questionnaire seul (pas de template)', '', '```', scene2.prompt, '```', '')

// 4. Bandeau FiveM 17:1 (généré en 21:9, recadré au compositing)
const scene3 = compileScenePrompt({
  project: PROJECT,
  category: 'banniere_fivem',
  answers: {
    lieu: 'Los Santos skyline at dusk seen from the hills',
    moment: 'blue hour, city lights igniting',
  },
})
sections.push('## 4. Bandeau liste FiveM (3730×216 — généré en 21:9 puis recadré)', '', '```', scene3.prompt, '```', '')

// 5. Wallpaper depuis le template roadtrip (prompt #16 du .txt)
const template16 = getSceneTemplate('coastal-roadtrip-vehicle-group')
const scene4 = compileScenePrompt({
  project: PROJECT,
  category: 'wallpaper',
  answers: {
    templateId: template16?.id,
    moment: 'golden hour',
  },
})
sections.push(
  '## 5. Wallpaper — template « Roadtrip en groupe sur route côtière » (dérivé du prompt #16 du .txt)',
  '',
  '### Source client (extrait)',
  '```',
  sourceExcerpt(16),
  '```',
  '### Prompt compilé',
  '```',
  scene4.prompt,
  '```',
  ''
)

mkdirSync(resolve(import.meta.dir, '../../rapports'), { recursive: true })
writeFileSync(OUT, sections.join('\n'))
console.log(`5 prompts compilés → ${OUT}`)
console.log(`Tailles: logo ${logo.prompt.length}c, scène1 ${scene1.prompt.length}c, scène2 ${scene2.prompt.length}c, scène3 ${scene3.prompt.length}c, scène4 ${scene4.prompt.length}c`)
