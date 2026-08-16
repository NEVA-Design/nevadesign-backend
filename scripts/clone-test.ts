/*
 * Run 5.7 — LOT 4 : LE CLONE TEST.
 *
 * Reconstruit le logo de `logo_gtanew.psd` (PackPsd) via le pipeline par
 * calques, avec les paramètres EXACTS du manifest :
 *   - lettrage « GTA »  : Pricedown Black (police exacte, embarquée),
 *     gradient 6 stops relevé du calque texte (#fb69b6 → #ff24f6 → #ffffff →
 *     #974d42 → #ffd1ca → #ffada0), contour blanc outside 4 px (distribution PSD),
 *     position bounds 134,288 → 881,600 (canvas 1024).
 *   - badge « NEW »     : rectangle gradientOverlay #ffb57e → #ff5e9a angle 132°
 *     (opacité 0.72), incliné −2,45° (matrice du calque texte NEW), lettrage
 *     Archivo Black élargi ×1.25 (équivalent mappé de DrukWideTrial-SuperItalic).
 *   - fond              : régénéré par IA d'après le manifest (nuit violette,
 *     grille rétro linear-dodge 70 % à particules dorées, 2 palmiers noirs,
 *     3 halos roses screen 71 %, halo chaud screen 70 %, lueur bleue basse) —
 *     OCR d'exclusion : aucun texte toléré.
 *
 * Sorties (captures/calibration/clone-gtanew/) : fond.png, lettrage-*.png,
 * clone.png, side-by-side.jpg, clone-report.md. Budget : garde réelle,
 * label run57-clone.
 *
 * Usage : bun scripts/clone-test.ts [--dry] [--reuse-fond]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { renderLettrage } from '../src/lib/engine/lettrage'
import { generateWithOcrGate } from '../src/lib/engine/ocr-gate'
import { ENGINE_MODELS, LOGO_THINKING_LEVEL } from '../src/lib/engine/generation'
import { CALIBRATION_DIR, installBudgetGuard, setBudgetLabel, spentForLabel } from './calibration/budget'

const DIR = join(CALIBRATION_DIR, 'clone-gtanew')
const KNOWLEDGE = join(import.meta.dir, '..', 'src', 'engine', 'psd-knowledge', 'logo_gtanew')
const DRY = process.argv.includes('--dry')
const REUSE_FOND = process.argv.includes('--reuse-fond')
const S = 1024

// ── les paramètres extraits du manifest (aucune valeur inventée) ─────────────
const GTA_GRADIENT = [
  { color: '#fb69b6', location: 0 },
  { color: '#ff24f6', location: 0.262 },
  { color: '#ffffff', location: 0.51 },
  { color: '#974d42', location: 0.694 },
  { color: '#ffd1ca', location: 0.851 },
  { color: '#ffada0', location: 1 },
]
const GTA_BOUNDS = { left: 134, top: 288, right: 881, bottom: 600 }
// Sens visuel du rendu final : rose magenta à gauche → orange pêche à droite,
// badge légèrement ASCENDANT vers la droite (matrice du calque NEW : −2,45°,
// soit +2,45 en convention sharp constatée à l'itération 1 du clone).
const BADGE = { left: 171, top: 568, width: 720, height: 264, angleDeg: 2.45, gradient: ['#ff5e9a', '#ffb57e'], gradientAngle: 132, opacity: 0.72 }
const NEW_BOUNDS = { left: 227, top: 629, right: 836, bottom: 773 }

const FOND_PROMPT = [
  'Full-bleed BACKDROP layer for a premium FiveM/GTA server logo, faithful to this exact layer recipe (decomposed from a professional PSD):',
  '- BASE: VERY dark moody night backdrop with a rich magenta-plum cast (dark purple-pink, never pure black), gently darker toward corners — NO visible border, NO frame, NO vignette edge line. Overall exposure LOW — this is a subtle backdrop, not a poster.',
  '- PALMS: HEAVILY blurred out-of-focus palm fronds softly catching warm golden light, entering from the top-left corner and the bottom-right corner — strong photographic bokeh, dreamy, sensed more than seen.',
  '- GRID: one BARELY visible thin flat grid pattern across the frame at 10-15% opacity — faint straight lines, NO synthwave sun, NO bright neon horizon, NO perspective floor.',
  '- PARTICLES: a few tiny sparse pale-pink dust particles floating, very subtle.',
  '- DISCIPLINE: the CENTRAL area stays calm and dark — the mark is composed on top later. No bright glow anywhere, no sharp objects.',
  'ABSOLUTELY NO TEXT anywhere: zero letters, zero numbers, no signage, no watermark.',
  'Square 1:1 composition, full-bleed, no border. Understated premium finish, like the untouched backdrop plate of a professional logo PSD.',
].join('\n')

async function makeFond(): Promise<Buffer> {
  const fondPath = join(DIR, 'fond.png')
  if (REUSE_FOND && existsSync(fondPath)) {
    console.log('fond réutilisé (cache local)')
    return readFileSync(fondPath)
  }
  const generation = await generateWithOcrGate({
    model: ENGINE_MODELS.logoImage,
    prompt: FOND_PROMPT,
    imageConfig: { aspectRatio: '1:1', imageSize: '2K' },
    thinkingLevel: LOGO_THINKING_LEVEL,
    expectedTexts: [],
    forbidAnyText: true,
    log: { userId: 'clone-test-run5.7', projectId: null, assetId: null, kind: 'clone_fond', resolution: '2K' },
  })
  const png = Buffer.from(generation.dataUrl.split(',').pop() ?? '', 'base64')
  writeFileSync(fondPath, png)
  console.log(`fond généré (${generation.ocrRejects} rejet(s) OCR)`)
  return png
}

async function buildClone(fondPng: Buffer): Promise<Buffer> {
  // ── lettrage GTA — la construction EXACTE du calque texte PSD :
  // fill rose doux (fillColor #ffa3fb, éclairci au centre-haut comme le rendu
  // final), stroke OUTSIDE 4 px en GRADIENT (les 6 stops relevés — le rim
  // doré/chrome) + stroke INSIDE 3 px blanc, glow rose. ──
  // Les épaisseurs de styles de calque PSD sont ABSOLUES en pixels document
  // (4 px sur un texte de ~486 px de haut = rim fin) — on rend directement à
  // la taille finale, pas de mise à l'échelle des effets.
  const gtaStyle = (taillePx: number) => ({
    famille: 'Pricedown Bl',
    taillePx,
    gradient: {
      stops: [
        { color: '#ffa3f6', location: 0 },
        { color: '#ffd0fa', location: 0.6 },
        { color: '#ffb9f8', location: 1 },
      ],
      angle: 90,
    },
    contours: [
      { taillePx: 5, gradient: { stops: GTA_GRADIENT, angle: 90 }, position: 'outside' as const },
      { taillePx: 3, couleur: '#ffffff', position: 'inside' as const },
    ],
    glow: { taillePx: 13, couleur: '#ff7ae8', opacite: 0.35 },
    ombre: { taillePx: 30, distancePx: 10, opacite: 0.45 },
  })
  const gtaTargetW = GTA_BOUNDS.right - GTA_BOUNDS.left // 747
  let gta = await renderLettrage('GTA', gtaStyle(100))
  const ratio = gtaTargetW / gta.textBox.width
  gta = await renderLettrage('GTA', gtaStyle(Math.round(100 * ratio)))
  writeFileSync(join(DIR, 'lettrage-gta.png'), gta.png)

  // ── badge NEW : rectangle gradient 132° + lettrage Archivo Black élargi ──
  const badgeSvg =
    `<svg width="${BADGE.width}" height="${BADGE.height}"><defs>` +
    `<linearGradient id="g" x1="0" y1="0.8" x2="1" y2="0.2">` +
    `<stop offset="0" stop-color="${BADGE.gradient[0]}"/><stop offset="1" stop-color="${BADGE.gradient[1]}"/></linearGradient></defs>` +
    `<rect x="6" y="14" width="${BADGE.width - 12}" height="${BADGE.height - 28}" fill="url(#g)"/></svg>`
  const badgeRect = await sharp(Buffer.from(badgeSvg)).png().toBuffer()

  const newTargetW = NEW_BOUNDS.right - NEW_BOUNDS.left // 609
  let neu = await renderLettrage('NEW', { famille: 'Archivo Black', taillePx: 100, couleur: '#ffffff', scaleX: 1.25 })
  const nratio = newTargetW / neu.textBox.width
  neu = await renderLettrage('NEW', {
    famille: 'Archivo Black',
    taillePx: Math.round(100 * nratio),
    couleur: '#ffffff',
    scaleX: 1.25,
    ombre: { taillePx: 12, distancePx: 5, opacite: 0.35 },
  })

  // badge + NEW assemblés puis inclinés ensemble (matrice du calque texte)
  const badgeAssembled = await sharp(badgeRect)
    .composite([
      {
        input: neu.png,
        left: Math.round((BADGE.width - neu.width) / 2),
        top: Math.round((BADGE.height - neu.height) / 2),
      },
    ])
    .png()
    .toBuffer()
  const badgeTilted = await sharp(badgeAssembled)
    .rotate(BADGE.angleDeg, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
  writeFileSync(join(DIR, 'badge-new.png'), badgeTilted)

  // ── assemblage final aux positions du manifest ──
  const fond = await sharp(fondPng).resize(S, S, { fit: 'cover' }).png().toBuffer()
  const tiltedMeta = await sharp(badgeTilted).metadata()
  const clone = await sharp(fond)
    .composite([
      { input: gta.png, left: GTA_BOUNDS.left - gta.textBox.left, top: GTA_BOUNDS.top - gta.textBox.top },
      {
        input: badgeTilted,
        left: BADGE.left - Math.round(((tiltedMeta.width ?? BADGE.width) - BADGE.width) / 2),
        top: BADGE.top - Math.round(((tiltedMeta.height ?? BADGE.height) - BADGE.height) / 2),
      },
    ])
    .png()
    .toBuffer()
  return clone
}

async function sideBySide(clone: Buffer): Promise<void> {
  // l'original = l'export final du pack (le composite ag-psd n'a pas fusionné
  // les calques d'effets du haut — constaté à l'itération 1)
  const original = await sharp(join(import.meta.dir, '..', '..', 'entrainement IA fivem', 'PackPsd', 'gtanewlogo.png'))
    .resize(S, S)
    .png()
    .toBuffer()
  const sheet = await sharp({ create: { width: S * 2 + 24, height: S + 60, channels: 4, background: '#111111' } })
    .composite([
      { input: original, left: 8, top: 44 },
      { input: clone, left: S + 16, top: 44 },
      {
        input: Buffer.from(
          `<svg width="${S * 2 + 24}" height="40"><text x="${8 + S / 2}" y="28" text-anchor="middle" font-family="Arial" font-size="24" fill="#ffffff" font-weight="bold">ORIGINAL (PSD pro)</text>` +
            `<text x="${S + 16 + S / 2}" y="28" text-anchor="middle" font-family="Arial" font-size="24" fill="#ffffff" font-weight="bold">CLONE (pipeline calques run 5.7)</text></svg>`
        ),
        left: 0,
        top: 0,
      },
    ])
    .jpeg({ quality: 90 })
    .toBuffer()
  writeFileSync(join(DIR, 'side-by-side.jpg'), sheet)
}

// ── main ──
mkdirSync(DIR, { recursive: true })
if (DRY) {
  console.log('DRY: paramètres chargés, prompt fond :\n' + FOND_PROMPT)
  console.log('\nCoût attendu : 1 génération 2K ≈ 0,13 € (+1 si rejet OCR).')
  process.exit(0)
}
installBudgetGuard()
setBudgetLabel('run57-clone')

const fond = await makeFond()
const clone = await buildClone(fond)
writeFileSync(join(DIR, 'clone.png'), clone)
await sideBySide(clone)
console.log(`clone écrit : ${join(DIR, 'clone.png')} · coût clone : ${spentForLabel('run57-clone').toFixed(4)} €`)
