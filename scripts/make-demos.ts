/*
 * LOT 6 — Les 6 démos 4K : la preuve de niveau.
 * Reproduit les archétypes des références client avec le moteur complet
 * (compilateur + génération + calques + texte réel + compositing serveur)
 * sur le projet de test « Les Santos Nights ».
 *
 * Pour les archétypes « titre géant traversé par le sujet » (MAINTENANCE,
 * REDÉMARRAGE) : scène de fond → titre → SUJET rendu séparément sur fond
 * plat, détouré localement, posé PAR-DESSUS le titre — le vrai workflow.
 *
 * Usage : bun run scripts/make-demos.ts [--only=<id>]
 * Sortie : ../rapports/demos/*.png (4K) + demos-report.json (prompts + coûts)
 */

import { mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import sharp from 'sharp'
import { compileScenePrompt, softenPrompt, type EngineCategory } from '../src/lib/engine/compiler'
import { geminiImageEditRich, GeminiError } from '../src/lib/ai/gemini'
import { cutoutFlatBackground } from '../src/lib/engine/cutout'
import { composeAsset } from '../src/lib/engine/composite'
import { estimateCostEur } from '../src/lib/engine/pricing'
import type { Layer } from '../src/lib/engine/layers'

const OUT_DIR = resolve(import.meta.dir, '../../rapports/demos')
const SCENE_MODEL = 'gemini-3-pro-image'
const SUBJECT_MODEL = 'gemini-3-pro-image'

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

// Logo master du projet de test (généré au LOT 3, servi par le backend local)
const LOGO = {
  url: 'http://localhost:4000/files/neva-projects/00000000-0000-4000-8000-000000000001/30abe9c7-847e-4e3c-9b75-67856e59dbec/logo/master.png',
  whiteUrl: 'http://localhost:4000/files/neva-projects/00000000-0000-4000-8000-000000000001/30abe9c7-847e-4e3c-9b75-67856e59dbec/logo/master-blanc.png',
  blackUrl: 'http://localhost:4000/files/neva-projects/00000000-0000-4000-8000-000000000001/30abe9c7-847e-4e3c-9b75-67856e59dbec/logo/master-noir.png',
}

const usage = { calls: 0, tokensIn: 0, tokensOut: 0, images: 0, retries: 0 }

async function generate(prompt: string, aspectRatio: string, imageSize: '1K' | '2K' | '4K', model = SCENE_MODEL): Promise<Buffer> {
  usage.calls += 1
  try {
    const result = await geminiImageEditRich({ model, prompt, imageConfig: { aspectRatio, imageSize } })
    usage.tokensIn += result.usage.tokensIn
    usage.tokensOut += result.usage.tokensOut
    usage.images += 1
    return Buffer.from(result.dataUrl.split(',').pop() ?? '', 'base64')
  } catch (error) {
    if (error instanceof GeminiError && error.refusal) {
      usage.retries += 1
      const { softened } = softenPrompt(prompt)
      const result = await geminiImageEditRich({ model, prompt: softened, imageConfig: { aspectRatio, imageSize } })
      usage.tokensIn += result.usage.tokensIn
      usage.tokensOut += result.usage.tokensOut
      usage.images += 1
      return Buffer.from(result.dataUrl.split(',').pop() ?? '', 'base64')
    }
    throw error
  }
}

let layerCounter = 0
function layer(partial: Partial<Layer> & Pick<Layer, 'type' | 'name'>): Layer {
  layerCounter += 1
  return {
    id: `demo-${layerCounter}`,
    x: 0.5,
    y: 0.5,
    scale: 1,
    rotation: 0,
    opacity: 1,
    blend: 'normal',
    ...partial,
  } as Layer
}

function dataUrlOf(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString('base64')}`
}

// Rend un sujet isolé sur fond plat, détouré localement → calque PNG alpha.
async function subjectCutout(description: string, background: '#FFFFFF' | '#000000' = '#00FF00'.startsWith('#0') ? '#FFFFFF' : '#FFFFFF'): Promise<{ dataUrl: string; aspect: number }> {
  const prompt = [
    'Premium GTA V / FiveM character render for poster compositing.',
    description,
    'The subject is COMPLETELY ALONE on the background: no props, no scenery, no furniture, no panels, no signs, nothing else in the frame — only the character.',
    'Rockstar-grade game-cinematic realism, detailed face, sharp full-body render.',
    `CRITICAL FOR CUTOUT: perfectly flat, uniform, seamless pure white (#FFFFFF) background. No shadow on the background, no reflection, no gradient. Subject must not touch the frame edges — keep 8% padding.`,
    'ZERO TEXT ANYWHERE: no letters on clothing, patches, badges or caps — patches and badges must be blank or purely symbolic. No watermark, no UI. No extra people. No distorted anatomy, no extra fingers.',
  ].join('\n')
  const buffer = await generate(prompt, '3:4', '2K', SUBJECT_MODEL)
  const cut = await cutoutFlatBackground(buffer)
  return { dataUrl: dataUrlOf(cut.png), aspect: cut.width / cut.height }
}

