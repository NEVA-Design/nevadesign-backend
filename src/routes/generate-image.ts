import { Elysia } from 'elysia'
import { getImageModel } from '../lib/ai/models'
import {
  getAspectRatio,
  getAspectRatioInstruction,
  normalizeAspectRatio,
  type AspectRatioId,
} from '../lib/ai/aspect-ratios'
import { getModuleContract } from '../lib/ai/orchestrator'
import { geminiText, geminiJson, geminiImageEdit, geminiVisionText, GeminiError } from '../lib/ai/gemini'
import {
  checkRateLimit,
  hasPromptInjectionRisk,
  jsonError,
  sanitizeText,
  securityLog,
  validateUploadedImages,
} from '../lib/security'
import { requireUser, isResponse } from '../lib/require-auth'
import { deductCredits } from '../lib/credits'
import { CREDIT_COSTS } from '../lib/plans'
import { buildNevaBrainContext } from '../lib/neva-brain'
import { normalizeGeneratedImage, userNeedsWatermark } from '../lib/image-postprocess'
import { env } from '../config/env'

type ReferenceImage = { data: string; mimeType: string }
type ReferenceImages = ReferenceImage[]
type EnhancementMode = 'light' | 'director' | 'full'
type ReferenceUsage = 'character' | 'pose' | 'outfit' | 'vehicle' | 'style' | 'environment' | 'background' | 'logo' | 'auto' | 'none'
const MAX_REFERENCE_IMAGES = 6

// Text reasoning steps (composition planning, prompt building, light clean-up)
// use a fast Gemini text model — separate from the image generation models.
const TEXT_MODEL = 'gemini-2.5-flash'

