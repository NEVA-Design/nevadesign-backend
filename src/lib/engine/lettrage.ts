/*
 * Run 5.7 — LOT 2 : le lettrage typographié, rendu côté serveur.
 *
 * Verdict de l'arbitrage PSD (rapports/run57-arbitrage-lettrage.md) : 72 % du
 * lettrage professionnel est typographié (vraies polices + styles de calques),
 * 0 % est généré. Ce module reproduit la construction des pros :
 *   fillText de vraies polices display (src/engine/fonts, table fonts-map.json)
 *   + styles de calques programmatiques — contour, gradient overlay, outer glow,
 *   drop shadow, biseau léger — dont les paramètres sont BORNÉS par la
 *   distribution mesurée sur les 13 PSD du PackPsd (logo.json.recettes_calques).
 *
 * L'orthographe est parfaite PAR CONSTRUCTION : aucun appel API ici.
 *
 * Découpage technique : @napi-rs/canvas ne sert qu'à rasteriser les glyphes
 * (fill, strokes) — son drawImage est inopérant dans cet environnement
 * (constaté run 5.7) ; tout le compositing (flous, teintes, offsets, empilement)
 * passe par sharp.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp, { type OverlayOptions } from 'sharp'
import { createCanvas, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas'

const FONTS_DIR = resolve(import.meta.dir, '../../engine/fonts')
const LOGO_JSON = resolve(import.meta.dir, '../../engine/styles/fivem/logo.json')

// ── polices : enregistrement unique au premier usage ─────────────────────────

export type FontEntry = {
  psd_font: string
  licence: string
  statut: 'exacte' | 'equivalente'
  file: string
  css_family: string
  scaleX?: number
  skewX?: number
}

let fontsLoaded = false
let fontMap: FontEntry[] = []

export function loadFonts(): FontEntry[] {
  if (fontsLoaded) return fontMap
  const mapPath = join(FONTS_DIR, 'fonts-map.json')
  const parsed = JSON.parse(readFileSync(mapPath, 'utf-8')) as { familles: FontEntry[] }
  const seen = new Set<string>()
  for (const f of parsed.familles) {
    if (seen.has(f.file)) continue
    seen.add(f.file)
    const p = join(FONTS_DIR, f.file)
    if (existsSync(p)) GlobalFonts.registerFromPath(p, f.css_family)
  }
  fontMap = parsed.familles
  fontsLoaded = true
  return fontMap
}

/** Résout une famille demandée (nom PSD ou css_family) vers l'entrée embarquée. */
export function resolveFont(name: string): FontEntry | null {
  const map = loadFonts()
  const low = name.toLowerCase()
  return (
    map.find((f) => f.css_family.toLowerCase() === low) ??
    map.find((f) => f.psd_font.toLowerCase() === low) ??
    map.find((f) => f.psd_font.toLowerCase().startsWith(low)) ??
    null
  )
}

// ── bornes PSD : la distribution mesurée est la seule source de vérité ───────

type Distrib = { median: number; p25: number; p75: number; min: number; max: number }

export type PsdBornes = {
  stroke: Distrib
  outerGlow: Distrib
  dropShadowSize: Distrib
  dropShadowDistance: Distrib
  bevel: Distrib
  strokeCouleursClaires: boolean
}

const FALLBACK_BORNES: PsdBornes = {
  // valeurs mesurées run 5.7 (13 PSD) — recopiées en dur au cas où logo.json
  // serait indisponible ; la lecture runtime reste prioritaire.
  stroke: { median: 3, p25: 2, p75: 4, min: 1, max: 6 },
  outerGlow: { median: 13, p25: 7, p75: 13, min: 0, max: 13 },
  dropShadowSize: { median: 38, p25: 7, p75: 40, min: 7, max: 87 },
  dropShadowDistance: { median: 12, p25: 6, p75: 20, min: 0, max: 41 },
  bevel: { median: 0, p25: 0, p75: 0, min: 0, max: 18 },
  strokeCouleursClaires: true,
}

let bornesCache: PsdBornes | null = null

