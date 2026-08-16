/*
 * Run 5.10 (chantier 2) — LA PREUVE que la frange blanche est corrigée.
 * Image synthétique : un disque orange sombre sur fond #F2F2F2, avec une
 * couronne BLANCHE de 2 px baked entre les deux (la contamination exacte que
 * le détourage 5.8-5.9 laissait passer). On vérifie :
 *   1. cutoutFlatBackground (l'ancien) GARDE des pixels quasi blancs opaques ;
 *   2. cutoutDecontamine les élimine (érosion + couleurs de bord reprises à
 *      l'intérieur) — plus aucun pixel clair opaque dans le résultat ;
 *   3. les verdicts d'isolation (fondRatio, bboxFraction) sont cohérents.
 *
 *   bun run scripts/test-cutout-decontamine.ts
 */

import sharp from 'sharp'
import { cutoutFlatBackground, cutoutDecontamine } from '../src/lib/engine/cutout'

const S = 512
const CX = S / 2
const CY = S / 2
const R = 140

function synthese(): Buffer {
  const px = Buffer.alloc(S * S * 4)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.sqrt((x - CX) ** 2 + (y - CY) ** 2)
      const i = (y * S + x) * 4
      if (d < R) {
        // la marque : orange sombre
        px[i] = 200
        px[i + 1] = 80
        px[i + 2] = 40
      } else if (d < R + 2) {
        // LA FRANGE : couronne blanche de 2 px (contamination de détourage)
        px[i] = 255
        px[i + 1] = 255
        px[i + 2] = 255
      } else {
        // fond plat #F2F2F2
        px[i] = 242
        px[i + 1] = 242
        px[i + 2] = 242
      }
      px[i + 3] = 255
    }
  }
  return px
}

async function compteClairsOpaques(png: Buffer): Promise<number> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let n = 0
  for (let p = 0; p < info.width * info.height; p++) {
    const a = data[p * 4 + 3]!
    if (a < 128) continue
    const r = data[p * 4]!
    const g = data[p * 4 + 1]!
    const b = data[p * 4 + 2]!
    // « quasi blanc » : bien plus clair que la marque (200,80,40)
    if (r > 235 && g > 235 && b > 235) n += 1
  }
  return n
}

const input = await sharp(synthese(), { raw: { width: S, height: S, channels: 4 } }).png().toBuffer()

const ancien = await cutoutFlatBackground(input)
const clairsAncien = await compteClairsOpaques(ancien.png)

const neuf = await cutoutDecontamine(input)
const clairsNeuf = await compteClairsOpaques(neuf.png)

let failures = 0
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? '✓' : '✗'} ${name} — ${detail}`)
  if (!ok) failures += 1
}

// Le flood-fill (tol 18) ne mange pas le blanc pur (distance ≈ 22 de #F2F2F2) :
// l'ancien détourage DOIT garder la frange — c'est le bug qu'on corrige.
check('l’ancien détourage garde la frange blanche (le bug est réel)', clairsAncien > 200, `${clairsAncien} pixels quasi blancs opaques`)
check('le détourage décontaminé l’élimine', clairsNeuf === 0, `${clairsNeuf} pixels quasi blancs opaques restants`)
check('le contenu de la marque survit', neuf.width > R && neuf.height > R, `recadré ${neuf.width}×${neuf.height}`)
check(
  'verdicts d’isolation cohérents (fond plat détecté)',
  neuf.fondRatio > 0.5 && neuf.bboxFraction.width < 0.96 && neuf.bboxFraction.height < 0.96,
  `fondRatio ${(neuf.fondRatio * 100).toFixed(1)} %, bbox ${(neuf.bboxFraction.width * 100).toFixed(0)}×${(neuf.bboxFraction.height * 100).toFixed(0)} %`
)

if (failures) {
  console.error(`\n${failures} échec(s) — la décontamination N'EST PAS prouvée.`)
  process.exit(1)
}
console.log('\nDécontamination de frange prouvée (érosion + couleurs intérieures).')
