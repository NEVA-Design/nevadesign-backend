/*
 * Run 5.10 — LA PLANCHE DU PIVOT : les images côte à côte, verdict opérateur.
 *
 * Ligne 1 — PIVOT 5.10 : les 3 familles fruitz en rendu intégral.
 * Ligne 2 — LA BARRE : les 2 transferts minimaux du test plafond (désormais
 *           la référence à égaler) + la repro pure du gold fruitz (mémoire).
 * Ligne 3 — 5.9 POUR MÉMOIRE : les 3 candidats base du checkpoint rejeté.
 *
 *   bun run scripts/calibration/planche-pivot.ts
 * Sortie : captures/calibration/_pivot-510/planche-pivot-fruitz.jpg
 * Zéro appel API.
 */

import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import sharp, { type OverlayOptions } from 'sharp'
import { CALIBRATION_DIR } from './budget5'

const CELL = 512
const CAPTION = 44
const HEADER = 58
const GAP = 10

type Cellule = { titre: string; chemin: string }
type Ligne = { entete: string; cellules: Cellule[] }

const LIGNES: Ligne[] = [
  {
    entete: 'PIVOT 5.10 — rendu INTÉGRAL (1 appel image, prompt minimal + réfs étiquetées)',
    cellules: [
      { titre: 'integ1 · plat_premium', chemin: join(CALIBRATION_DIR, 'integ1-510-fruitz-plat', 'candidate.png') },
      { titre: 'integ2 · semi_flat_biseau', chemin: join(CALIBRATION_DIR, 'integ2-510-fruitz-semi', 'candidate.png') },
      { titre: 'integ3 · dimensionnelle', chemin: join(CALIBRATION_DIR, 'integ3-510-fruitz-dim', 'candidate.png') },
    ],
  },
  {
    entete: 'LA BARRE — les 2 transferts minimaux du test plafond (+ repro pure du gold, mémoire)',
    cellules: [
      { titre: 'plafond · minimal texte→images', chemin: join(CALIBRATION_DIR, '_plafond-run59', 'minimal-texte-puis-images.png') },
      { titre: 'plafond · minimal réfs étiquetées', chemin: join(CALIBRATION_DIR, '_plafond-run59', 'minimal-images-etiquetees-dabord.png') },
      { titre: 'plafond · repro pure gold fruitz', chemin: join(CALIBRATION_DIR, '_plafond-run59', 'repro-logo.png') },
    ],
  },
  {
    entete: '5.9 POUR MÉMOIRE — pipeline calques (checkpoint rejeté)',
    cellules: [
      { titre: 'iter20 · plat (base typo)', chemin: join(CALIBRATION_DIR, 'iter20-59-fruitz-plat-base', 'candidate.png') },
      { titre: 'iter22 · semi (base typo, 9/10 jury)', chemin: join(CALIBRATION_DIR, 'iter22-59-fruitz-semi-base', 'candidate.png') },
      { titre: 'iter24 · dim (base typo)', chemin: join(CALIBRATION_DIR, 'iter24-59-fruitz-dim-base', 'candidate.png') },
    ],
  },
]

function svgTexte(largeur: number, hauteur: number, texte: string, taille: number, fond: string): Buffer {
  const echappe = texte.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return Buffer.from(
    `<svg width="${largeur}" height="${hauteur}"><rect width="${largeur}" height="${hauteur}" fill="${fond}"/><text x="12" y="${Math.round(hauteur * 0.68)}" font-family="Arial" font-size="${taille}" fill="#ffffff">${echappe}</text></svg>`
  )
}

const cols = 3
const largeur = cols * CELL + (cols + 1) * GAP
const ligneH = HEADER + CELL + CAPTION + GAP
const hauteur = LIGNES.length * ligneH + GAP

const composites: OverlayOptions[] = []
let y = GAP
for (const ligne of LIGNES) {
  composites.push({ input: svgTexte(largeur - 2 * GAP, HEADER - 8, ligne.entete, 26, '#1d2530'), left: GAP, top: y })
  const yCell = y + HEADER
  for (const [i, cell] of ligne.cellules.entries()) {
    const x = GAP + i * (CELL + GAP)
    if (existsSync(cell.chemin)) {
      const img = await sharp(readFileSync(cell.chemin)).resize(CELL, CELL, { fit: 'contain', background: '#0b0e14' }).png().toBuffer()
      composites.push({ input: img, left: x, top: yCell })
    } else {
      composites.push({ input: svgTexte(CELL, CELL, `MANQUANT : ${cell.titre}`, 22, '#3a1d1d'), left: x, top: yCell })
      console.warn(`⚠ cellule manquante : ${cell.chemin}`)
    }
    composites.push({ input: svgTexte(CELL, CAPTION, cell.titre, 22, '#111'), left: x, top: yCell + CELL })
  }
  y += ligneH
}

const OUT = join(CALIBRATION_DIR, '_pivot-510')
mkdirSync(OUT, { recursive: true })
await sharp({ create: { width: largeur, height: hauteur, channels: 3, background: '#05070b' } })
  .composite(composites)
  .jpeg({ quality: 90 })
  .toFile(join(OUT, 'planche-pivot-fruitz.jpg'))

console.log(`Planche : ${join(OUT, 'planche-pivot-fruitz.jpg')} (${largeur}×${hauteur})`)