export function psdBornes(): PsdBornes {
  if (bornesCache) return bornesCache
  try {
    const logo = JSON.parse(readFileSync(LOGO_JSON, 'utf-8')) as {
      recettes_calques?: { parametres_effets?: Record<string, Record<string, Distrib>> }
    }
    const p = logo.recettes_calques?.parametres_effets
    if (p) {
      bornesCache = {
        stroke: (p.stroke?.size as Distrib) ?? FALLBACK_BORNES.stroke,
        outerGlow: (p.outerGlow?.size as Distrib) ?? FALLBACK_BORNES.outerGlow,
        dropShadowSize: (p.dropShadow?.size as Distrib) ?? FALLBACK_BORNES.dropShadowSize,
        dropShadowDistance: (p.dropShadow?.distance as Distrib) ?? FALLBACK_BORNES.dropShadowDistance,
        bevel: (p.bevel?.size as Distrib) ?? FALLBACK_BORNES.bevel,
        strokeCouleursClaires: true,
      }
      return bornesCache
    }
  } catch {
    /* fallback ci-dessous */
  }
  bornesCache = FALLBACK_BORNES
  return bornesCache
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/**
 * Serre une valeur d'effet dans la distribution PSD (échelle relative à une
 * pose de référence 100 px : les PSD travaillent des lettrages ~75-150 px,
 * on met à l'échelle linéairement avec la taille de police demandée).
 */
function clampPsd(valuePx: number, d: Distrib, fontPx: number): number {
  const scale = fontPx / 100
  return clamp(valuePx, d.min * scale, d.max * scale)
}

// ── le style de lettrage ─────────────────────────────────────────────────────

export type GradientStop = { color: string; location: number }

export type LettrageContour = {
  taillePx: number
  couleur?: string
  /** stroke fillType=gradient des PSD pros (rim doré du GTA de logo_gtanew) */
  gradient?: { stops: GradientStop[]; angle?: number }
  position?: 'outside' | 'inside'
}

export type LettrageStyle = {
  famille: string
  taillePx: number
  /** aplat — ignoré si gradient fourni */
  couleur?: string
  /** gradientOverlay PSD : stops exacts + angle (90 = bas→haut, convention PS) */
  gradient?: { stops: GradientStop[]; angle?: number }
  contour?: LettrageContour
  /** contours EMPILÉS (les PSD pros en superposent : gradient outside + blanc inside) */
  contours?: LettrageContour[]
  glow?: { taillePx: number; couleur: string; opacite: number }
  ombre?: { taillePx: number; distancePx: number; angleDeg?: number; couleur?: string; opacite?: number }
  /** biseau léger (médiane PSD = 0 : rarement utile) */
  biseau?: { taillePx: number }
  /** tracking PSD en 1/1000 em */
  tracking?: number
  /** italique synthétique (degrés) et élargissement (Druk-like) */
  skewX?: number
  scaleX?: number
}

export type LettrageRender = {
  png: Buffer
  width: number
  height: number
  /** boîte du texte hors effets (pour l'alignement dans la pile) */
  textBox: { left: number; top: number; width: number; height: number }
}

// ── rasterisation canvas d'une passe (fill / stroke / masque) ────────────────

type Pass = 'mask' | 'fill'

// NB : pas de strokeText ici — les statiques Google gardent des contours
// chevauchants (héritage variable font) que Skia stroke aussi À L'INTÉRIEUR
// des glyphes (artefacts constatés sur Unbounded, run 5.7). Les contours
// sont construits morphologiquement depuis le masque alpha (voir strokeBand).
function drawPass(opts: {
  texte: string
  font: FontEntry
  style: LettrageStyle
  W: number
  H: number
  ox: number
  oy: number
  pass: Pass
}): Buffer {
  const { texte, font, style, W, H, ox, oy, pass } = opts
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, W, H)
  applyTransform(ctx, style, font, ox, oy)
  ctx.font = `${style.taillePx}px "${font.css_family}"`
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = pass === 'mask' ? '#ffffff' : fillStyleFor(ctx, texte, style)

  const tracking = style.tracking ?? 0
  if (!tracking) {
    ctx.fillText(texte, 0, 0)
  } else {
    // tracking PSD (1/1000 em) : avance manuelle caractère par caractère
    const extra = (tracking / 1000) * style.taillePx
    let x = 0
    for (const ch of texte) {
      ctx.fillText(ch, x, 0)
      x += ctx.measureText(ch).width + extra
    }
  }
  return canvas.toBuffer('image/png')
}

