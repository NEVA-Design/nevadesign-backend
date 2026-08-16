/*
 * Run 5.9, chantier 0b — LE TEST PLAFOND : la techno est-elle en cause ?
 *
 * Trois expériences contrôlées, références recompilées HQ (1024px q92) :
 *   1. reproduction pure  — « recrée ce logo exact » sur 4 pépites gold :
 *      mesure le plafond brut du modèle sur chaque style.
 *   2. transfert minimal  — mêmes références gold, le mot FRUITZ, un prompt
 *      de 3 phrases propres sans l'appareillage du pipeline. Deux variantes :
 *      (a) ordre actuel texte→images ; (b) images d'abord, étiquetées.
 *   3. prompt pipeline    — le prompt lockup d'iter12-58 verbatim, mêmes
 *      références marque que iter12 mais en HQ.
 * Sorties : captures/calibration/_plafond-run59/ + montages réf|rendu.
 * Garde : budget4.ts, sous-plafond chantier 0 = 1,50 €.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import sharp from 'sharp'
import { geminiImageEditRich } from '../../src/lib/ai/gemini'
import { ENGINE_MODELS } from '../../src/lib/engine/generation'
import { installBudgetGuard, setActiveCap, setBudgetLabel, spentEur, CAP_CHANTIER0_EUR, CALIBRATION_DIR } from './budget4'

installBudgetGuard()
setActiveCap(CAP_CHANTIER0_EUR)

const EXEMPLARS_DIR = join(import.meta.dir, '..', '..', 'src', 'engine', 'exemplars', 'fivem', 'logo')
const OUT_DIR = join(CALIBRATION_DIR, '_plafond-run59')
mkdirSync(OUT_DIR, { recursive: true })

function ref(slug: string): { data: string; mimeType: string } {
  return { data: readFileSync(join(EXEMPLARS_DIR, `${slug}.jpg`)).toString('base64'), mimeType: 'image/jpeg' }
}

async function generate(label: string, prompt: string, refs: Array<{ data: string; mimeType: string }>, opts?: { referencesFirst?: boolean; referenceLabels?: string[] }) {
  setBudgetLabel(`plafond_${label}`)
  console.log(`→ ${label} …`)
  try {
    const res = await geminiImageEditRich({
      model: ENGINE_MODELS.logoImage,
      prompt,
      referenceImages: refs,
      imageConfig: { aspectRatio: '1:1', imageSize: '2K' },
      thinkingLevel: 'high',
      ...opts,
    })
    const png = Buffer.from(res.dataUrl.split(',').pop() ?? '', 'base64')
    writeFileSync(join(OUT_DIR, `${label}.png`), png)
    console.log(`  ✓ ${label} — cumul ${spentEur().toFixed(4)} €`)
  } catch (e) {
    console.error(`  ✗ ${label} : ${(e as Error).message}`)
  }
}

// ── Expérience 1 : reproduction pure sur 4 pépites gold ──────────────────────
const REPRO_PROMPT =
  'Recreate the logo shown in the attached reference image as faithfully as possible: same lettering style, same materials and finish, same colors, same background treatment, same composition. This is a fidelity test — match the reference exactly, at the highest possible rendering quality. Square image.'

const REPRO_SLUGS = ['logo', '4409091d08b9cb1da6aa3c72b0e1e0b4', 'c837de5b0bc55867b68557dc928c6c6c', 'branding']
for (const slug of REPRO_SLUGS) {
  await generate(`repro-${slug.slice(0, 12)}`, REPRO_PROMPT, [ref(slug)])
}

// ── Expérience 2 : transfert minimal, 3 phrases propres ──────────────────────
const MINIMAL_PROMPT =
  'Design a premium logo for a FiveM/GTA RP server named "FRUITZ", spelled F-R-U-I-T-Z, at the same production quality as the attached reference logos. Custom display lettering fused with a citrus slice emblem, chrome or satin materials, on a dark atmospheric background. The word must read exactly "FRUITZ" with perfectly formed letters.'

const MINIMAL_REFS = ['logo', 'logo2', 'flashmood-rp2']
await generate('minimal-texte-puis-images', MINIMAL_PROMPT, MINIMAL_REFS.map(ref))
await generate('minimal-images-etiquetees-dabord', MINIMAL_PROMPT, MINIMAL_REFS.map(ref), {
  referencesFirst: true,
  referenceLabels: [
    'REFERENCE 1 — the real "fruitz" wordmark: chrome script fused inside a citrus slice:',
    'REFERENCE 2 — chrome "S" monogram with star, premium cold chrome:',
    'REFERENCE 3 — "FLASH MOOD" chrome wordmark with lightning bolt fused in the O:',
  ],
})

// ── Expérience 3 : le prompt pipeline actuel (iter12 verbatim, réfs HQ) ──────
const iter12Prompts = JSON.parse(
  readFileSync(join(CALIBRATION_DIR, 'iter12-58-fruitz-dim', 'prompts-calques.json'), 'utf-8')
) as { lockup: string }
await generate('pipeline-iter12-refs-hq', iter12Prompts.lockup, ['adversitylife', 'group-1', 'nin3plaz-1460350845051863082'].map(ref))

// ── Montages réf | rendu pour la reproduction pure ───────────────────────────
for (const slug of REPRO_SLUGS) {
  const label = `repro-${slug.slice(0, 12)}`
  try {
    const refImg = await sharp(join(EXEMPLARS_DIR, `${slug}.jpg`)).resize(768, 768, { fit: 'inside' }).toBuffer()
    const gen = await sharp(join(OUT_DIR, `${label}.png`)).resize(768, 768, { fit: 'inside' }).toBuffer()
    await sharp({ create: { width: 1536, height: 768, channels: 3, background: '#111' } })
      .composite([
        { input: refImg, left: 0, top: 0 },
        { input: gen, left: 768, top: 0 },
      ])
      .jpeg({ quality: 88 })
      .toFile(join(OUT_DIR, `cote-a-cote-${label}.jpg`))
  } catch {
    // rendu manquant (échec de génération) : pas de montage
  }
}

console.log(`\nTerminé — dépense chantier 0 : ${spentEur().toFixed(4)} € / ${CAP_CHANTIER0_EUR.toFixed(2)} €`)
console.log(`Dossier : ${OUT_DIR}`)
