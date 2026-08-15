import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import sharp, { type OverlayOptions } from 'sharp'
import satori from 'satori'
import type { Layer } from './layers'

// Compositing serveur (run 5, LOT 5) — l'export rend EXACTEMENT ce que
// l'éditeur affiche : mêmes calques normalisés, mêmes polices (satori rend
// le texte en chemins vectoriels — aucune dépendance aux polices système),
// mêmes blend modes. Le texte n'est JAMAIS généré par l'IA : il est
// rasterisé ici, à la résolution d'export.

const FONTS_DIR = resolve(import.meta.dir, '../../engine/fonts')
const EFFECTS_DIR = resolve(import.meta.dir, '../../engine/effects')

type SatoriFont = { name: string; data: Buffer; weight: number; style: 'normal' }

let fontsCache: SatoriFont[] | null = null
function loadFonts(): SatoriFont[] {
  if (fontsCache) return fontsCache
  fontsCache = [
    { name: 'Archivo Black', data: readFileSync(join(FONTS_DIR, 'archivo-black.ttf')), weight: 400, style: 'normal' },
    { name: 'Bebas Neue', data: readFileSync(join(FONTS_DIR, 'bebas-neue.ttf')), weight: 400, style: 'normal' },
    { name: 'Anton', data: readFileSync(join(FONTS_DIR, 'anton.ttf')), weight: 400, style: 'normal' },
    { name: 'Oswald', data: readFileSync(join(FONTS_DIR, 'oswald.ttf')), weight: 500, style: 'normal' },
    { name: 'Montserrat', data: readFileSync(join(FONTS_DIR, 'montserrat.ttf')), weight: 600, style: 'normal' },
  ]
  return fontsCache
}

const FONT_NAME_BY_ID: Record<string, string> = {
  'archivo-black': 'Archivo Black',
  'bebas-neue': 'Bebas Neue',
  anton: 'Anton',
  oswald: 'Oswald',
  montserrat: 'Montserrat',
}

const BLEND_MAP: Record<string, 'over' | 'screen' | 'multiply' | 'overlay'> = {
  normal: 'over',
  screen: 'screen',
  multiply: 'multiply',
  overlay: 'overlay',
}

async function fetchBuffer(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch {
    return null
  }
}

function effectFile(effectId: string): Buffer | null {
  try {
    if (!/^[a-z-]+$/.test(effectId)) return null
    return readFileSync(join(EFFECTS_DIR, `${effectId}.png`))
  } catch {
    return null
  }
}

// Rend un calque texte en PNG via satori (glyphes vectorisés), puis trim.
async function renderTextLayer(layer: Layer, canvasWidth: number, canvasHeight: number): Promise<Buffer | null> {
  const rawText = layer.text ?? ''
  const text = layer.uppercase ? rawText.toUpperCase() : rawText
  if (!text.trim()) return null

  const fontSize = Math.max(6, (layer.sizeRel ?? 0.1) * canvasHeight)
  const fontFamily = FONT_NAME_BY_ID[layer.font ?? 'archivo-black'] ?? 'Archivo Black'
  const strokeW = layer.strokeWidth ? layer.strokeWidth * fontSize : 0

  const style: Record<string, unknown> = {
    display: 'flex',
    fontFamily,
    fontSize: `${fontSize}px`,
    fontWeight: layer.weight ?? 700,
    lineHeight: 1.04,
    letterSpacing: `${(layer.letterSpacing ?? 0) * fontSize}px`,
    whiteSpace: 'pre',
    textAlign: layer.align ?? 'center',
    color: layer.color ?? '#FFFFFF',
  }
  if (layer.gradient) {
    style.backgroundImage = `linear-gradient(${layer.gradient.angle}deg, ${layer.gradient.from}, ${layer.gradient.to})`
    style.backgroundClip = 'text'
    style.color = 'transparent'
  }
  if (layer.shadow) {
    // les offsets d'ombre sont exprimés en px d'éditeur ~1080p : on met à
    // l'échelle du canvas d'export
    const scaleFactor = canvasHeight / 1080
    style.textShadow = `${layer.shadow.x * scaleFactor}px ${layer.shadow.y * scaleFactor}px ${layer.shadow.blur * scaleFactor}px ${layer.shadow.color}`
  }
  if (strokeW > 0 && layer.strokeColor) {
    style.WebkitTextStrokeWidth = `${strokeW}px`
    style.WebkitTextStrokeColor = layer.strokeColor
  }

  const lines = text.split('\n').length
  const boxWidth = Math.ceil(canvasWidth * 2.4)
  const boxHeight = Math.ceil(fontSize * 1.35 * lines + fontSize)

  const svg = await satori(
    {
      type: 'div',
      props: {
        style: {
          width: `${boxWidth}px`,
          height: `${boxHeight}px`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        },
        children: { type: 'div', props: { style, children: text } },
      },
    } as never,
    { width: boxWidth, height: boxHeight, fonts: loadFonts() as never }
  )

  return sharp(Buffer.from(svg)).png().trim({ threshold: 4 }).toBuffer()
}