const COMPOSITION_ANALYZER = `You are the Neva Composition Engine — an adaptive art director that works with ANY visual style, not just dark luxury FiveM.

STEP 1 — CLASSIFY the style of the request into ONE of these categories:
FIRST PRINCIPLE:
Analyze the user prompt before choosing style. Neva Style is a fallback, not a prison.
Do not force dark luxury, cinematic street, neon, glow, haze, or GTA-poster language when the request asks for something else.

INTENT DETECTION:
- beach, summer, ocean, jetski, Vespucci, Del Perro -> beach_lifestyle or bright_lifestyle with bright sun, realistic summer colors, open air.
- illegal, cartel, confidential, dossier, evidence, underground -> dark_dossier or hood_street with dark confidential style only when secrecy or crime-file mood is requested.
- business, office, CEO, deal, luxury company -> business with office, luxury, professional polish.
- hood, gang, street, Davis, Strawberry -> hood_street with urban, realistic, grounded atmosphere.
- logo, emblem, mark, icon -> logo_branding with clean branding and minimal background.
- character render, render perso, isolated, packshot -> simple_render with isolated subject and clean lighting.
- poster, announcement, ad, recruit, campaign -> social_media_ad unless a more specific scene intent dominates.

- realistic_fivem: FiveM character in a realistic GTA-inspired setting, Los Santos
- luxury: premium lifestyle, supercars, mansions, Vinewood Hills, designer
- hood_street: urban streetwear, Davis/Strawberry Ave, lowriders, crews, graffiti
- business: corporate, suits, offices, Maze Bank, professional, deals
- police: LSPD/BCSO/FIB, law enforcement, tactical, duty belt, patrol car
- mechanic: workshop, garage, La Mesa, Benny's, tools, muscle cars, engines
- beach_lifestyle: Del Perro, Vespucci Beach, ocean, jetski, summer, open air
- funny_meme: humorous, exaggerated expression, comedic, parody, lighthearted
- cartoon_stylized: anime, illustration, cel-shading, flat color, drawn, 2D style
- logo_branding: logos, emblems, icons, minimal, brand-focused, graphic
- ui_website: landing pages, UI mockups, web layouts, digital design
- simple_render: clean packshot, isolated subject, minimal or gradient background
- dark_dossier: classified document aesthetic, mugshots, evidence boards, dark
- bright_lifestyle: warm daylight, outdoor positivity, vibrant, joyful, colorful
- social_media_ad: formatted for social networks, marketing layout, CTA-focused

STEP 2 — ENHANCEMENT LEVEL (override only if the user specified one; otherwise infer from request complexity):
- light: simple or short request, needs only basic cleanup
- director: standard request needing composition, camera, and lighting direction
- full: complex marketing brief requiring full production-level planning

STEP 3 — REFERENCE USAGE (only when an image is uploaded; infer from the user's words):
- character: user says "mon perso", "my character", "garde mon personnage"
- pose: user refers to a pose or body position to replicate
- outfit: user wants to keep or match only the clothing
- vehicle: user wants to preserve or use a vehicle from the reference
- style: user wants to match the visual/art style of the reference
- environment: user wants to use the background or setting
- background: user wants to use the background or location only
- logo: brand, logo, or emblem reference
- none: no reference image
If the uploaded reference contains a FiveM/GTA character and the user did not override usage, default to character preservation.

STEP 4 — BUILD the composition plan adapted to the detected style.

STYLE COMPOSITION RULES (do NOT apply rules from a different style):
realistic_fivem/luxury/business/police/mechanic/dark_dossier:
  → cinematic realism, motivated natural lighting, GTA V atmosphere, no studio flash, no neon
beach_lifestyle/bright_lifestyle:
  → bright warm daylight, open environments, golden tones, cheerful atmosphere
funny_meme:
  → exaggerated expressions, bold colors, dynamic angles, comedic framing
cartoon_stylized:
  → illustration-style lighting, bold outlines, flat/cel shading, stylized proportions
logo_branding:
  → clean minimal background, sharp graphic focus, negative space, brand-centric
ui_website:
  → flat digital aesthetic, clean layout, negative space, crisp elements
simple_render:
  → clean gradient or neutral background, subject perfectly lit, packshot style
hood_street:
  → authentic urban setting, mixed ambient street light, gritty realism
social_media_ad:
  → strong layout hierarchy, clean zones for text, professional marketing quality

NEGATIVE PROMPTS — adapt to style, never blanket-ban elements the user asked for:
realistic_fivem: "neon, cyberpunk, colored glow, cartoon, generic stock photo"
luxury: "neon, cyberpunk, cartoon, cheap, generic stock photo, white studio background"
hood_street: "neon, fake studio backdrop, overly staged corporate look"
business: "neon, glow, casual, amateurish"
police: "neon, cyberpunk, casual, glow effects"
mechanic: "neon, cyberpunk, fake studio backdrop"
beach_lifestyle: "neon, cyberpunk, dark gloom, winter, studio backdrop"
funny_meme: "boring, flat, uninspired, overly serious, muted"
cartoon_stylized: "photorealism, noisy texture, 3D render" (only if user did NOT ask for 3D)
logo_branding: "busy scene, characters, complex backgrounds, noise, blur"
ui_website: "busy outdoor scene, characters, complex backgrounds"
simple_render: "busy backgrounds, crowds, complex scenes"
dark_dossier: "bright pop colors, cheerful tones, neon"
bright_lifestyle: "dark, gloomy, desaturated, dim, overcast"
social_media_ad: "unprofessional, amateurish, blurry, noisy"

OUTPUT: Return ONLY a valid JSON object — no extra text:
{
  "style": "one of the 15 categories above",
  "enhancementLevel": "light|director|full",
  "intent": "beach|illegal|business|hood|logo|character_render|poster|general",
  "referenceUsage": "character|pose|outfit|vehicle|style|environment|background|logo|none",
  "marketingObjective": "one sentence — what this image must communicate",
  "environment": "specific setting with environmental detail adapted to the style",
  "mainSubject": "precise hero subject: who/what, clothing, pose, expression",
  "supportingElements": "2-3 supporting props or secondary elements",
  "cameraAngle": "low_angle_hero|side_profile|semi_back|over_shoulder|wide_environmental|close_portrait|dynamic_diagonal|straight_on",
  "cameraDescription": "exact camera instruction with position, focal length, framing",
  "lightingSetup": "appropriate lighting for the detected style",
  "lightingDescription": "exact lighting description with key light, color temperature, shadows",
  "foreground": "foreground element for depth (or 'none' if not applicable)",
  "background": "background composition — what is visible, defocus level",
  "storytelling": "the visual story this single frame tells",
  "colorGrading": "color palette, temperature, contrast — adapted to style",
  "mood": "emotional atmosphere — 3-5 descriptive words",
  "styleNegatives": "the style-appropriate negatives from the list above"
}`

