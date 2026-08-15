/*
 * Vignettes des 6 styles de logo (run 5, LOT 4) — one-shot.
 * Génère une vignette par style (même lettre « N », même palette neutre)
 * via le compilateur + le guide d'entraînement logo, et les écrit dans
 * nevadesign-frontend/public/wizard/. Payé UNE fois, servi statiquement.
 *
 * Usage : bun run scripts/generate-style-thumbs.ts
 */

import { mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import sharp from 'sharp'
import { compileLogoPrompt, type LogoAnswers } from '../src/lib/engine/compiler'
import { geminiImageEditRich } from '../src/lib/ai/gemini'
import { estimateCostEur } from '../src/lib/engine/pricing'

const OUT_DIR = resolve(import.meta.dir, '../../nevadesign-frontend/public/wizard')
const MODEL = 'gemini-3.1-flash-image'

const STYLES: LogoAnswers['style'][] = ['chrome', 'graffiti', 'luxe', 'neon', 'cartoon', 'minimal']

const DEMO_PROJECT = {
  name: 'Nova',
  sector: 'fivem',
  ambiance: { universe: 'demo project for style thumbnails', chips: [], references: [] },
  palette: [],
}

async function run() {
  mkdirSync(OUT_DIR, { recursive: true })
  let tokensIn = 0
  let tokensOut = 0
  let images = 0

  for (const style of STYLES) {
    const compiled = compileLogoPrompt({
      project: DEMO_PROJECT,
      answers: { type: 'lettre', style, palette: ['#C9A227', '#1C1C1C', '#F5F0E8'] },
    })
    const result = await geminiImageEditRich({
      model: MODEL,
      prompt: compiled.prompt,
      imageConfig: { aspectRatio: '1:1', imageSize: '1K' },
    })
    tokensIn += result.usage.tokensIn
    tokensOut += result.usage.tokensOut
    images += 1

    const buffer = Buffer.from(result.dataUrl.split(',').pop() ?? '', 'base64')
    const webp = await sharp(buffer).resize(560, 560).webp({ quality: 88 }).toBuffer()
    writeFileSync(join(OUT_DIR, `logo-style-${style}.webp`), webp)
    console.log(`✓ ${style} (${Math.round(webp.length / 1024)} Ko)`)
  }

  const cost = estimateCostEur({ model: MODEL, tokensIn, tokensOut, imagesOut: images, resolution: '1K' })
  console.log(`COÛT one-shot vignettes : ${cost.toFixed(4)} € (${images} images)`)
}

await run()
