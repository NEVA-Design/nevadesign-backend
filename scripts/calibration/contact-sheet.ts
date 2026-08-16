// Chantier 0b — planche contact étiquetée des exemplars haute résolution,
// pour identifier les pépites du gold set en une lecture vision.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp, { type OverlayOptions } from 'sharp'

const EXEMPLARS_DIR = join(import.meta.dir, '..', '..', 'src', 'engine', 'exemplars', 'fivem', 'logo')
const OUT_DIR = join(import.meta.dir, '..', '..', '..', 'captures', 'calibration', '_audit-run59')

const SLUGS = process.argv.slice(2)
if (!SLUGS.length) throw new Error('usage: contact-sheet.ts <slug> <slug> …')

const CELL = 320
const LABEL_H = 28
const COLS = 4
const rows = Math.ceil(SLUGS.length / COLS)

const composites: OverlayOptions[] = []
for (let i = 0; i < SLUGS.length; i++) {
  const slug = SLUGS[i]!
  const img = await sharp(await readFile(join(EXEMPLARS_DIR, `${slug}.jpg`)))
    .resize(CELL, CELL, { fit: 'inside' })
    .toBuffer()
  const x = (i % COLS) * CELL
  const y = Math.floor(i / COLS) * (CELL + LABEL_H)
  composites.push({ input: img, left: x, top: y })
  const label = Buffer.from(
    `<svg width="${CELL}" height="${LABEL_H}"><rect width="100%" height="100%" fill="#111"/><text x="6" y="19" font-family="Arial" font-size="15" fill="#fff">${i + 1}. ${slug.slice(0, 34)}</text></svg>`
  )
  composites.push({ input: label, left: x, top: y + CELL })
}

const sheet = await sharp({
  create: { width: COLS * CELL, height: rows * (CELL + LABEL_H), channels: 3, background: '#222' },
})
  .composite(composites)
  .jpeg({ quality: 85 })
  .toBuffer()

const out = join(OUT_DIR, 'contact-sheet.jpg')
await writeFile(out, sheet)
console.log(`planche : ${out} (${SLUGS.length} exemplars)`)