const PROMPT_BUILDER = `You are Neva AI's adaptive prompt architect. You produce image generation prompts that respect the detected visual style — you do NOT force any single aesthetic on every request.

CORE RULE: Read the "style" and "enhancementLevel" from the composition plan and adapt everything accordingly.

PREMIUM QUALITY GATE:
- Premium means controlled taste, not more effects.
- Keep the image clean, readable, and marketable: one clear focal point, strong subject silhouette, intentional negative space, and a simple 2-3 color palette.
- Use glow, smoke, particles, lens flares, heavy bokeh, dramatic haze, neon, or cyberpunk lighting only if the user explicitly asks or the style requires it.
- The result must feel like polished FiveM / GTA V / Rockstar Editor promotional artwork, not a generic real-life stock photo and not an overprocessed HDR render.
- Faces must stay readable, skin tones natural, shadows detailed, highlights controlled, and background detail secondary.

─── REFERENCE IMAGE HANDLING ───────────────────────────────────────────────────
Based on the referenceUsage field:
character → Begin: "Using the uploaded character as the hero subject — preserve the exact face, facial structure, skin tone, hairstyle, beard, tattoos, jewelry, body proportions, accessories, and outfit unless the user explicitly asks to change it. Do not redesign, beautify, age, or swap the character."
pose → Begin: "Replicate the body pose and posture shown in the uploaded reference image."
outfit → Begin: "Match and keep the exact clothing and outfit shown in the uploaded reference image."
vehicle → Begin: "Use the uploaded vehicle as the exact vehicle reference, preserving model identity, color, body kit, wheels, decals, and distinctive details."
style → Begin: "Match the visual style, art direction, and aesthetic of the uploaded reference image."
environment → Begin: "Use the setting, location, and environment from the uploaded reference image as the scene."
background → Begin: "Use the background, location, and environment from the uploaded reference image as the scene."
logo → Begin: "Incorporate the logo or brand mark from the uploaded reference image."
none → No reference prefix.

─── ENHANCEMENT LEVEL ──────────────────────────────────────────────────────────
light: Keep it concise and close to the user's original intent. Add basic quality keywords only. 2-3 sentences max.
director: Add camera angle, lighting direction, foreground depth, background, and mood. A complete but focused prompt.
full: Full production-level prompt. All composition elements. Every detail specified. Marketing-ready.

─── STYLE-SPECIFIC APPROACH ────────────────────────────────────────────────────
realistic_fivem:
  Tone: cinematic game-realism, Los Santos atmosphere, GTA V character aesthetic
  Quality: "premium GTA V / FiveM promotional render, Rockstar Editor-inspired game-cinematic realism, motivated natural lighting, cinematic depth of field, subject sharp, background softly defocused, no neon, no glow, no watermarks, no text, no UI"

luxury:
  Tone: editorial high-end, premium dark palette, gold/silver accents, cinematic
  Quality: "premium luxury advertising, editorial quality, cinematic depth of field, natural motivated lighting, no neon, no glow, no watermarks, no text"

hood_street:
  Tone: authentic urban photography, street realism, raw atmosphere
  Quality: "authentic street photography quality, urban realism, natural ambient light, sharp subject, no studio flash, no neon, no watermarks, no text"

business:
  Tone: corporate editorial, modern professional, clean composition
  Quality: "professional corporate photography, modern editorial quality, clean lighting, sharp and polished, no neon, no watermarks, no text"

police:
  Tone: official law enforcement visual, structured authority
  Quality: "professional law enforcement photography, structured authority aesthetic, natural outdoor or practical indoor lighting, no neon, no watermarks, no text"

mechanic:
  Tone: workshop culture, industrial atmosphere, grounded realism
  Quality: "automotive editorial quality, workshop atmosphere, practical lighting, sharp subject, no neon, no cyberpunk, no watermarks, no text"

beach_lifestyle:
  Tone: warm daylight photography, open outdoor energy, golden summer tones
  Quality: "warm lifestyle photography, golden hour or midday sun, open outdoor feel, vibrant and natural, no dark tones, no neon, no watermarks, no text"

funny_meme:
  Tone: bold, expressive, comedic framing, exaggerated
  Quality: "sharp and expressive, bold composition, professional quality, vibrant colors, no watermarks, no text overlaid"

cartoon_stylized:
  Tone: illustration / anime / cel-shading — DO NOT add photorealism negatives
  Quality: "high quality illustration, clean linework, professional artwork, no watermarks, no text"

logo_branding:
  Tone: clean vector-like, minimal, brand-focused
  Quality: "professional graphic design, clean sharp edges, minimal background, brand-focused composition, no noise, no blur, no watermarks"

ui_website:
  Tone: flat digital design, clean layout, UI-friendly
  Quality: "professional digital design, clean crisp elements, modern layout, no noise, no watermarks"

simple_render:
  Tone: clean packshot, isolated subject, neutral background
  Quality: "professional product render or packshot, clean background, subject perfectly lit, sharp, studio quality, no watermarks"

dark_dossier:
  Tone: classified document aesthetic, desaturated, dark atmosphere, structured
  Quality: "dark editorial quality, desaturated tones, document aesthetic, moody sharp lighting, no bright colors, no neon, no watermarks"

bright_lifestyle:
  Tone: warm cheerful photography, open spaces, positive energy
  Quality: "warm lifestyle photography, bright natural light, vibrant positive energy, sharp, no dark tones, no watermarks"

social_media_ad:
  Tone: marketing layout, strong hierarchy, clean zones
  Quality: "professional social media creative, strong visual hierarchy, clean layout, high resolution, marketing quality, no watermarks"

─── FORMAT ──────────────────────────────────────────────────────────────────────
16:9 → wide cinematic landscape, horizontal composition, environmental storytelling
9:16 → vertical TikTok/story portrait, tall composition, subject centered
3:4 → editorial portrait, vertical, subject dominant, breathing room at top
1:1 → balanced square, centered focal point, equal visual weight

OUTPUT: Return ONLY the final prompt text. One continuous paragraph. No labels, no JSON, no newlines, no preamble.`

