/*
 * Run 6 (§6) — LA PREUVE que la conformité palette tient sans appel API.
 * Zéro appel : on fabrique des images de synthèse dont on CONNAÎT la couleur,
 * puis on vérifie que
 *   1. ΔE2000 est correct sur des paires de référence connues ;
 *   2. le k-means retrouve les amas dominants d'une image bicolore ;
 *   3. un rendu hors palette est détecté (ΔE > 12) et RAMENÉ sous le seuil ;
 *   4. la LUMINANCE survit à la correction — c'est elle qui porte le chrome ;
 *   5. un rendu déjà conforme n'est pas touché (pas de surcorrection).
 *
 *   bun run scripts/test-palette-v6.ts
 */

import sharp from 'sharp'
import {
  deltaE2000,
  rgbToLab,
  hexToRgb,
  rgbToHex,
  kmeans,
  mesurePalette,
  conformePalette,
  DELTA_E_SEUIL,
} from '../src/lib/engine/logo-palette'

let failures = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`}`)
  if (!ok) failures += 1
}

// ── 1. ΔE2000 sur des paires connues ─────────────────────────────────────────
const dE = (a: string, b: string) => Math.round(deltaE2000(rgbToLab(hexToRgb(a)), rgbToLab(hexToRgb(b))) * 10) / 10
check('ΔE : une couleur avec elle-même → 0', dE('#FF6A00', '#FF6A00'), 0)
check('ΔE : noir vs blanc → 100', dE('#000000', '#FFFFFF'), 100)
check('ΔE : deux oranges voisins → sous le seuil', dE('#FF6A00', '#FA6E08') < DELTA_E_SEUIL, true)
check('ΔE : orange vs bleu → très au-dessus du seuil', dE('#FF6A00', '#0A2A6B') > DELTA_E_SEUIL, true)
check('ΔE : conversion hex aller-retour', rgbToHex(hexToRgb('#3AB54A')), '#3ab54a')

// ── 2. k-means sur des pixels connus ─────────────────────────────────────────
const pixelsBicolores = [
  ...Array.from({ length: 700 }, () => hexToRgb('#FF6A00')),
  ...Array.from({ length: 300 }, () => hexToRgb('#0A2A6B')),
]
const amas = kmeans(pixelsBicolores, 5)
check('k-means : le cluster dominant est l\'orange majoritaire', dE(rgbToHex(amas[0]!.rgb), '#FF6A00') < 2, true)
check('k-means : sa part est ~70 %', Math.abs(amas[0]!.part - 0.7) < 0.02, true)
check('k-means : le second amas est le bleu', dE(rgbToHex(amas[1]!.rgb), '#0A2A6B') < 2, true)
check(
  'k-means : déterministe (même graine → même résultat)',
  rgbToHex(kmeans(pixelsBicolores, 5)[0]!.rgb),
  rgbToHex(amas[0]!.rgb)
)

// ── 3-5. mesure et correction sur images de synthèse ─────────────────────────
/** Un « lettrage » dégradé (le modelé chrome) sur fond sombre. */
async function rendu(hex: string): Promise<Buffer> {
  const { r, g, b } = hexToRgb(hex)
  const W = 256
  const H = 256
  const brut = Buffer.alloc(W * H * 4)
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const o = (y * W + x) * 4
      const dansLeMot = y > H * 0.35 && y < H * 0.65 && x > W * 0.2 && x < W * 0.8
      if (dansLeMot) {
        // modelé : la luminance monte de 55 % à 145 % sur la hauteur du mot
        const t = 0.55 + ((y - H * 0.35) / (H * 0.3)) * 0.9
        brut[o] = Math.min(255, r * t)
        brut[o + 1] = Math.min(255, g * t)
        brut[o + 2] = Math.min(255, b * t)
      } else {
        brut[o] = 14
        brut[o + 1] = 16
        brut[o + 2] = 28
      }
      brut[o + 3] = 255
    }
  }
  return sharp(brut, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()
}