type Demo = {
  id: string
  category: EngineCategory
  width: number
  height: number
  aspectRatio: string
  answers: Parameters<typeof compileScenePrompt>[0]['answers']
  extraScene?: string
  subject?: string
  layers: (sceneUrl: string, sceneAspect: number, subject?: { dataUrl: string; aspect: number }) => Layer[]
}

const RED = '#E63946'
const GOLD = '#D4A017'
const FLUO = '#DFFF00'

const DEMOS: Demo[] = [
  {
    id: '1-maintenance',
    category: 'banniere_discord',
    width: 3840,
    height: 2160,
    aspectRatio: '16:9',
    answers: {
      lieu: 'empty rain-slick industrial garage at night, roller door half open, a matte black sports car parked at an angle on the right third',
      moment: 'dark red practical lighting, deep shadows, thin cold rim light',
      props: 'work lights on stands, sparse floating dust',
      ambianceScene: 'dark maintenance mood, red and near-black grading, cinematic',
    },
    extraScene: 'Keep the CENTER of the frame free of any object — a giant title will span the full width. Nobody in the scene.',
    subject: 'A lone mechanic in a dark red work jacket and black cap, standing, arms crossed, confident posture, facing camera slightly off-axis, dramatic red-tinted key light from the left, near-black background shadows on clothing folds.',
    layers: (sceneUrl, sceneAspect, subject) => [
      layer({ type: 'scene', name: 'Scène', url: sceneUrl, aspect: sceneAspect }),
      layer({ type: 'text', name: 'Titre', text: 'MAINTENANCE', font: 'anton', weight: 400, sizeRel: 0.30, x: 0.5, y: 0.47, color: RED, letterSpacing: 0.015, shadow: { x: 0, y: 10, blur: 40, color: 'rgba(0,0,0,0.75)' }, uppercase: true }),
      layer({ type: 'scene', name: 'Sujet', url: subject!.dataUrl, aspect: subject!.aspect, scale: 0.215, x: 0.5, y: 0.60 }),
      layer({ type: 'text', name: 'Sous-titre', text: 'RETOUR EN LIGNE — 19H00', font: 'oswald', weight: 500, sizeRel: 0.034, x: 0.5, y: 0.855, color: '#F5F0E8', letterSpacing: 0.42, shadow: { x: 0, y: 3, blur: 14, color: 'rgba(0,0,0,0.7)' }, uppercase: true }),
      layer({ type: 'logo', name: 'Logo', variant: 'color', url: LOGO.url, aspect: 3399 / 1968, scale: 0.085, x: 0.93, y: 0.09 }),
      layer({ type: 'effect', name: 'Vignette', effectId: 'vignette', opacity: 0.8 }),
      layer({ type: 'grain', name: 'Grain', effectId: 'grain-fin', blend: 'overlay', opacity: 0.3 }),
    ],
  },
  {
    id: '2-soins',
    category: 'affiche',
    width: 3072,
    height: 4096,
    aspectRatio: '3:4',
    answers: {
      lieu: 'moody hospital corridor at night in Los Santos, teal-tinted fluorescent lights, one ambulance visible through glass doors far behind',
      moment: 'cold teal practicals with one warm accent light',
      props: 'medical gurney on the side, IV stand silhouette',
      ambianceScene: 'clinical but cinematic, dark teal and red cross accents',
    },
    extraScene: 'Keep the middle band of the frame clean for a giant title. Nobody in the scene.',
    subject: 'A paramedic in dark EMS uniform with red accents, stethoscope around neck, standing confident, arms at sides, teal rim light on one side and warm key light on the face, hospital-dark backdrop.',
    layers: (sceneUrl, sceneAspect, subject) => [
      layer({ type: 'scene', name: 'Scène', url: sceneUrl, aspect: sceneAspect }),
      layer({ type: 'text', name: 'Titre', text: 'SOINS', font: 'anton', weight: 400, sizeRel: 0.175, x: 0.5, y: 0.34, color: '#EAF6F4', letterSpacing: 0.06, shadow: { x: 0, y: 8, blur: 34, color: 'rgba(0,0,0,0.7)' }, uppercase: true }),
      layer({ type: 'scene', name: 'Sujet', url: subject!.dataUrl, aspect: subject!.aspect, scale: 0.42, x: 0.5, y: 0.62 }),
      layer({ type: 'text', name: 'Sous-titre', text: 'HÔPITAL CENTRAL — RECRUTEMENT MÉDECINS', font: 'oswald', weight: 500, sizeRel: 0.017, x: 0.5, y: 0.9, color: '#DDEBE8', letterSpacing: 0.34, shadow: { x: 0, y: 3, blur: 12, color: 'rgba(0,0,0,0.7)' }, uppercase: true }),
      layer({ type: 'logo', name: 'Logo', variant: 'white', url: LOGO.whiteUrl, aspect: 3399 / 1968, scale: 0.11, x: 0.5, y: 0.953, opacity: 0.9 }),
      layer({ type: 'effect', name: 'Vignette', effectId: 'vignette', opacity: 0.75 }),
      layer({ type: 'grain', name: 'Grain', effectId: 'grain-fin', blend: 'overlay', opacity: 0.28 }),
    ],
  },
  {
    id: '3-reglement',
    category: 'affiche',
    width: 3072,
    height: 4096,
    aspectRatio: '3:4',
    answers: {
      lieu: 'dark wooden desk seen from a low three-quarter angle, leather inlay',
      personnages: 'nobody, still life only',
      moment: 'warm tungsten desk lamp from the upper left, deep shadows',
      props: 'neat stacks of dollar bills, a vintage revolver-shaped lighter, cigar in ashtray, old rotary phone, whisky glass, handcuffs',
      ambianceScene: 'noir crime still life, warm gold and deep brown grading, luxurious and dangerous',
    },
    extraScene: 'Objects arranged in the LOWER two thirds; upper third stays dark and clean for the title. Shallow depth of field.',
    layers: (sceneUrl, sceneAspect) => [
      layer({ type: 'scene', name: 'Scène', url: sceneUrl, aspect: sceneAspect }),
      layer({ type: 'text', name: 'Titre', text: 'RÈGLEMENT', font: 'anton', weight: 400, sizeRel: 0.088, x: 0.5, y: 0.155, gradient: { from: GOLD, to: '#8A6A0F', angle: 180 }, letterSpacing: 0.04, shadow: { x: 0, y: 7, blur: 30, color: 'rgba(0,0,0,0.8)' }, uppercase: true }),
      layer({ type: 'text', name: 'Sous-titre', text: 'LES RÈGLES DU JEU — À LIRE AVANT D’ENTRER', font: 'oswald', weight: 500, sizeRel: 0.016, x: 0.5, y: 0.225, color: '#E8D9B0', letterSpacing: 0.3, shadow: { x: 0, y: 3, blur: 12, color: 'rgba(0,0,0,0.7)' }, uppercase: true }),
      layer({ type: 'logo', name: 'Logo', variant: 'white', url: LOGO.whiteUrl, aspect: 3399 / 1968, scale: 0.13, x: 0.5, y: 0.93, opacity: 0.85 }),
      layer({ type: 'effect', name: 'Vignette', effectId: 'vignette', opacity: 0.85 }),
      layer({ type: 'grain', name: 'Grain', effectId: 'grain-fort', blend: 'overlay', opacity: 0.3 }),
    ],
  },
  {
    id: '4-wallpaper-ete',
    category: 'wallpaper',
    width: 3840,
    height: 2160,
    aspectRatio: '16:9',
    answers: {
      lieu: 'sun-drenched peach-pink gradient sky over Vespucci beach seen from above',
      personnages: 'nobody',
      moment: 'bright saturated summer daylight',
      props: 'floating objects casting soft shadows: inflatable flamingo, vintage sunglasses, cocktail with straw, jetski, beach ball, palm leaf, boombox — arranged like a knolling composition in the air',
      ambianceScene: 'playful premium summer event, peach and turquoise palette, crisp product-render feel',
    },
    extraScene: 'Objects float spaced apart on the peach background with clean negative space between them. Soft drop shadows. Center-left area stays clear.',
    layers: (sceneUrl, sceneAspect) => [
      layer({ type: 'scene', name: 'Scène', url: sceneUrl, aspect: sceneAspect }),
      layer({ type: 'text', name: 'Titre', text: 'ÉTÉ 2026', font: 'archivo-black', weight: 900, sizeRel: 0.115, x: 0.315, y: 0.485, color: '#FFFFFF', letterSpacing: 0.03, shadow: { x: 0, y: 8, blur: 26, color: 'rgba(214,116,86,0.55)' }, uppercase: true }),
      layer({ type: 'text', name: 'Sous-titre', text: 'ÉVÉNEMENT SAISONNIER — PLAGE DE VESPUCCI', font: 'montserrat', weight: 600, sizeRel: 0.022, x: 0.315, y: 0.578, color: '#FFFFFF', letterSpacing: 0.26, shadow: { x: 0, y: 4, blur: 18, color: 'rgba(150,70,45,0.65)' }, uppercase: true }),
      layer({ type: 'logo', name: 'Filigrane logo', variant: 'white', url: LOGO.whiteUrl, aspect: 3399 / 1968, scale: 0.42, x: 0.795, y: 0.845, opacity: 0.16 }),
      layer({ type: 'logo', name: 'Logo', variant: 'black', url: LOGO.blackUrl, aspect: 3399 / 1968, scale: 0.075, x: 0.075, y: 0.09, opacity: 0.85 }),
      layer({ type: 'grain', name: 'Grain', effectId: 'grain-fin', blend: 'overlay', opacity: 0.2 }),
    ],
  },
  {
    id: '5-redemarrage',
    category: 'banniere_f5',
    width: 3840,
    height: 2160,
    aspectRatio: '16:9',
    answers: {
      lieu: 'downtown Los Santos street at night, long avenue with depth, wet asphalt reflections',
      moment: 'night with lime-green neon spill and cold blue depth haze',
      props: 'light fog, distant traffic light glows',
      ambianceScene: 'electric restart energy, acid lime accent over dark night grading',
    },
    extraScene: 'Strong one-point perspective toward the center. Keep the central band clean for a giant title. Nobody in the scene.',
    subject: 'A young streetwear character seen from the front, dark bomber jacket with lime green accents, confident stance, hands in pockets, lit by a lime neon key light from the right and cold blue fill, city night backdrop.',
    layers: (sceneUrl, sceneAspect, subject) => [
      layer({ type: 'scene', name: 'Scène', url: sceneUrl, aspect: sceneAspect }),
      layer({ type: 'text', name: 'Titre', text: 'REDÉMARRAGE', font: 'anton', weight: 400, sizeRel: 0.27, x: 0.5, y: 0.44, gradient: { from: FLUO, to: '#8FBF00', angle: 180 }, letterSpacing: 0.012, shadow: { x: 0, y: 10, blur: 44, color: 'rgba(143,191,0,0.35)' }, uppercase: true }),
      layer({ type: 'scene', name: 'Sujet', url: subject!.dataUrl, aspect: subject!.aspect, scale: 0.21, x: 0.5, y: 0.585 }),
      layer({ type: 'text', name: 'Sous-titre', text: 'LE SERVEUR REVIENT DANS QUELQUES MINUTES', font: 'oswald', weight: 500, sizeRel: 0.03, x: 0.5, y: 0.875, color: '#EFFFD0', letterSpacing: 0.4, shadow: { x: 0, y: 3, blur: 14, color: 'rgba(0,0,0,0.75)' }, uppercase: true }),
      layer({ type: 'logo', name: 'Logo', variant: 'white', url: LOGO.whiteUrl, aspect: 3399 / 1968, scale: 0.08, x: 0.925, y: 0.09, opacity: 0.95 }),
      layer({ type: 'effect', name: 'Vignette', effectId: 'vignette', opacity: 0.7 }),
      layer({ type: 'grain', name: 'Grain', effectId: 'grain-fin', blend: 'overlay', opacity: 0.3 }),
    ],
  },
  {
    id: '6-recrutement',
    category: 'banniere_discord',
    width: 3840,
    height: 2160,
    aspectRatio: '16:9',
    answers: {
      templateId: 'car-bumper-duo-editorial',
      lieu: 'private parking under a luxury tower at night, warm garage practicals',
      moment: 'night, warm tungsten practicals, red neon accent from signage glow',
      ambianceScene: 'confident crew energy, dark luxury, red and gold accents',
    },
    layers: (sceneUrl, sceneAspect) => [
      layer({ type: 'scene', name: 'Scène', url: sceneUrl, aspect: sceneAspect }),
      layer({ type: 'text', name: 'Titre', text: 'ON RECRUTE', font: 'archivo-black', weight: 900, sizeRel: 0.15, x: 0.5, y: 0.20, color: '#F5F0E8', letterSpacing: 0.04, shadow: { x: 0, y: 8, blur: 34, color: 'rgba(0,0,0,0.8)' }, uppercase: true }),
      layer({ type: 'text', name: 'Sous-titre', text: 'STAFF  ·  MÉDECINS  ·  MÉCANOS  ·  ILLÉGAL', font: 'oswald', weight: 500, sizeRel: 0.032, x: 0.5, y: 0.29, color: GOLD, letterSpacing: 0.3, shadow: { x: 0, y: 3, blur: 14, color: 'rgba(0,0,0,0.7)' }, uppercase: true }),
      layer({ type: 'text', name: 'CTA', text: 'CANDIDATURES OUVERTES — DISCORD.GG/LSN', font: 'bebas-neue', weight: 400, sizeRel: 0.045, x: 0.5, y: 0.905, color: '#FFFFFF', letterSpacing: 0.14, shadow: { x: 0, y: 4, blur: 16, color: 'rgba(0,0,0,0.8)' }, uppercase: true }),
      layer({ type: 'logo', name: 'Logo', variant: 'color', url: LOGO.url, aspect: 3399 / 1968, scale: 0.09, x: 0.925, y: 0.09 }),
      layer({ type: 'effect', name: 'Vignette', effectId: 'vignette', opacity: 0.72 }),
      layer({ type: 'grain', name: 'Grain', effectId: 'grain-fin', blend: 'overlay', opacity: 0.28 }),
    ],
  },
]

