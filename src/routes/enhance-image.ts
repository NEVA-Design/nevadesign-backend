import { Elysia } from 'elysia'
import sharp from 'sharp'
import { getModuleContract } from '../lib/ai/orchestrator'
import {
  checkRateLimit,
  jsonError,
  sanitizeText,
  securityLog,
  validateUploadedImage,
} from '../lib/security'
import { requireUser, isResponse } from '../lib/require-auth'
import { deductCredits } from '../lib/credits'
import { applyWatermarkToImage, userNeedsWatermark } from '../lib/image-postprocess'

type SourceImage = { data: string; mimeType: string }
type EnhanceMode = 'polish' | 'luxury' | 'marketing' | 'character_restore' | 'studio_finish'
type UpscaleTarget = '2k' | '4k' | '8k'

const ENHANCE_COST = 2

const LONG_EDGE_BY_TARGET: Record<UpscaleTarget, number> = {
  '2k': 2048,
  '4k': 3840,
  '8k': 7680,
}

const MODE_SETTINGS: Record<EnhanceMode, {
  brightness: number
  saturation: number
  gamma: number
  contrast: number
  sharpenSigma: number
  sharpenM1: number
  sharpenM2: number
  sharpenX1: number
  tint?: { r: number; g: number; b: number }
  normaliseUpper: number
}> = {
  polish: {
    brightness: 1.035,
    saturation: 1.12,
    gamma: 1.01,
    contrast: 1.12,
    sharpenSigma: 1.15,
    sharpenM1: 0.9,
    sharpenM2: 1.45,
    sharpenX1: 1.4,
    normaliseUpper: 98.8,
  },
  luxury: {
    brightness: 0.99,
    saturation: 1.1,
    gamma: 1.0,
    contrast: 1.16,
    sharpenSigma: 1.08,
    sharpenM1: 0.82,
    sharpenM2: 1.35,
    sharpenX1: 1.3,
    tint: { r: 255, g: 238, b: 210 },
    normaliseUpper: 98.7,
  },
  marketing: {
    brightness: 1.05,
    saturation: 1.18,
    gamma: 0.99,
    contrast: 1.2,
    sharpenSigma: 1.2,
    sharpenM1: 0.95,
    sharpenM2: 1.55,
    sharpenX1: 1.5,
    normaliseUpper: 98.45,
  },
  character_restore: {
    brightness: 1.025,
    saturation: 1.08,
    gamma: 1.01,
    contrast: 1.1,
    sharpenSigma: 0.95,
    sharpenM1: 0.72,
    sharpenM2: 1.15,
    sharpenX1: 1.2,
    normaliseUpper: 99.0,
  },
  studio_finish: {
    brightness: 1.04,
    saturation: 1.14,
    gamma: 1.0,
    contrast: 1.18,
    sharpenSigma: 1.22,
    sharpenM1: 0.98,
    sharpenM2: 1.58,
    sharpenX1: 1.5,
    tint: { r: 246, g: 242, b: 255 },
    normaliseUpper: 98.55,
  },
}

function isEnhanceMode(value: unknown): value is EnhanceMode {
  return typeof value === 'string' && value in MODE_SETTINGS
}

function isUpscaleTarget(value: unknown): value is UpscaleTarget {
  return typeof value === 'string' && value in LONG_EDGE_BY_TARGET
}