async function lightEnhance(userPrompt: string, aspectRatio: AspectRatioId, negativePrompt: string, referenceDesc: string | null): Promise<string> {
  const refNote = referenceDesc ? `\n\nUploaded reference: ${referenceDesc}` : ''
  const avoidNote = negativePrompt.trim() ? `\n\nElements to avoid: ${negativePrompt.trim()}` : ''
  const formatNote = `Mandatory format: ${getAspectRatio(aspectRatio).promptLabel}. ${getAspectRatioInstruction(aspectRatio)}`

  const text = await geminiText({
    model: TEXT_MODEL,
    systemInstruction: `You are a quick image prompt cleaner. The user has described an image they want to generate. Clean up the description, fix ambiguities, add basic quality keywords that match the request's style, but do NOT heavily redirect the creative direction. Keep the user's intent intact. Default to a premium restrained FiveM / GTA V promotional finish: clean hierarchy, motivated lighting, readable subject, controlled contrast, no excessive glow, no random neon, no plastic HDR, no generic stock-photo realism. If the user asked for something specific (cartoon, anime, bright colors, funny, etc.) preserve that. Output only the improved prompt in one short paragraph. No labels, no JSON.`,
    prompt: `Clean this prompt: "${userPrompt}"${refNote}\n\n${formatNote}${avoidNote}`,
    temperature: 0.4,
    maxOutputTokens: 400,
  })

  return text || userPrompt
}

function normalizeReferenceUsage(value: unknown): ReferenceUsage {
  const allowed: ReferenceUsage[] = ['character', 'pose', 'outfit', 'vehicle', 'style', 'environment', 'background', 'logo', 'auto', 'none']
  return allowed.includes(value as ReferenceUsage) ? value as ReferenceUsage : 'auto'
}