// ── morphologie alpha : dilatation/érosion en niveaux de gris (max/min 3×3) ──

function morphAlpha(alpha: Uint8Array, W: number, H: number, radius: number, mode: 'dilate' | 'erode'): Uint8Array {
  let src = alpha
  const pick = mode === 'dilate' ? Math.max : Math.min
  for (let it = 0; it < radius; it++) {
    const dst = new Uint8Array(W * H)
    // passe horizontale puis verticale (élément séparable ≈ boule octogonale)
    for (let y = 0; y < H; y++) {
      const row = y * W
      for (let x = 0; x < W; x++) {
        let v = src[row + x]!
        if (x > 0) v = pick(v, src[row + x - 1]!)
        if (x < W - 1) v = pick(v, src[row + x + 1]!)
        dst[row + x] = v
      }
    }
    const dst2 = new Uint8Array(W * H)
    for (let y = 0; y < H; y++) {
      const row = y * W
      for (let x = 0; x < W; x++) {
        let v = dst[row + x]!
        if (y > 0) v = pick(v, dst[row + x - W]!)
        if (y < H - 1) v = pick(v, dst[row + x + W]!)
        dst2[row + x] = v
      }
    }
    src = dst2
  }
  return src
}

/** Bande de contour (outside : dilaté − masque ; inside : masque − érodé),
 *  teintée en aplat ou remplie d'un gradient linéaire (stroke fillType=gradient PSD). */
async function strokeBand(
  mask: Buffer,
  opts: { W: number; H: number; radius: number; color?: string; gradient?: { stops: GradientStop[]; angle?: number }; position: 'outside' | 'inside' }
): Promise<Buffer> {
  const { W, H, radius, position } = opts
  const { data } = await sharp(mask).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const alpha = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) alpha[i] = data[i * 4 + 3]!
  const morphed = morphAlpha(alpha, W, H, radius, position === 'outside' ? 'dilate' : 'erode')
  const bandAlpha = Buffer.alloc(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    bandAlpha[i * 4 + 3] = position === 'outside' ? Math.max(0, morphed[i]! - alpha[i]!) : Math.max(0, alpha[i]! - morphed[i]!)
  }

  if (opts.gradient?.stops?.length) {
    // remplissage gradient : rect SVG plein cadre découpé par la bande.
    // Convention PS : angle 90 = bas → haut, le stop location 0 est en BAS.
    const rad = (((opts.gradient.angle ?? 90) - 90) * Math.PI) / 180
    const dx = Math.sin(rad) / 2
    const dy = Math.cos(rad) / 2
    const stops = opts.gradient.stops
      .map((s) => `<stop offset="${clamp(s.location, 0, 1)}" stop-color="${s.color}"/>`)
      .join('')
    const svg =
      `<svg width="${W}" height="${H}"><defs><linearGradient id="g" x1="${0.5 - dx}" y1="${0.5 + dy}" x2="${0.5 + dx}" y2="${0.5 - dy}">${stops}</linearGradient></defs>` +
      `<rect width="${W}" height="${H}" fill="url(#g)"/></svg>`
    const bandPng = await sharp(bandAlpha, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()
    return sharp(Buffer.from(svg)).png().composite([{ input: bandPng, blend: 'dest-in' }]).png().toBuffer()
  }

  const { r, g, b } = hexToRgb(opts.color ?? '#ffffff')
  for (let i = 0; i < W * H; i++) {
    bandAlpha[i * 4] = r
    bandAlpha[i * 4 + 1] = g
    bandAlpha[i * 4 + 2] = b
  }
  return sharp(bandAlpha, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()
}

function applyTransform(ctx: SKRSContext2D, style: LettrageStyle, font: FontEntry, ox: number, oy: number): void {
  const scaleX = style.scaleX ?? font.scaleX ?? 1
  const skew = ((style.skewX ?? font.skewX ?? 0) * Math.PI) / 180
  ctx.translate(ox, oy)
  ctx.transform(scaleX, 0, -Math.tan(skew), 1, 0, 0)
}

function fillStyleFor(ctx: SKRSContext2D, texte: string, style: LettrageStyle): string | ReturnType<SKRSContext2D['createLinearGradient']> {
  if (!style.gradient?.stops?.length) return style.couleur ?? '#ffffff'
  const w = ctx.measureText(texte).width
  const h = style.taillePx
  // convention Photoshop : angle 90 = bas → haut, le stop location 0 est en BAS.
  // Étendue = PROJECTION de la boîte du texte sur la direction du gradient —
  // pas max(w,h), qui écrasait un 45° en teinte quasi unie sur la hauteur des
  // lettres (constaté iter1-57-fruitz-semi).
  const rad = (((style.gradient.angle ?? 90) - 90) * Math.PI) / 180
  const cx = w / 2
  const cy = -h * 0.35
  const ext = (Math.abs(Math.sin(rad)) * w + Math.abs(Math.cos(rad)) * h) / 2
  const dx = Math.sin(rad) * ext
  const dy = Math.cos(rad) * ext
  const g = ctx.createLinearGradient(cx - dx, cy + dy, cx + dx, cy - dy)
  for (const s of style.gradient.stops) g.addColorStop(clamp(s.location, 0, 1), s.color)
  return g
}

// ── helpers sharp : teinte par masque, opacité, offset ───────────────────────

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = hex.replace('#', '')
  const v = m.length === 3 ? m.split('').map((c) => c + c).join('') : m
  return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16) }
}