function getTargetSize(width: number, height: number, target: UpscaleTarget) {
  const longEdge = LONG_EDGE_BY_TARGET[target]
  const sourceLongEdge = Math.max(width, height)

  const finalLongEdge = Math.max(sourceLongEdge, longEdge)
  const scale = finalLongEdge / sourceLongEdge

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export const enhanceImageRoutes = new Elysia({ prefix: '/enhance-image' })
  .post('/', async ({ request }) => {
    try {
      const auth = await requireUser(request)
      if (isResponse(auth)) return auth
      const { user, supabase } = auth

      const contract = getModuleContract('enhance')
      const rate = checkRateLimit(`enhance:${user.id}`, contract.rateLimitPerMinute)
      if (!rate.ok) {
        securityLog('rate_limited', { userId: user.id, module: 'enhance' })
        return jsonError('rate_limited', 429)
      }

      const {
        sourceImage,
        mode = 'polish',
        upscale = '2k',
        options = [],
        notes = '',
      } = await request.json() as {
        sourceImage?: SourceImage | null
        mode?: unknown
        upscale?: unknown
        options?: string[]
        notes?: string
      }

      const validatedSource = validateUploadedImage(sourceImage, 'source_image')
      if (!validatedSource.ok) return jsonError(validatedSource.error, 400)

      if (!isEnhanceMode(mode)) {
        return Response.json({ error: 'Mode invalide' }, { status: 400 })
      }

      if (!isUpscaleTarget(upscale)) {
        return Response.json({ error: 'Upscale invalide' }, { status: 400 })
      }

      const safeNotes = sanitizeText(notes, contract.maxInputChars)
      const safeOptions = Array.isArray(options) ? options.filter(option => typeof option === 'string').slice(0, 12) : []
      const input = Buffer.from(validatedSource.image.data, 'base64')
      const image = sharp(input, { failOn: 'none', limitInputPixels: false }).rotate()
      const metadata = await image.metadata()

      if (!metadata.width || !metadata.height) {
        return Response.json({ error: 'Image invalide' }, { status: 400 })
      }

      const target = getTargetSize(metadata.width, metadata.height, upscale)
      const settings = MODE_SETTINGS[mode]
      const enabled = new Set(safeOptions)
      const allOptionsEnabled = enabled.size === 0 || safeOptions.length >= 6
      const hasNotes = safeNotes.length > 0

      let pipeline = image.resize({
        width: target.width,
        height: target.height,
        fit: 'fill',
        kernel: sharp.kernel.lanczos3,
        withoutEnlargement: false,
      })

      if (enabled.has('lighting') || enabled.has('color_grading') || allOptionsEnabled) {
        pipeline = pipeline.modulate({
          brightness: settings.brightness,
          saturation: settings.saturation,
        }).gamma(settings.gamma)
      }

      if (enabled.has('shadows') || enabled.has('marketing_polish') || enabled.has('lighting') || allOptionsEnabled) {
        pipeline = pipeline.normalise({ lower: 1.2, upper: settings.normaliseUpper })
      }

      if (enabled.has('color_grading') || enabled.has('marketing_polish') || enabled.has('luxury_branding') || allOptionsEnabled) {
        pipeline = pipeline.linear(settings.contrast, 128 * (1 - settings.contrast))
      }

      if (settings.tint && (enabled.has('color_grading') || enabled.has('luxury_branding') || mode === 'luxury' || mode === 'studio_finish')) {
        pipeline = pipeline.tint(settings.tint)
      }

      if (enabled.has('depth') || enabled.has('marketing_polish') || enabled.has('luxury_branding') || allOptionsEnabled) {
        pipeline = pipeline.median(mode === 'character_restore' ? 1 : 2)
      }

      if (enabled.has('upscaling') || enabled.has('face_restoration') || enabled.has('character_preservation') || enabled.has('marketing_polish') || allOptionsEnabled) {
        pipeline = pipeline.sharpen({
          sigma: settings.sharpenSigma,
          m1: settings.sharpenM1,
          m2: settings.sharpenM2,
          x1: settings.sharpenX1,
          y2: 14,
          y3: 26,
        })
      }

      if (hasNotes || enabled.has('marketing_polish') || mode === 'marketing' || mode === 'studio_finish') {
        pipeline = pipeline.modulate({
          brightness: mode === 'luxury' ? 0.995 : 1.015,
          saturation: mode === 'marketing' ? 1.06 : 1.035,
        })
      }

      const output = await pipeline
        .webp({
          quality: upscale === '8k' ? 94 : 96,
          effort: 5,
          smartSubsample: true,
        })
        .toBuffer()

      const deduction = await deductCredits(
        supabase,
        user.id,
        ENHANCE_COST,
        'image_enhancement',
        `Neva Enhance - ${mode} - ${upscale.toUpperCase()}`
      )

      if (!deduction.success) {
        return Response.json(
          {
            success: false,
            error: { code: 'insufficient_credits', message: 'Créations disponibles insuffisantes. Recharge dans Billing.' },
            remaining: deduction.remaining,
          },
          { status: 402 }
        )
      }

      const cleanImage = `data:image/webp;base64,${output.toString('base64')}`
      const watermarkEnabled = await userNeedsWatermark(supabase, user.id)
      const finalImage = watermarkEnabled ? await applyWatermarkToImage(cleanImage) : cleanImage

      return Response.json({
        success: true,
        data: {
          image: finalImage,
          mode,
          upscale,
          upscaleApplied: upscale,
          width: target.width,
          height: target.height,
          originalWidth: metadata.width,
          originalHeight: metadata.height,
          creditsUsed: ENHANCE_COST,
          watermarkEnabled,
          enhancedPrompt: 'Upscale propre, contraste local, ombres plus lisibles, couleurs stabilisées et netteté contrôlée sans modifier la composition source.',
        },
        image: finalImage,
        mode,
        upscale,
        upscaleApplied: upscale,
        width: target.width,
        height: target.height,
        originalWidth: metadata.width,
        originalHeight: metadata.height,
        creditsUsed: ENHANCE_COST,
        watermarkEnabled,
        enhancedPrompt: 'Upscale propre, contraste local, ombres plus lisibles, couleurs stabilisées et netteté contrôlée sans modifier la composition source.',
      })
    } catch (error: unknown) {
      const e = error as { message?: string; status?: number }
      console.error('[enhance-image] error:', e?.status, e?.message)
      return jsonError('enhance_failed', 500, "L'amélioration a échoué. Aucune création n'a été utilisée.")
    }
  })