async function classifyReferenceImage(
  imageBase64: string,
  mimeType: string,
  userPrompt: string,
): Promise<ReferenceUsage> {
  try {
    const text = await geminiVisionText({
      imageBase64,
      mimeType,
      temperature: 0,
      maxOutputTokens: 20,
      prompt: `Classify how this uploaded image should be used for a FiveM creative generation.

User prompt: "${userPrompt}"

Return exactly one lowercase label from this list:
character, outfit, pose, vehicle, logo, background, style.

Rules:
- If the image contains a FiveM/GTA character or human-like RP character, return character unless the user explicitly asks only for outfit, pose, or style.
- If it is mainly clothing/fashion with no need to preserve face, return outfit.
- If it is mainly body posture/action, return pose.
- If it is mainly a car/bike/boat/aircraft, return vehicle.
- If it is a logo, emblem, icon, wordmark, or brand mark, return logo.
- If it is mainly scenery/interior/location, return background.
- If the user asks to match art direction, color grading, or visual mood only, return style.
No explanation.`,
    })
    return normalizeReferenceUsage(text.trim().toLowerCase().replace(/[^a-z_]/g, ''))
  } catch {
    return 'character'
  }
}

async function describeReference(
  imageBase64: string,
  mimeType: string,
  referenceUsage: ReferenceUsage,
): Promise<string> {
  const descriptionGoal: Record<string, string> = {
    character: `Describe this FiveM character for strict identity preservation. Focus on stable markers: facial structure, eye shape/color, nose, lips, jawline, skin tone, facial hair, hairline, hairstyle, tattoos, jewelry, body proportions, outfit silhouette, clothing colors/materials, shoes, and signature accessories. Return a 5-7 sentence preservation description. No preamble.`,
    pose: `Describe the body pose and posture in this image for replication. Focus on body orientation, limb positions, weight distribution, head tilt, and any gestures or dynamic movement. Return 3-4 concise sentences. No preamble.`,
    outfit: `Describe the clothing and outfit worn in this image in detail. Focus on garment types, colors, materials, fit, layering, accessories, and shoes. Return 4-5 concise sentences. No preamble.`,
    vehicle: `Describe the vehicle in this image for strict preservation. Focus on model/body shape, color, wheels, body kit, lights, decals, damage, stance, and distinctive custom details. Return 4-5 concise sentences. No preamble.`,
    style: `Describe the overall visual style and art direction of this image. Focus on color palette, lighting approach, texture, composition style, post-processing look, and overall mood. Return 4-5 concise sentences. No preamble.`,
    environment: `Describe the setting, location, and environment shown in this image. Focus on the place type, spatial layout, architectural or natural elements, time of day, and atmospheric conditions. Return 4-5 concise sentences. No preamble.`,
    background: `Describe only the background, location, and environment shown in this image. Ignore the main subject unless it affects the setting. Return 4-5 concise sentences. No preamble.`,
    logo: `Describe this logo or brand mark in detail. Focus on shapes, colors, typography, symbol/icon, style, and overall graphic concept. Return 3-4 concise sentences. No preamble.`,
    auto: `Describe this FiveM character for identity preservation. Focus on: face, skin tone, hairstyle, beard, tattoos, jewelry, body proportions, outfit, and accessories. Return 5-7 concise sentences. No preamble.`,
    none: ``,
  }

  const goal = descriptionGoal[referenceUsage] ?? descriptionGoal.auto
  if (!goal) return ''

  try {
    return await geminiVisionText({ imageBase64, mimeType, prompt: goal, maxOutputTokens: 600, temperature: 0.1 })
  } catch (e) {
    console.warn('[describeReference] failed:', (e as Error).message)
    return ''
  }
}

