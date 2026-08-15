/*
 * Vignettes des templates de scène (run 5, LOT 4) — one-shot.
 * Rend chaque template avec ses defaults (sans référence personnage) en
 * 16:9 1K via flash-image, réduit en 640 px webp, écrit dans
 * nevadesign-frontend/public/wizard/scene-<id>.webp. Payé une fois.
 *
 * Usage : bun run scripts/generate-template-thumbs.ts [--only=<id>]
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import sharp from 'sharp'
import { compileScenePrompt, listSceneTemplates } from '../src/lib/engine/compiler'
import { geminiImageEditRich } from '../src/lib/ai/gemini'
import { estimateCostEur } from '../src/lib/engine/pricing'

const OUT_DIR = resolve(import.meta.dir, '../../nevadesign-frontend/public/wizard')
const MODEL = 'gemini-3.1-flash-image'

const DEMO_PROJECT = {
  name: 'Nova',
  sector: 'fivem',
  ambiance: { universe: 'premium Los Santos roleplay server', chips: [], references: [] },
  palette: [],
}

const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7)

async function run() {
  mkdirSync(OUT_DIR, { recursive: true })
  let tokensIn = 0
  let tokensOut = 0
  let images = 0

  for (const template of listSceneTemplates()) {
    if (only && template.id !== only) continue
    const file = join(OUT_DIR, `scene-${template.id}.webp`)
    if (!only && existsSync(file)) {
      console.log(`· ${template.id} déjà présent, sauté`)
      continue
    }

    const compiled = compileScenePrompt({
      project: DEMO_PROJECT,
      category: 'banniere_discord',
      answers: { templateId: template.id },
    })

    try {
      const result = await geminiImageEditRich({
        model: MODEL,
        prompt: compiled.prompt,
        imageConfig: { aspectRatio: '16:9', imageSize: '1K' },
      })
      tokensIn += result.usage.tokensIn
      tokensOut += result.usage.tokensOut
      images += 1
      const buffer = Buffer.from(result.dataUrl.split(',').pop() ?? '', 'base64')
      const webp = await sharp(buffer).resize(640, 360).webp({ quality: 84 }).toBuffer()
      writeFileSync(file, webp)
      console.log(`✓ ${template.id} (${Math.round(webp.length / 1024)} Ko)`)
    } catch (error) {
      console.log(`✗ ${template.id} : ${(error as Error).message.slice(0, 90)}`)
    }
  }

  const cost = estimateCostEur({ model: MODEL, tokensIn, tokensOut, imagesOut: images, resolution: '1K' })
  console.log(`COÛT one-shot vignettes scènes : ${cost.toFixed(4)} € (${images} images)`)
}

await run()
