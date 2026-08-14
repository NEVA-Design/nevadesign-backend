import sharp from 'sharp'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getAspectRatio, type AspectRatioId } from './ai/aspect-ratios'

const WATERMARK_TEXT = 'Generated with Neva AI'

function escapeSvg(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function outputDimensions(width: number, height: number, aspectRatio: AspectRatioId) {
  const ratio = getAspectRatio(aspectRatio)
  const target = ratio.w / ratio.h
  const current = width / height

  if (Math.abs(current - target) < 0.002) {
    return { width, height }
  }

  if (current > target) {
    return { width: Math.round(height * target), height }
  }

  return { width, height: Math.round(width / target) }
}

function watermarkSvg(width: number, height: number) {
  const padding = Math.max(18, Math.round(Math.min(width, height) * 0.035))
  const fontSize = Math.max(18, Math.round(Math.min(width, height) * 0.032))
  const text = escapeSvg(WATERMARK_TEXT)

  return Buffer.from(`
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <style>
        .wm {
          font-family: Inter, Geist, Arial, sans-serif;
          font-size: ${fontSize}px;
          font-weight: 600;
          letter-spacing: 0;
          fill: rgba(255,255,255,0.27);
          paint-order: stroke;
          stroke: rgba(16,12,36,0.34);
          stroke-width: ${Math.max(2, Math.round(fontSize * 0.12))}px;
          stroke-linejoin: round;
        }
      </style>
      <text class="wm" x="${width - padding}" y="${height - padding}" text-anchor="end" dominant-baseline="text-after-edge">${text}</text>
    </svg>
  `)
}

export async function normalizeGeneratedImage({
  imageBase64,
  aspectRatio,
  watermark,
}: {
  imageBase64: string
  aspectRatio: AspectRatioId
  watermark: boolean
}) {
  const base64 = imageBase64.includes(',') ? imageBase64.split(',').pop() ?? imageBase64 : imageBase64
  const input = Buffer.from(base64, 'base64')
  const metadata = await sharp(input).metadata()

  if (!metadata.width || !metadata.height) {
    return imageBase64
  }

  const dimensions = outputDimensions(metadata.width, metadata.height, aspectRatio)
  let pipeline = sharp(input)
    .rotate()
    .resize({
      width: dimensions.width,
      height: dimensions.height,
      fit: 'cover',
      position: 'attention',
    })
    .webp({ quality: 96, effort: 5 })

  if (watermark) {
    pipeline = pipeline.composite([
      {
        input: watermarkSvg(dimensions.width, dimensions.height),
        top: 0,
        left: 0,
      },
    ])
  }

  const output = await pipeline.toBuffer()
  return `data:image/webp;base64,${output.toString('base64')}`
}

export async function applyWatermarkToImage(imageBase64: string) {
  const base64 = imageBase64.includes(',') ? imageBase64.split(',').pop() ?? imageBase64 : imageBase64
  const input = Buffer.from(base64, 'base64')
  const metadata = await sharp(input).metadata()

  if (!metadata.width || !metadata.height) {
    return imageBase64
  }

  const output = await sharp(input)
    .rotate()
    .composite([
      {
        input: watermarkSvg(metadata.width, metadata.height),
        top: 0,
        left: 0,
      },
    ])
    .webp({ quality: 96, effort: 5 })
    .toBuffer()

  return `data:image/webp;base64,${output.toString('base64')}`
}

export async function userNeedsWatermark(service: SupabaseClient, userId: string) {
  const { data } = await service.from('profiles').select('plan').eq('id', userId).single()
  return (data?.plan ?? 'free') === 'free'
}