async function analyzeComposition(
  userPrompt: string,
  referenceDesc: string | null,
  enhancementHint: EnhancementMode | null,
  referenceUsageHint: string | null,
  aspectRatio: AspectRatioId,
): Promise<Record<string, string>> {
  const ratio = getAspectRatio(aspectRatio)
  const orientationHint = `TARGET FORMAT: ${ratio.promptLabel}. ${ratio.providerInstruction} Do not switch orientation.`

  const hintBlock: string[] = [orientationHint]
  if (enhancementHint) hintBlock.push(`User-selected enhancement level: ${enhancementHint} (use this unless clearly wrong for the request)`)
  if (referenceUsageHint) hintBlock.push(`User says the uploaded image is for: ${referenceUsageHint}`)
  if (referenceDesc) hintBlock.push(`REFERENCE IMAGE DESCRIPTION:\n${referenceDesc}`)
  hintBlock.push(`NEVA BRAIN FIVE M CREATIVE INTELLIGENCE:\n${buildNevaBrainContext('design')}`)

  const contextBlock = `\n\nCONTEXT:\n${hintBlock.join('\n')}`

  const plan = await geminiJson<Record<string, string>>({
    model: TEXT_MODEL,
    systemInstruction: COMPOSITION_ANALYZER,
    prompt: `Analyze this request:\n\n"${userPrompt}"${contextBlock}`,
    temperature: 0.3,
    maxOutputTokens: 900,
  })

  return plan ?? {}
}

async function buildFinalPrompt(
  userPrompt: string,
  compositionPlan: Record<string, string>,
  referenceDesc: string | null,
  aspectRatio: AspectRatioId,
  negativePrompt: string,
): Promise<string> {
  const refBlock = referenceDesc
    ? `\n\nREFERENCE IMAGE:\nUsage type: ${compositionPlan.referenceUsage ?? 'auto'}\nDescription: ${referenceDesc}`
    : ''

  const ratio = getAspectRatio(aspectRatio)
  const formatLabel = ratio.promptLabel

  const userNegatives = negativePrompt.trim()
  const styleNegatives = compositionPlan.styleNegatives ?? ''
  const combinedNegatives = [styleNegatives, userNegatives].filter(Boolean).join(', ')
  const avoidBlock = combinedNegatives ? `\n\nELEMENTS TO AVOID: ${combinedNegatives}` : ''

  const planLines = Object.entries(compositionPlan)
    .filter(([k]) => k !== 'styleNegatives')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')

  const text = await geminiText({
    model: TEXT_MODEL,
    systemInstruction: PROMPT_BUILDER,
    prompt: `MANDATORY IMAGE FORMAT: ${formatLabel}. ${ratio.providerInstruction} The composition, framing, and camera angle MUST match this orientation.\n\nBuild the final image prompt for: "${userPrompt}"${refBlock}\n\nCOMPOSITION PLAN:\n${planLines}${avoidBlock}\n\nOutput only the final prompt.`,
    temperature: 0.5,
    maxOutputTokens: 950,
  })

  return text || userPrompt
}

async function generateWithGemini(
  prompt: string,
  geminiModel: string,
  aspectRatio: AspectRatioId,
  referenceImages: ReferenceImages = [],
): Promise<string> {
  const orientationPrefix = `${getAspectRatioInstruction(aspectRatio)} `

  const FLASH_QUALITY_BOOST =
    'Ultra high quality. Extremely detailed. Professional cinematic photography. ' +
    'Sharp focus throughout the subject. Perfect lighting. Rich colors. ' +
    'Premium production value. Studio-grade render. No blur, no noise, no artifacts. '

  const qualityPrefix = geminiModel === 'gemini-2.5-flash-image' ? FLASH_QUALITY_BOOST : ''
  const finalPrompt = orientationPrefix + qualityPrefix + prompt

  return geminiImageEdit({ model: geminiModel, prompt: finalPrompt, referenceImages })
}