// Multiplie le canal alpha par l'opacité du calque.
async function applyOpacity(buffer: Buffer, opacity: number): Promise<Buffer> {
  if (opacity >= 0.995) return buffer
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  for (let p = 3; p < data.length; p += 4) {
    data[p] = Math.round(data[p]! * opacity)
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer()
}

// Rogne le calque à l'intersection avec le canvas (sharp refuse les
// composites qui débordent).
async function clipToCanvas(
  buffer: Buffer,
  left: number,
  top: number,
  canvasWidth: number,
  canvasHeight: number
): Promise<{ buffer: Buffer; left: number; top: number } | null> {
  const meta = await sharp(buffer).metadata()
  const w = meta.width ?? 0
  const h = meta.height ?? 0
  const visibleLeft = Math.max(left, 0)
  const visibleTop = Math.max(top, 0)
  const visibleRight = Math.min(left + w, canvasWidth)
  const visibleBottom = Math.min(top + h, canvasHeight)
  if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) return null
  if (visibleLeft === left && visibleTop === top && visibleRight - visibleLeft === w && visibleBottom - visibleTop === h) {
    return { buffer, left, top }
  }
  const clipped = await sharp(buffer)
    .extract({
      left: visibleLeft - left,
      top: visibleTop - top,
      width: visibleRight - visibleLeft,
      height: visibleBottom - visibleTop,
    })
    .png()
    .toBuffer()
  return { buffer: clipped, left: visibleLeft, top: visibleTop }
}

export type LogoMasterUrls = {
  url: string
  whiteUrl?: string | null
  blackUrl?: string | null
} | null

export async function composeAsset(opts: {
  layers: Layer[]
  logoMaster: LogoMasterUrls
  width: number
  height: number
  // remplace l'url du calque scène (re-rendu haute résolution à l'export)
  sceneOverrideUrl?: string | null
}): Promise<Buffer> {
  const { layers, logoMaster, width, height } = opts

  const composites: OverlayOptions[] = []

  for (const layer of layers) {
    if (layer.hidden) continue

    let source: Buffer | null = null
    if (layer.type === 'text') {
      source = await renderTextLayer(layer, width, height)
    } else if (layer.type === 'effect' || layer.type === 'grain') {
      source = layer.effectId ? effectFile(layer.effectId) : null
    } else if (layer.type === 'logo') {
      const url =
        layer.variant === 'white' && logoMaster?.whiteUrl
          ? logoMaster.whiteUrl
          : layer.variant === 'black' && logoMaster?.blackUrl
            ? logoMaster.blackUrl
            : logoMaster?.url ?? layer.url
      source = url ? await fetchBuffer(url) : null
    } else {
      const url = layer.type === 'scene' && opts.sceneOverrideUrl ? opts.sceneOverrideUrl : layer.url
      source = url ? await fetchBuffer(url) : null
    }
    if (!source) continue

    // Dimensionnement : scale = largeur relative au canvas.
    // Les textes sortent de satori déjà à l'échelle du canvas — pas de resize.
    let sized: Buffer
    if (layer.type === 'text') {
      sized = source
    } else {
      const meta = await sharp(source).metadata()
      const aspect = layer.aspect ?? (meta.width && meta.height ? meta.width / meta.height : 1)
      const targetW = Math.max(2, Math.round(layer.scale * width))
      const targetH = Math.max(2, Math.round(targetW / aspect))
      sized = await sharp(source).resize(targetW, targetH, { fit: 'fill' }).png().toBuffer()
    }

    // Rotation autour du centre (le cadre s'agrandit, le centre reste fixe)
    if (layer.rotation) {
      sized = await sharp(sized)
        .rotate(layer.rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer()
    }

    sized = await applyOpacity(sized, layer.opacity)

    const meta = await sharp(sized).metadata()
    const left = Math.round(layer.x * width - (meta.width ?? 0) / 2)
    const top = Math.round(layer.y * height - (meta.height ?? 0) / 2)

    const clipped = await clipToCanvas(sized, left, top, width, height)
    if (!clipped) continue

    composites.push({
      input: clipped.buffer,
      left: clipped.left,
      top: clipped.top,
      blend: BLEND_MAP[layer.blend] ?? 'over',
    })
  }

  return sharp({
    create: { width, height, channels: 4, background: { r: 8, g: 8, b: 12, alpha: 1 } },
  })
    .composite(composites)
    .png()
    .toBuffer()
}

// Manifest des effets maison (servi au front par /engine/effects)
export function effectsManifest(): Array<{ id: string; label: string; blend: string; opacity: number }> {
  try {
    return JSON.parse(readFileSync(join(EFFECTS_DIR, 'manifest.json'), 'utf-8'))
  } catch {
    return []
  }
}

export function effectFileBuffer(effectId: string): Buffer | null {
  return effectFile(effectId)
}
