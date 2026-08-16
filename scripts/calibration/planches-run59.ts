// Run 5.9 — planches de comparaison pour le checkpoint opérateur.
// Planche A : les 3 familles — checkpoint 5.8 rejeté (haut) vs 5.9 base typo
// (milieu) vs 5.9 lockup libre (bas). Planche B : synthèse du test plafond.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp, { type OverlayOptions } from 'sharp'

const CAL = join(import.meta.dir, '..', '..', '..', 'captures', 'calibration')
const OUT = join(CAL, '_checkpoint-run59')
const CELL = 460
const LABEL_H = 30

async function planche(rows: Array<Array<{ path: string; label: string }>>, outName: string) {
  const cols = Math.max(...rows.map((r) => r.length))
  const composites: OverlayOptions[] = []
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y]!.length; x++) {
      const cellDef = rows[y]![x]!
      const img = await sharp(await readFile(cellDef.path)).resize(CELL, CELL, { fit: 'inside' }).toBuffer()
      composites.push({ input: img, left: x * CELL, top: y * (CELL + LABEL_H) })
      const svg = Buffer.from(
        `<svg width="${CELL}" height="${LABEL_H}"><rect width="100%" height="100%" fill="#111"/><text x="6" y="21" font-family="Arial" font-size="16" fill="#fff">${cellDef.label}</text></svg>`
      )
      composites.push({ input: svg, left: x * CELL, top: y * (CELL + LABEL_H) + CELL })
    }
  }
  const sheet = await sharp({
    create: { width: cols * CELL, height: rows.length * (CELL + LABEL_H), channels: 3, background: '#222' },
  })
    .composite(composites)
    .jpeg({ quality: 88 })
    .toBuffer()
  await writeFile(join(OUT, outName), sheet)
  console.log(`planche : ${join(OUT, outName)}`)
}

const c = (iter: string) => join(CAL, iter, 'candidate.png')

await Bun.write(join(OUT, '.keep'), '')

await planche(
  [
    [
      { path: c('iter10b-58-fruitz-plat'), label: '5.8 REJETE — plat (sticker blanc, candy, fond clair)' },
      { path: c('iter11-58-fruitz-semi'), label: '5.8 REJETE — semi (FRU VTZ, epi de ble)' },
      { path: c('iter12-58-fruitz-dim'), label: '5.8 REJETE — dim (glyphes, arcs dominants)' },
    ],
    [
      { path: c('iter20-59-fruitz-plat-base'), label: '5.9 BASE TYPO — plat (jury 4 : sticker+fond)' },
      { path: c('iter22-59-fruitz-semi-base'), label: '5.9 BASE TYPO — semi (jury 9, aveugle 0/3)' },
      { path: c('iter24-59-fruitz-dim-base'), label: '5.9 BASE TYPO — dim (jury 4 : tache detourage)' },
    ],
    [
      { path: c('iter21-59-fruitz-plat-libre'), label: '5.9 LIBRE — plat (jury 9)' },
      { path: c('iter23-59-fruitz-semi-libre'), label: '5.9 LIBRE — semi (jury 4 : sticker+candy)' },
      { path: c('iter25-59-fruitz-dim-libre'), label: '5.9 LIBRE — dim (jury 4 : tache+T avale)' },
    ],
  ],
  'planche-A-familles-58-vs-59.jpg'
)

const P = join(CAL, '_plafond-run59')
await planche(
  [
    [
      { path: join(P, 'repro-logo.png'), label: 'PLAFOND — repro pure du wordmark Fruitz reel' },
      { path: join(P, 'repro-c837de5b0bc5.png'), label: 'PLAFOND — repro pure du R or fracture' },
      { path: join(P, 'repro-4409091d08b9.png'), label: 'PLAFOND — repro pure du badge ALYA' },
    ],
    [
      { path: join(P, 'minimal-texte-puis-images.png'), label: 'PLAFOND — transfert minimal (texte puis images)' },
      { path: join(P, 'minimal-images-etiquetees-dabord.png'), label: 'PLAFOND — transfert minimal (images etiquetees d abord)' },
      { path: join(P, 'pipeline-iter12-refs-hq.png'), label: 'PLAFOND — prompt pipeline iter12 + refs HQ' },
    ],
  ],
  'planche-B-test-plafond.jpg'
)