async function generateSingleImage(
  finalPrompt: string,
  imageModel: ReturnType<typeof getImageModel>,
  aspectRatio: AspectRatioId,
  referenceImages: ReferenceImages = [],
): Promise<string> {
  const fallbackEnabled = env.GEMINI_FALLBACK_ENABLED !== 'false'
  const fallbackModel = env.GEMINI_FALLBACK_MODEL || 'gemini-3.1-flash-image'

  try {
    return await generateWithGemini(finalPrompt, imageModel.geminiModel, aspectRatio, referenceImages)
  } catch (primaryErr) {
    const e = primaryErr as GeminiError
    console.error('[generate-image] Primary Gemini failed:', e.message)
    const shouldFallback =
      fallbackEnabled &&
      imageModel.id === 'neva-ultra' &&
      imageModel.geminiModel !== fallbackModel &&
      (e.status === 429 || e.status === 503 || e.status >= 500)
    if (!shouldFallback) throw primaryErr
    console.log('[generate-image] Falling back to:', fallbackModel)
    return await generateWithGemini(finalPrompt, fallbackModel, aspectRatio, referenceImages)
  }
}

export const generateImageRoutes = new Elysia({ prefix: '/generate-image' })
  .post('/', async ({ request }) => {
    try {
      const auth = await requireUser(request)
      if (isResponse(auth)) return auth
      const { user, supabase } = auth

      const contract = getModuleContract('design')
      const rate = checkRateLimit(`design:${user.id}`, contract.rateLimitPerMinute)
      if (!rate.ok) {
        securityLog('rate_limited', { userId: user.id, module: 'design' })
        return jsonError('rate_limited', 429)
      }

      const {
        prompt,
        aspectRatio = '1:1',
        resolution = 'hd',
        imageModelId = 'neva-standard',
        negativePrompt = '',
        referenceImage,
        referenceImages: rawReferenceImages,
        enhancementMode,
        referenceUsageHint,
        savedCharacterDescription,
        renderCount: rawRenderCount = 1,
      } = await request.json() as {
        prompt?: string
        aspectRatio?: string
        resolution?: string
        imageModelId?: string
        negativePrompt?: string
        referenceImage?: ReferenceImage | null
        referenceImages?: ReferenceImages | null
        enhancementMode?: EnhancementMode
        referenceUsageHint?: string
        savedCharacterDescription?: string
        renderCount?: number
      }

      const renderCount = ([1, 3, 4] as const).includes(rawRenderCount as 1 | 3 | 4)
        ? (rawRenderCount as 1 | 3 | 4)
        : 1

      const safePrompt = sanitizeText(prompt, contract.maxInputChars)
      const safeNegativePrompt = sanitizeText(negativePrompt, 1_500)
      const safeSavedCharacterDescription = sanitizeText(savedCharacterDescription, 3_500)
      if (hasPromptInjectionRisk(safePrompt) || hasPromptInjectionRisk(safeNegativePrompt)) {
        securityLog('prompt_injection_signal', { userId: user.id, module: 'design' })
      }

      if (!safePrompt) {
        return jsonError('prompt_required', 400, 'Décris le visuel à créer avant de lancer la génération.')
      }

      const safeAspectRatio = normalizeAspectRatio(aspectRatio)
      if (!safeAspectRatio) {
        return jsonError('invalid_aspect_ratio', 400, 'Format invalide. Choisis 1:1, 4:3, 16:9, 3:4 ou 9:16.')
      }

      const imageModel = getImageModel(imageModelId)
      const generationCost = imageModel.creditCost ?? CREDIT_COSTS.image_generation
      const watermarkEnabled = await userNeedsWatermark(supabase, user.id)
      const candidateReferenceImages = (
        Array.isArray(rawReferenceImages) && rawReferenceImages.length > 0
          ? rawReferenceImages
          : referenceImage
          ? [referenceImage]
          : []
      )
        .filter((image): image is ReferenceImage => Boolean(image?.data && image?.mimeType))
        .slice(0, MAX_REFERENCE_IMAGES)
      const validatedReferences = validateUploadedImages(candidateReferenceImages, contract.maxImages)
      if (!validatedReferences.ok) return jsonError(validatedReferences.error, 400)
      const referenceImages: ReferenceImages = validatedReferences.images

      try {
        let referenceDescription: string | null = null
        if (safeSavedCharacterDescription) {
          referenceDescription = `Use the uploaded character as the exact identity reference. Preserve the same face, hairstyle, skin tone, tattoos, body proportions, outfit identity and recognizable features. Do not redesign the character. Create the requested scene while keeping this character recognizable.\n\n${safeSavedCharacterDescription}`
        } else if (referenceImages.length > 0) {
          const requestedUsage = normalizeReferenceUsage(referenceUsageHint)
          const descriptions = await Promise.all(
            referenceImages.map(async (image, index) => {
              const classifiedUsage = requestedUsage === 'auto'
                ? await classifyReferenceImage(image.data, image.mimeType, safePrompt)
                : requestedUsage
              return describeReference(image.data, image.mimeType, classifiedUsage)
                .then(description => description ? `Reference ${index + 1} (${classifiedUsage}): ${description}` : '')
            })
          )
          referenceDescription = descriptions.filter(Boolean).join('\n')
        }

        let finalPrompt: string
        let compositionPlan: Record<string, string> = {}

        if (enhancementMode === 'light') {
          finalPrompt = await lightEnhance(safePrompt, safeAspectRatio, safeNegativePrompt, referenceDescription)
          compositionPlan = { enhancementLevel: 'light', style: 'auto' }
        } else {
          const isFlashModel = imageModel.geminiModel === 'gemini-2.5-flash-image'
          const effectiveMode: EnhancementMode = (isFlashModel && enhancementMode === 'full') ? 'director' : (enhancementMode ?? 'director')

          const effectiveUsageHint = safeSavedCharacterDescription
            ? 'character'
            : (normalizeReferenceUsage(referenceUsageHint) !== 'auto' ? normalizeReferenceUsage(referenceUsageHint) : null)

          compositionPlan = await analyzeComposition(
            safePrompt,
            referenceDescription,
            effectiveMode,
            effectiveUsageHint,
            safeAspectRatio,
          )

          finalPrompt = await buildFinalPrompt(
            safePrompt,
            compositionPlan,
            referenceDescription,
            safeAspectRatio,
            safeNegativePrompt,
          )
        }

        const modelUsed = imageModel.name
        const totalCost = generationCost * renderCount

        const rawImages = await Promise.all(
          Array.from({ length: renderCount }, () =>
            generateSingleImage(finalPrompt, imageModel, safeAspectRatio, referenceImages)
          )
        )
        const images = await Promise.all(
          rawImages.map((image) =>
            normalizeGeneratedImage({
              imageBase64: image,
              aspectRatio: safeAspectRatio,
              watermark: watermarkEnabled,
            })
          )
        )

        const deduction = await deductCredits(
          supabase,
          user.id,
          totalCost,
          'image_generation',
          `Neva Design — ${imageModel.name}${renderCount > 1 ? ` × ${renderCount}` : ''}`
        )
        if (!deduction.success) {
          return Response.json(
            { error: 'insufficient_credits', remaining: deduction.remaining },
            { status: 402 }
          )
        }

        return Response.json({
          images,
          image: images[0],
          originalPrompt: safePrompt,
          enhancedPrompt: finalPrompt,
          compositionPlan,
          referenceDescription,
          model: modelUsed,
          resolution,
          aspectRatio: safeAspectRatio,
          aspectRatioOrientation: getAspectRatio(safeAspectRatio).orientation,
          watermarkEnabled,
          watermarkText: watermarkEnabled ? 'Generated with Neva AI' : null,
          creditsUsed: totalCost,
          remainingCredits: deduction.remaining,
          renderCount,
        })
      } catch (genErr: unknown) {
        const e = genErr as { status?: number; message?: string; name?: string }
        console.error('[generate-image] generation error:', e?.status, e?.message)

        let userMessage = e?.message ?? 'Erreur inconnue lors de la génération'
        if (e?.name === 'GeminiError') {
          userMessage = e.message ?? 'Erreur moteur image'
        }

        userMessage = userMessage
          .replace(/gemini/gi, 'moteur image')
          .replace(/gpt-image-1/gi, 'moteur image')

        return jsonError('generation_failed', 500, userMessage)
      }
    } catch (err: unknown) {
      const e = err as { message?: string }
      console.error('[generate-image] outer error:', e?.message)
      return jsonError('server_error', 500)
    }
  })
