import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import sharp, { type OverlayOptions } from 'sharp'
import { stripLegacyTextLayers, type Layer } from './layers'

// Compositing serveur (run 5.2, LOT 4) — l'export rend EXACTEMENT ce que
// l'éditeur affiche : mêmes calques normalisés, mêmes blend modes (portés
// par les effets maison), même masque de gomme.
// Le rendu de texte système (satori + polices) a été SUPPRIMÉ au run 5.2 :
// le lettrage est généré dans le calque héro par le moteur. Les calques
// 'text' résiduels d'anciens assets sont filtrés à l'entrée.

const EFFECTS_DIR = resolve(import.meta.dir, '../../engine/effects')

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

// Multiplie le canal alpha par l'opacité du calque.
async function applyOpacity(buffer: Buffer, opacity: number): Promise<Buffer> {
  if (opacity >= 0.995) return buffer
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  for (let p = 3; p < data.length; p += 4) {
    data[p] = Math.round(data[p]! * opacity)
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer()
}

// Gomme non destructive : multiplie l'alpha du calque par l'alpha du masque
// (blanc opaque = visible, transparent = effacé). Le masque est peint dans
// l'éditeur à la résolution du rendu — on le remet à l'échelle du calque.
async function applyMask(buffer: Buffer, maskUrl: string): Promise<Buffer> {
  const maskSource = await fetchBuffer(maskUrl)
  if (!maskSource) return buffer

  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const mask = await sharp(maskSource)
    .resize(info.width, info.height, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  for (let p = 0; p < info.width * info.height; p++) {
    const alphaIdx = p * 4 + 3
    data[alphaIdx] = Math.round((data[alphaIdx]! * mask.data[alphaIdx]!) / 255)
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
  const { logoMaster, width, height } = opts
  const layers = stripLegacyTextLayers(opts.layers)

  const composites: OverlayOptions[] = []

  for (const layer of layers) {
    if (layer.hidden) continue

    let source: Buffer | null = null
    if (layer.type === 'effect' || layer.type === 'grain') {
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
    const meta = await sharp(source).metadata()
    const aspect = layer.aspect ?? (meta.width && meta.height ? meta.width / meta.height : 1)
    const targetW = Math.max(2, Math.round(layer.scale * width))
    const targetH = Math.max(2, Math.round(targetW / aspect))
    let sized: Buffer = await sharp(source).resize(targetW, targetH, { fit: 'fill' }).png().toBuffer()

    if (layer.maskUrl) {
      sized = await applyMask(sized, layer.maskUrl)
    }

    // Rotation autour du centre (le cadre s'agrandit, le centre reste fixe)
    if (layer.rotation) {
      sized = await sharp(sized)
        .rotate(layer.rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer()
    }

    sized = await applyOpacity(sized, layer.opacity)

    const sizedMeta = await sharp(sized).metadata()
    const left = Math.round(layer.x * width - (sizedMeta.width ?? 0) / 2)
    const top = Math.round(layer.y * height - (sizedMeta.height ?? 0) / 2)

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
