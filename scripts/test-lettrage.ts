/**
 * Run 5.7 — banc d'essai local du rendu lettrage (zéro appel API).
 * Rend 4 poses de styles tirés des paramètres PSD et les pose sur fond sombre.
 * Usage : bun scripts/test-lettrage.ts <dossier-sortie>
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { renderLettrage } from '../src/lib/engine/lettrage'

const OUT = process.argv[2] ?? '.'

const poses: Array<{ nom: string; texte: string; style: Parameters<typeof renderLettrage>[1] }> = [
  {
    nom: 'fruitz-anton',
    texte: 'FRUITZ',
    style: {
      famille: 'Anton',
      taillePx: 160,
      gradient: { stops: [{ color: '#FF6B4A', location: 0 }, { color: '#FFC4A3', location: 1 }], angle: 90 },
      contour: { taillePx: 4, couleur: '#ffffff', position: 'outside' },
      ombre: { taillePx: 38, distancePx: 12, opacite: 0.52 },
    },
  },
  {
    nom: 'gta-pricedown',
    texte: 'GTA',
    style: {
      famille: 'Pricedown Bl',
      taillePx: 200,
      // les stops EXACTS extraits du calque texte GTA de logo_gtanew.psd
      gradient: {
        stops: [
          { color: '#fb69b6', location: 0 },
          { color: '#ff24f6', location: 0.26 },
          { color: '#ffffff', location: 0.51 },
          { color: '#974d42', location: 0.69 },
          { color: '#ffd1ca', location: 0.85 },
          { color: '#ffada0', location: 1 },
        ],
        angle: 90,
      },
      contour: { taillePx: 3, couleur: '#ffffff', position: 'outside' },
      glow: { taillePx: 13, couleur: '#ff9de9', opacite: 0.6 },
    },
  },
  {
    nom: 'azure-unbounded',
    texte: 'AZURE BAY',
    style: {
      famille: 'Unbounded Medium',
      taillePx: 110,
      couleur: '#eafcff',
      contour: { taillePx: 2, couleur: '#8ad9ff', position: 'inside' },
      glow: { taillePx: 10, couleur: '#118AB2', opacite: 0.8 },
      tracking: 40,
    },
  },
  {
    nom: 'new-druk-like',
    texte: 'NEW',
    style: {
      famille: 'Archivo Black',
      taillePx: 150,
      couleur: '#ffffff',
      scaleX: 1.25,
      skewX: -10,
      ombre: { taillePx: 20, distancePx: 8, opacite: 0.5 },
    },
  },
]

const cells: Buffer[] = []
for (const p of poses) {
  const r = await renderLettrage(p.texte, p.style)
  writeFileSync(join(OUT, `lettrage-${p.nom}.png`), r.png)
  console.log(`${p.nom}: ${r.width}x${r.height}`)
  cells.push(
    await sharp({ create: { width: 900, height: 320, channels: 4, background: '#131b2e' } })
      .composite([{ input: await sharp(r.png).resize(860, 280, { fit: 'inside', withoutEnlargement: true }).png().toBuffer(), gravity: 'centre' }])
      .png()
      .toBuffer()
  )
}
const H = cells.length * 320
const sheet = await sharp({ create: { width: 900, height: H, channels: 4, background: '#131b2e' } })
  .composite(cells.map((c, i) => ({ input: c, left: 0, top: i * 320 })))
  .jpeg({ quality: 92 })
  .toBuffer()
writeFileSync(join(OUT, 'lettrage-sheet.jpg'), sheet)
console.log('planche écrite:', join(OUT, 'lettrage-sheet.jpg'))