/** Couche colorée découpée par l'alpha d'un masque (optionnellement flouté). */
async function tintedFromMask(mask: Buffer, opts: { W: number; H: number; color: string; opacity: number; blur?: number }): Promise<Buffer> {
  let m = sharp(mask)
  if (opts.blur && opts.blur >= 0.3) m = m.blur(opts.blur)
  const blurred = await m.png().toBuffer()
  const { r, g, b } = hexToRgb(opts.color)
  return sharp({
    create: { width: opts.W, height: opts.H, channels: 4, background: { r, g, b, alpha: clamp(opts.opacity, 0, 1) } },
  })
    .composite([{ input: blurred, blend: 'dest-in' }])
    .png()
    .toBuffer()
}

// ── le rendu complet ─────────────────────────────────────────────────────────

export async function renderLettrage(texte: string, style: LettrageStyle): Promise<LettrageRender> {
  if (!texte.trim()) throw new Error('lettrage vide')
  const font = resolveFont(style.famille)
  if (!font) throw new Error(`police inconnue : ${style.famille} (voir fonts-map.json)`)

  const bornes = psdBornes()
  const fontPx = style.taillePx

  // contours : `contour` simple et `contours` empilés fusionnés en une liste,
  // chaque taille serrée dans la distribution PSD — jamais de valeurs inventées
  const contours = [...(style.contour ? [style.contour] : []), ...(style.contours ?? [])]
    .map((c) => ({ ...c, radius: Math.round(clampPsd(c.taillePx, bornes.stroke, fontPx)) }))
    .filter((c) => c.radius > 0)
  const strokePx = contours.reduce((m, c) => Math.max(m, c.radius), 0)
  const glowPx = style.glow ? Math.round(clampPsd(style.glow.taillePx, bornes.outerGlow, fontPx)) : 0
  const shadowPx = style.ombre ? Math.round(clampPsd(style.ombre.taillePx, bornes.dropShadowSize, fontPx)) : 0
  const shadowDist = style.ombre ? Math.round(clampPsd(style.ombre.distancePx, bornes.dropShadowDistance, fontPx)) : 0
  const bevelPx = style.biseau ? Math.round(clampPsd(style.biseau.taillePx, bornes.bevel, fontPx)) : 0

  // mesure du texte (canvas jetable)
  const probe = createCanvas(8, 8).getContext('2d')
  loadFonts()
  probe.font = `${fontPx}px "${font.css_family}"`
  const metrics = probe.measureText(texte)
  const tracking = ((style.tracking ?? 0) / 1000) * fontPx * Math.max(0, texte.length - 1)
  const scaleX = style.scaleX ?? font.scaleX ?? 1
  const skewPad = Math.abs(Math.tan((((style.skewX ?? font.skewX ?? 0) as number) * Math.PI) / 180)) * fontPx
  const textW = (metrics.width + tracking) * scaleX + skewPad
  const ascent = metrics.actualBoundingBoxAscent || fontPx * 0.8
  const descent = metrics.actualBoundingBoxDescent || fontPx * 0.25
  const textH = ascent + descent

  const pad = Math.ceil(Math.max(strokePx * 2, glowPx * 2.5, shadowPx + shadowDist, bevelPx, 8))
  const W = Math.ceil(textW + pad * 2)
  const H = Math.ceil(textH + pad * 2)
  const ox = pad
  const oy = pad + ascent

  const passArgs = { texte, font, style, W, H, ox, oy }
  const mask = drawPass({ ...passArgs, pass: 'mask' })
  const fill = drawPass({ ...passArgs, pass: 'fill' })

  const overlays: OverlayOptions[] = []

  // 1. drop shadow (tout en dessous)
  if (style.ombre && shadowPx > 0) {
    const angle = ((style.ombre.angleDeg ?? 90) * Math.PI) / 180
    const dx = Math.round(-Math.sin(angle - Math.PI / 2) * shadowDist)
    const dy = Math.round(Math.cos(angle - Math.PI / 2) * shadowDist)
    const layer = await tintedFromMask(mask, {
      W, H,
      color: style.ombre.couleur ?? '#000000',
      opacity: style.ombre.opacite ?? 0.52, // médiane PSD
      blur: shadowPx / 2.5,
    })
    overlays.push({ input: layer, left: dx, top: dy })
  }

  // 2. outer glow
  if (style.glow && glowPx > 0) {
    const layer = await tintedFromMask(mask, {
      W, H,
      color: style.glow.couleur,
      opacity: clamp(style.glow.opacite, 0, 1),
      blur: glowPx / 2,
    })
    overlays.push({ input: layer }, { input: layer }) // double passe = choke doux
  }

  // 3. contours extérieurs (bandes morphologiques sous le fill, du plus large au plus fin)
  for (const c of contours.filter((c) => (c.position ?? 'outside') === 'outside').sort((a, b) => b.radius - a.radius)) {
    overlays.push({ input: await strokeBand(mask, { W, H, radius: c.radius, color: c.couleur, gradient: c.gradient, position: 'outside' }) })
  }

  // 4. le fill (gradient overlay ou aplat)
  overlays.push({ input: fill })

  // 5. contours intérieurs (bandes morphologiques sur le fill, du plus large au plus fin)
  for (const c of contours.filter((c) => c.position === 'inside').sort((a, b) => b.radius - a.radius)) {
    overlays.push({ input: await strokeBand(mask, { W, H, radius: c.radius, color: c.couleur, gradient: c.gradient, position: 'inside' }) })
  }

  // 6. biseau léger : lumière haute + assise basse, intersectées au masque
  if (style.biseau && bevelPx > 0) {
    const hi = await sharp(
      await tintedFromMask(mask, { W, H, color: '#ffffff', opacity: 0.5, blur: bevelPx / 2 })
    )
      .extract({ left: 0, top: Math.min(bevelPx, H - 1), width: W, height: H - Math.min(bevelPx, H - 1) })
      .extend({ bottom: Math.min(bevelPx, H - 1), background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .composite([{ input: mask, blend: 'dest-in' }])
      .png()
      .toBuffer()
    const lo = await sharp(
      await tintedFromMask(mask, { W, H, color: '#000000', opacity: 0.35, blur: bevelPx / 2 })
    )
      .extract({ left: 0, top: 0, width: W, height: H - Math.min(bevelPx, H - 1) })
      .extend({ top: Math.min(bevelPx, H - 1), background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .composite([{ input: mask, blend: 'dest-in' }])
      .png()
      .toBuffer()
    overlays.push({ input: hi, blend: 'soft-light' }, { input: lo, blend: 'soft-light' })
  }

  const png = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(overlays)
    .png()
    .toBuffer()

  return {
    png,
    width: W,
    height: H,
    textBox: { left: pad, top: pad, width: Math.ceil(textW), height: Math.ceil(textH) },
  }
}
