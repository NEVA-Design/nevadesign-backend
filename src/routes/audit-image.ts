import { Elysia } from 'elysia'
import { getModuleContract } from '../lib/ai/orchestrator'
import { geminiVisionJson, geminiImageEdit } from '../lib/ai/gemini'
import {
  checkRateLimit,
  jsonError,
  securityLog,
  validateUploadedImage,
} from '../lib/security'
import { requireUser, isResponse } from '../lib/require-auth'
import { deductCredits } from '../lib/credits'
import { buildNevaBrainContext } from '../lib/neva-brain'
import { applyWatermarkToImage, userNeedsWatermark } from '../lib/image-postprocess'

type SourceImage = { data: string; mimeType: string }
type AssetType = 'poster' | 'banner' | 'logo' | 'landing_page' | 'social_media'
type ReportLanguage = 'fr' | 'en' | 'es' | 'de' | 'it' | 'pt' | 'ar'

const AUDIT_COST = 1
const IMPROVED_VERSION_COST = 2
const VISION_MODEL = 'gemini-2.5-flash'
const IMAGE_MODEL = 'gemini-3-pro-image'
const ASSET_TYPES: AssetType[] = ['poster', 'banner', 'logo', 'landing_page', 'social_media']
const REPORT_LANGUAGES: Record<ReportLanguage, string> = {
  fr: 'French',
  en: 'English',
  es: 'Spanish',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  ar: 'Arabic',
}

function isAssetType(value: unknown): value is AssetType {
  return typeof value === 'string' && ASSET_TYPES.includes(value as AssetType)
}

function getReportLanguage(value: unknown): ReportLanguage {
  return typeof value === 'string' && value in REPORT_LANGUAGES ? value as ReportLanguage : 'fr'
}

type AuditReport = {
  overallScore?: number
  categories?: unknown[]
  strengths?: unknown[]
  weaknesses?: unknown[]
  suggestions?: unknown[]
  improvedVersionPrompt?: string
}

function fallbackAudit(): AuditReport {
  return {
    overallScore: 0,
    categories: [],
    strengths: [],
    weaknesses: ['The audit response could not be parsed.'],
    suggestions: ['Try again with a clearer image.'],
  }
}

