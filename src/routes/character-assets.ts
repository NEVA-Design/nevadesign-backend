import { Elysia } from 'elysia'
import { getModuleContract } from '../lib/ai/orchestrator'
import { getAspectRatioInstruction, type AspectRatioId } from '../lib/ai/aspect-ratios'
import { geminiImageEdit } from '../lib/ai/gemini'
import {
  checkRateLimit,
  hasPromptInjectionRisk,
  jsonError,
  sanitizeText,
  securityLog,
  validateUploadedImage,
} from '../lib/security'
import { requireUser, isResponse } from '../lib/require-auth'
import { deductCredits } from '../lib/credits'
import { buildNevaBrainContext } from '../lib/neva-brain'
import { applyWatermarkToImage, userNeedsWatermark } from '../lib/image-postprocess'

type SourceImage = { data: string; mimeType: string }
type CharacterAssetType =
  | 'rp_identity_card'
  | 'passport'
  | 'driver_license'
  | 'criminal_record'
  | 'police_file'
  | 'employee_file'
  | 'business_profile'
  | 'character_poster'
  | 'studio_portrait'

const CHARACTER_COST = 2
const IMAGE_MODEL = 'gemini-3-pro-image'

const ASSET_LABELS: Record<CharacterAssetType, string> = {
  rp_identity_card: 'FiveM RP identity card',
  passport: 'fictional FiveM RP passport prop',
  driver_license: 'fictional FiveM RP driver license prop',
  criminal_record: 'FiveM RP criminal record file',
  police_file: 'FiveM RP police case file',
  employee_file: 'FiveM RP employee file',
  business_profile: 'FiveM RP business profile',
  character_poster: 'FiveM character poster',
  studio_portrait: 'FiveM studio portrait',
}

const ASSET_TYPES = Object.keys(ASSET_LABELS) as CharacterAssetType[]

function isAssetType(value: unknown): value is CharacterAssetType {
  return typeof value === 'string' && ASSET_TYPES.includes(value as CharacterAssetType)
}

function aspectForAsset(assetType: CharacterAssetType): AspectRatioId {
  if (assetType === 'character_poster' || assetType === 'studio_portrait') return '3:4'
  return '16:9'
}

function buildPrompt(input: {
  assetType: CharacterAssetType
  characterName?: string
  role?: string
  organization?: string
  city?: string
  notes?: string
}) {
  const brainContext = buildNevaBrainContext('character')
  const label = ASSET_LABELS[input.assetType]
  const details = [
    input.characterName ? `Character name: ${input.characterName}` : null,
    input.role ? `Role/job: ${input.role}` : null,
    input.organization ? `Organization/business/faction: ${input.organization}` : null,
    input.city ? `City/server: ${input.city}` : null,
    input.notes ? `Extra notes: ${input.notes}` : null,
  ].filter(Boolean).join('. ')

  const orientationInstruction = getAspectRatioInstruction(aspectForAsset(input.assetType))

  return `${orientationInstruction}

Use my uploaded character as the hero subject. Preserve the exact face, facial structure, skin tone, hairstyle, facial hair, tattoos, jewelry, body proportions, outfit silhouette, and recognizable accessories. Do not redesign, beautify, age, swap, or change the character identity.

Create a premium ${label} for a fictional FiveM roleplay universe. This is an in-universe RP creative asset, not a real official document. Avoid real government seals, real official logos, scannable barcodes, QR codes, or anything that could be mistaken for a real identity document.

Neva Brain:
${brainContext}

Production direction: premium FiveM / GTA RP design, senior Photoshop designer finish, strong visual hierarchy, clean typography zones, believable Los Santos roleplay tone, polished lighting, subtle depth, controlled color grading, marketing-quality composition.

Premium restraint rules: keep the layout clean and expensive-looking. Do not overload with glow, particles, smoke, lens flares, neon, cyberpunk colors, plastic HDR, fake official seals, or decorative clutter. Use effects only as quiet accents. The character must remain the most readable and recognizable element.

Design quality checklist: one clear focal point, readable face, clean document/poster hierarchy, 2-3 color palette, generous spacing, premium contrast, FiveM-authentic GTA RP atmosphere, no generic stock-photo realism.

User details: ${details || 'No extra details provided. Make it professional and FiveM-authentic.'}`
}

export const characterAssetsRoutes = new Elysia({ prefix: '/character-assets' })
  .post('/', async ({ request }) => {
    try {
      const auth = await requireUser(request)
      if (isResponse(auth)) return auth
      const { user, supabase } = auth

      const contract = getModuleContract('character')
      const rate = checkRateLimit(`character:${user.id}`, contract.rateLimitPerMinute)
      if (!rate.ok) {
        securityLog('rate_limited', { userId: user.id, module: 'character' })
        return jsonError('rate_limited', 429)
      }

      const body = await request.json() as {
        sourceImage?: SourceImage | null
        assetType?: string
        characterName?: string
        role?: string
        organization?: string
        city?: string
        notes?: string
      }

      const validatedSource = validateUploadedImage(body.sourceImage, 'character_image')
      if (!validatedSource.ok) return jsonError(validatedSource.error, 400)

      const assetType = isAssetType(body.assetType) ? body.assetType : 'character_poster'
      const safeFields = {
        characterName: sanitizeText(body.characterName, 80),
        role: sanitizeText(body.role, 120),
        organization: sanitizeText(body.organization, 120),
        city: sanitizeText(body.city, 120),
        notes: sanitizeText(body.notes, contract.maxInputChars),
      }
      if (Object.values(safeFields).some(hasPromptInjectionRisk)) {
        securityLog('prompt_injection_signal', { userId: user.id, module: 'character' })
      }
      const prompt = buildPrompt({
        assetType,
        ...safeFields,
      })

      const image = await geminiImageEdit({
        model: IMAGE_MODEL,
        prompt,
        referenceImages: [validatedSource.image],
      })

      const [deduction, watermarkEnabled] = await Promise.all([
        deductCredits(
          supabase,
          user.id,
          CHARACTER_COST,
          'character_asset',
          `Neva Character - ${ASSET_LABELS[assetType]}`
        ),
        userNeedsWatermark(supabase, user.id),
      ])

      if (!deduction.success) {
        return Response.json({
          success: false,
          error: { code: 'insufficient_credits', message: 'Créations disponibles insuffisantes. Recharge dans Billing.' },
          remaining: deduction.remaining,
        }, { status: 402 })
      }

      const finalImage = watermarkEnabled ? await applyWatermarkToImage(image) : image

      return Response.json({
        success: true,
        data: {
          image: finalImage,
          assetType,
          prompt,
          creditsUsed: CHARACTER_COST,
          watermarkEnabled,
        },
        image: finalImage,
        assetType,
        prompt,
        creditsUsed: CHARACTER_COST,
        watermarkEnabled,
      })
    } catch (err: unknown) {
      const e = err as { message?: string }
      console.error('[character-assets]', e)
      return jsonError('generation_failed', 500, "La génération a échoué. Aucune création n'a été utilisée.")
    }
  })