const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7)

async function run() {
  mkdirSync(OUT_DIR, { recursive: true })
  const report: Record<string, unknown>[] = []

  for (const demo of DEMOS) {
    if (only && demo.id !== only) continue
    console.log(`\n── Démo ${demo.id}`)
    const before = { ...usage }

    const compiled = compileScenePrompt({ project: PROJECT, category: demo.category, answers: demo.answers })
    const scenePrompt = demo.extraScene ? `${compiled.prompt}\n\nCOMPOSITION NOTE: ${demo.extraScene}` : compiled.prompt

    console.log('  scène 4K…')
    const sceneBuffer = await generate(scenePrompt, demo.aspectRatio, '4K')
    // scène brute conservée : recomposition future gratuite (texte/layout)
    writeFileSync(join(OUT_DIR, `${demo.id}-scene.png`), sceneBuffer)
    const sceneMeta = await sharp(sceneBuffer).metadata()
    const sceneAspect = (sceneMeta.width ?? demo.width) / (sceneMeta.height ?? demo.height)

    let subject: { dataUrl: string; aspect: number } | undefined
    if (demo.subject) {
      console.log('  sujet détouré…')
      subject = await subjectCutout(demo.subject)
    }

    console.log('  compositing…')
    const png = await composeAsset({
      layers: demo.layers(dataUrlOf(sceneBuffer), sceneAspect, subject),
      logoMaster: LOGO,
      width: demo.width,
      height: demo.height,
    })
    writeFileSync(join(OUT_DIR, `${demo.id}.png`), png)

    const delta = {
      appels: usage.calls - before.calls,
      tokens: usage.tokensIn + usage.tokensOut - before.tokensIn - before.tokensOut,
      images: usage.images - before.images,
    }
    const cost = estimateCostEur({
      model: SCENE_MODEL,
      tokensIn: usage.tokensIn - before.tokensIn,
      tokensOut: usage.tokensOut - before.tokensOut,
      imagesOut: delta.images,
      resolution: '4K',
    })
    console.log(`  ✓ ${demo.id}.png (${demo.width}×${demo.height}, ${Math.round(png.length / 1024 / 1024 * 10) / 10} Mo) — ${delta.appels} appels, ${cost.toFixed(3)} €`)
    report.push({
      demo: demo.id,
      format: `${demo.width}×${demo.height}`,
      appels_api: delta.appels,
      images_generees: delta.images,
      cout_eur: cost,
      prompt_compile: scenePrompt,
      sujet_detoure: demo.subject ?? null,
    })
  }

  const totalCost = report.reduce((sum, r) => sum + (r.cout_eur as number), 0)
  writeFileSync(
    join(OUT_DIR, 'demos-report.json'),
    JSON.stringify({ genere_le: new Date().toISOString(), modele: SCENE_MODEL, refus_reformules: usage.retries, cout_total_eur: Math.round(totalCost * 1000) / 1000, demos: report }, null, 2)
  )
  console.log(`\nTOTAL : ${totalCost.toFixed(3)} € — refus reformulés : ${usage.retries}`)
}

await run()