export const auditImageRoutes = new Elysia({ prefix: '/audit-image' })
  .post('/', async ({ request }) => {
    try {
      const auth = await requireUser(request)
      if (isResponse(auth)) return auth
      const { user, supabase } = auth

      const contract = getModuleContract('audit')
      const rate = checkRateLimit(`audit:${user.id}`, contract.rateLimitPerMinute)
      if (!rate.ok) {
        securityLog('rate_limited', { userId: user.id, module: 'audit' })
        return jsonError('rate_limited', 429)
      }

      const body = await request.json() as {
        sourceImage?: SourceImage | null
        assetType?: string
        generateImprovedVersion?: boolean
        reportLanguage?: string
      }

      const validatedSource = validateUploadedImage(body.sourceImage, 'source_image')
      if (!validatedSource.ok) return jsonError(validatedSource.error, 400)

      const assetType = isAssetType(body.assetType) ? body.assetType : 'poster'
      const reportLanguage = getReportLanguage(body.reportLanguage)
      const generateImprovedVersion = body.generateImprovedVersion === true
      const brainContext = buildNevaBrainContext('audit')

      const audit = (await geminiVisionJson<AuditReport>({
        model: VISION_MODEL,
        imageBase64: validatedSource.image.data,
        mimeType: validatedSource.image.mimeType,
        temperature: 0.25,
        maxOutputTokens: 1800,
        systemInstruction: `You are Neva Audit, a senior FiveM creative director. Analyze uploaded visuals for FiveM creators, server owners, marketing teams, and designers.

Use these Neva Brain rules:
${brainContext}

Audit standard:
- Be comprehensive, practical, and specific. Do not write generic design advice.
- Judge premium quality by restraint: clear hierarchy, readable focal point, controlled contrast, good spacing, coherent branding, and useful depth.
- Penalize excessive glow, random neon, heavy blur, overloaded particles, unreadable text zones, plastic HDR, and effects that do not support the message.
- Suggestions must be written like a senior Photoshop designer briefing a junior designer: exact visual change, reason, and expected improvement.
- Write the entire audit report in ${REPORT_LANGUAGES[reportLanguage]}. JSON keys must stay in English, but every human-readable value must be in ${REPORT_LANGUAGES[reportLanguage]}.

Return ONLY valid JSON with this shape:
{
  "overallScore": 0-100,
  "summary": "2-3 sentences with the main diagnosis and the biggest improvement priority",
  "categories": [
    { "name": "Composition", "score": 0-100, "notes": "2 concrete sentences: what works/does not work and how to improve" },
    { "name": "Visual Hierarchy", "score": 0-100, "notes": "2 concrete sentences" },
    { "name": "Readability", "score": 0-100, "notes": "2 concrete sentences" },
    { "name": "Branding", "score": 0-100, "notes": "2 concrete sentences" },
    { "name": "Color Usage", "score": 0-100, "notes": "2 concrete sentences" },
    { "name": "Marketing Impact", "score": 0-100, "notes": "2 concrete sentences" },
    { "name": "Storytelling", "score": 0-100, "notes": "2 concrete sentences" },
    { "name": "Depth", "score": 0-100, "notes": "2 concrete sentences" }
  ],
  "strengths": ["4-6 specific strengths"],
  "weaknesses": ["4-6 specific weaknesses"],
  "suggestions": ["6-8 concrete Photoshop-level improvement suggestions with values when useful"],
  "priorityActions": ["3 ordered fixes that would improve the visual fastest"],
  "improvedVersionPrompt": "one paragraph prompt to improve this exact visual while preserving its concept, layout intent, brand identity and subject identity"
}`,
        prompt: `Audit this ${assetType} for premium FiveM marketing quality. Write the report in ${REPORT_LANGUAGES[reportLanguage]}. Be comprehensive, direct, and focused on what would make it sell better without adding unnecessary effects.`,
      })) ?? fallbackAudit()

      let improvedImage: string | null = null

      if (generateImprovedVersion) {
        const improvedPrompt =
          typeof audit.improvedVersionPrompt === 'string'
            ? audit.improvedVersionPrompt
            : 'Improve this FiveM promotional visual while preserving the same concept, subject, brand identity, composition intent, colors, logos, and all important details. Make it look professionally edited in Photoshop with stronger hierarchy, cleaner lighting, controlled contrast, subtle depth, better readability, and premium restrained marketing polish.'

        improvedImage = await geminiImageEdit({
          model: IMAGE_MODEL,
          prompt: `${improvedPrompt} Preserve the uploaded visual identity, layout intent, logos, character identity, face, tattoos, accessories, and recognizable elements. Do not redesign from scratch. FiveM / GTA RP promotional artwork, senior designer Photoshop finish. Keep effects subtle and purposeful: no random neon, no excessive glow, no overloaded particles, no plastic HDR, no fake stock-photo realism.`,
          referenceImages: [validatedSource.image],
        })
      }

      const totalCost = AUDIT_COST + (generateImprovedVersion ? IMPROVED_VERSION_COST : 0)
      const [deduction, watermarkEnabled] = await Promise.all([
        deductCredits(
          supabase,
          user.id,
          totalCost,
          generateImprovedVersion ? 'image_audit_improved' : 'image_audit',
          generateImprovedVersion ? 'Neva Audit + improved version' : 'Neva Audit'
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

      const finalImprovedImage = improvedImage && watermarkEnabled
        ? await applyWatermarkToImage(improvedImage)
        : improvedImage

      return Response.json({
        success: true,
        data: {
          audit,
          improvedImage: finalImprovedImage,
          assetType,
          reportLanguage,
          creditsUsed: totalCost,
          watermarkEnabled,
        },
        audit,
        improvedImage: finalImprovedImage,
        assetType,
        reportLanguage,
        creditsUsed: totalCost,
        watermarkEnabled,
      })
    } catch (err: unknown) {
      const e = err as { message?: string }
      console.error('[audit-image]', e?.message)
      return jsonError('audit_failed', 500, "L'audit a échoué. Aucune création n'a été utilisée.")
    }
  })