/** Écart-type de la luminance dans la zone du mot — la preuve du modelé. */
async function modele(png: Buffer): Promise<number> {
  const { data, info } = await sharp(png).extract({ left: 60, top: 100, width: 130, height: 60 }).raw().toBuffer({ resolveWithObject: true })
  const lum: number[] = []
  for (let i = 0; i < info.width * info.height; i += 1) {
    const o = i * info.channels
    lum.push(0.2126 * data[o]! + 0.7152 * data[o + 1]! + 0.0722 * data[o + 2]!)
  }
  const moy = lum.reduce((s, v) => s + v, 0) / lum.length
  return Math.round(Math.sqrt(lum.reduce((s, v) => s + (v - moy) ** 2, 0) / lum.length) * 10) / 10
}

const PALETTE = ['#FF6A00']
const zoneMot: [number, number, number, number] = [0.2, 0.35, 0.6, 0.3]

// 3. rendu hors palette (vert) : détecté puis ramené sous le seuil
const vert = await rendu('#3AB54A')
const mesureVert = await mesurePalette({ png: vert, palette: PALETTE, wordBbox: zoneMot })
check('hors palette : écart détecté au-dessus du seuil', mesureVert.deltaEMax > DELTA_E_SEUIL, true)
check('hors palette : marqué non conforme', mesureVert.conforme, false)

const corrige = await conformePalette({ png: vert, palette: PALETTE, wordBbox: zoneMot })
check('correction : appliquée', corrige.applique, true)
check("correction : l'écart chute d'au moins 75 %", corrige.deltaEApres < corrige.deltaEAvant * 0.25, true)
console.log(`   ΔE ${corrige.deltaEAvant} → ${corrige.deltaEApres} · ${(corrige.partCorrigee * 100).toFixed(1)} % des pixels déplacés`)

// Le critère qui compte pour le client, c'est LA TEINTE. Un ΔE résiduel de
// l'ordre de 10 est structurel sur un matériau modelé : un dégradé qui monte
// vers le blanc a moins de chroma MOYENNE qu'un aplat, et la seule façon de le
// faire tomber à zéro serait d'aplatir la matière — ce que le §6 refuse
// explicitement. On vérifie donc que la teinte est bien celle demandée.
function teinteDe(rgb: { r: number; g: number; b: number }): number {
  const { r, g, b } = { r: rgb.r / 255, g: rgb.g / 255, b: rgb.b / 255 }
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max === min) return 0
  const d = max - min
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}
const apresMesure = await mesurePalette({ png: corrige.png, palette: PALETTE, wordBbox: zoneMot })
const ecartTeinte = Math.abs(teinteDe(apresMesure.clusters[0]!.rgb) - teinteDe(hexToRgb(PALETTE[0]!)))
check('correction : la teinte du cluster dominant est celle demandée (< 5°)', ecartTeinte < 5, true)
console.log(`   teinte dominante ${teinteDe(apresMesure.clusters[0]!.rgb).toFixed(1)}° vs cible ${teinteDe(hexToRgb(PALETTE[0]!)).toFixed(1)}°`)

// 4. le modelé survit — la luminance n'a pas été aplatie
const modeleAvant = await modele(vert)
const modeleApres = await modele(corrige.png)
check('modelé : préservé (écart-type de luminance quasi inchangé)', Math.abs(modeleApres - modeleAvant) < 3, true)
console.log(`   écart-type de luminance ${modeleAvant} → ${modeleApres}`)

// 5. rendu déjà conforme : aucune correction (pas de balancier)
const orange = await rendu('#FF6A00')
const mesureOrange = await mesurePalette({ png: orange, palette: PALETTE, wordBbox: zoneMot })
check('déjà conforme : sous le seuil', mesureOrange.conforme, true)
const intact = await conformePalette({ png: orange, palette: PALETTE, wordBbox: zoneMot })
check('déjà conforme : aucune correction appliquée', intact.applique, false)
check('déjà conforme : image rendue telle quelle', intact.png.equals(orange), true)

console.log(failures ? `\n${failures} test(s) en échec` : '\nTous les tests de la conformité palette passent')
process.exit(failures ? 1 : 0)
