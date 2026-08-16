/*
 * Preuve run 5.2 : prompts compilés v2 d'exemple, écrits dans
 * ../rapports/run5.2-prompts-compiles.md. Zéro appel API — compilation pure.
 *
 * Montre le few-shot en action : reverse-prompts gabarits + nombre de
 * références jointes + épellation forcée du titre DANS l'image (plus aucun
 * negative « no text » sur les chemins héro/logo).
 *
 * Usage : bun run scripts/compile-examples.ts
 */

import { writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import {
  compileHeroPromptV2,
  getSceneTemplate,
} from '../src/lib/engine/compiler'
import { resolveArtDirection } from '../src/lib/engine/mapping'

const OUT = resolve(import.meta.dir, '../../rapports/run5.2-prompts-compiles.md')

// Deux projets de démonstration aux directions opposées — la preuve du
// mapping (LOT 2) : mêmes questions, réponses différentes, DA distinctes.
const CARTEL_PROJECT = {
  name: 'REDSIDE',
  sector: 'fivem',
  ambiance: { styleAnswers: { universe: 'cartel', energie: 85, modernite: 60, couleur: '#E63946' } },
  palette: [],
}
const ETE_PROJECT = {
  name: 'Vespucci Life',
  sector: 'fivem',
  ambiance: { styleAnswers: { universe: 'ete_plage', energie: 25, modernite: 70, couleur: '#118AB2' } },
  palette: [],
}

const daCartel = resolveArtDirection(
  { universe: 'cartel', energie: 85, modernite: 60, couleur: '#E63946' },
  CARTEL_PROJECT.name
)
const daEte = resolveArtDirection(
  { universe: 'ete_plage', energie: 25, modernite: 70, couleur: '#118AB2' },
  ETE_PROJECT.name
)

const sections: string[] = [
  '# RUN 5.2 — prompts compilés v2 d’exemple',
  '',
  'Compilation pure (zéro appel API). Chaque prompt embarque : reverse-prompts gabarits du cluster (few-shot), 3-5 règles du guide v2, la DA issue du mapping, l’épellation forcée du lettrage, et le nombre de références d’entraînement jointes à l’appel.',
  '',
]

function pushCase(title: string, prompt: string, references: number, exemplars: string[]) {
  sections.push(
    `## ${title}`,
    '',
    `Références d’entraînement jointes : **${references}** — exemplaires utilisés : ${exemplars.length ? exemplars.join(', ') : '(entraînement v2 pas encore lancé)'}`,
    '',
    '```',
    prompt,
    '```',
    ''
  )
}

// 1. (run 5.7) Les exemples logo monolithiques sont supprimés avec
// compileLogoPromptV2 — le pipeline logo passe par les calques superposés
// (logo-stack.ts), dont les prompts se prévisualisent via /admin/test-moteur.

// 2. Bannière Discord REDSIDE — titre GÉNÉRÉ dans l'image
const hero = compileHeroPromptV2({
  project: CARTEL_PROJECT,
  category: 'banniere_discord',
  da: daCartel,
  answers: {
    lieu: 'rain-slick downtown intersection at night',
    personnages: 'two rival crew figures facing away from each other',
    baseline: 'ROLEPLAY',
  },
  energie: 85,
  modernite: 60,
})
pushCase('2. Bannière Discord « REDSIDE » — titre + baseline dans l’image (depth interleaving)', hero.prompt, hero.references.length, hero.exemplarSlugs)

// 3. Même catégorie, mapping opposé : Été + Élégant + Teal
const heroEte = compileHeroPromptV2({
  project: ETE_PROJECT,
  category: 'banniere_discord',
  da: daEte,
  answers: { templateId: getSceneTemplate('fivem-beach-cabana-wideangle')?.id },
  energie: 25,
  modernite: 70,
})
pushCase('3. Bannière Discord « Vespucci Life » — mapping Été + Élégant + Teal (contraste du mapping)', heroEte.prompt, heroEte.references.length, heroEte.exemplarSlugs)

// 4. (run 5.7) Le cas orthographe piège logo (L6RYS) n'a plus d'objet : le
// lettrage est typographié côté serveur — l'orthographe est parfaite par
// construction, plus aucune génération de lettrage par le modèle image.

// 5. Bandeau FiveM 17:1 — titre dans la bande centrale
const strip = compileHeroPromptV2({
  project: CARTEL_PROJECT,
  category: 'banniere_fivem',
  da: daCartel,
  answers: { lieu: 'Los Santos skyline at dusk from the hills' },
  energie: 85,
  modernite: 60,
})
pushCase('5. Bandeau liste FiveM (3730×216) — titre confiné à la bande centrale', strip.prompt, strip.references.length, strip.exemplarSlugs)

mkdirSync(resolve(import.meta.dir, '../../rapports'), { recursive: true })
writeFileSync(OUT, sections.join('\n'))
console.log(`Prompts compilés v2 → ${OUT}`)
