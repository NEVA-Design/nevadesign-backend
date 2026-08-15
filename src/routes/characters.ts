import { Elysia } from 'elysia'
import { requireUser, isResponse } from '../lib/require-auth'
import { sanitizeText, validateUploadedImage, jsonError } from '../lib/security'
import { createServiceClient } from '../lib/supabase'
import { env } from '../config/env'

type GeminiTextResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  error?: { code: number; message: string }
}

async function geminiVision(imageBase64: string, mimeType: string, prompt: string): Promise<string> {
  const apiKey = env.GEMINI_API_KEY
  if (!apiKey) throw new Error("Le moteur de vision Neva n'est pas configuré")

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [
          { inline_data: { mime_type: mimeType, data: imageBase64 } },
          { text: prompt },
        ],
      }],
      generationConfig: { maxOutputTokens: 1400, temperature: 0.1, thinkingConfig: { thinkingBudget: 0 } },
    }),
  })

  const body = await res.json() as GeminiTextResponse
  if (!res.ok) throw new Error(body.error?.message?.replace(/gemini/gi, 'moteur de vision') ?? `Erreur moteur de vision ${res.status}`)
  return body.candidates?.[0]?.content?.parts?.find(p => p.text)?.text?.trim() ?? ''
}

const CHARACTER_CARD_PROMPT = `You are building a CHARACTER IDENTITY CARD for a FiveM/GTA V character.
Goal: produce a text description precise enough that an AI reading ONLY this text can reproduce the same character visually in any new scene, without ever seeing the original image.

Cover every stable visual marker. Use exact descriptors — no vague words:

FACE: face shape, skin tone (warm/olive/light brown/tan/pale/dark — be specific), forehead, cheekbones, jawline (sharp/soft/square/rounded), chin
EYES: exact color, shape (almond/round/hooded/upturned), size, spacing, eyebrow style (thick/thin/arched/flat/bushy), eyebrow color
NOSE: proportional size, bridge width, tip shape
MOUTH: lip fullness (thin/medium/full), width
HAIR: exact color shade (jet black/dark brown/chestnut/auburn/platinum blonde — specify), cut, length, texture (straight/wavy/curly), styling
FACIAL HAIR: clean-shaven — OR — stubble (sparse/medium, color) — OR — beard (style, shape, density, color)
DISTINCTIVE MARKS: tattoos (exact location, motif, style, color for each), scars, piercings, birthmarks
BODY: build (lean/athletic/muscular/stocky/heavyset), proportions
OUTFIT: every visible garment top to bottom — type, specific color, material look, fit. Include all layers
FOOTWEAR: type, color, style details
ACCESSORIES: watches (wrist, style), chains (length, style, metal), rings (which fingers, style), earrings, glasses/sunglasses (frame shape/color), hat/cap
CHARACTER ENERGY: 3-4 adjectives capturing visual vibe

Output each section with its exact header. Be extremely precise.`

const ARCHETYPE_EXTRACT_PROMPT = `Look at this FiveM character. Respond with ONLY a JSON object:
{
  "archetype": "one_word_underscore_label (e.g. luxury_male, lspd_officer, street_female, mechanic_male, beach_female)",
  "tags": ["tag1", "tag2", "tag3"],
  "style_summary": "One sentence describing the visual style — no personal details, just clothing/aesthetic style"
}`

export const characterRoutes = new Elysia({ prefix: '/characters' })
  .get('/', async ({ request }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user, supabase } = auth

    const { data, error } = await supabase
      .from('character_profiles')
      .select('id, name, image_preview, role, server, style, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (error) return Response.json({ error: error.message }, { status: 500 })
    return Response.json({ characters: data ?? [] })
  })
  .post('/', async ({ request }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user, supabase } = auth

    let body: {
      name: string
      imageBase64: string
      imageMimeType: string
      imagePreview?: string
      metadata?: { role?: string; server?: string; style?: string }
    }
    try {
      body = await request.json() as typeof body
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const { name, imageBase64, imageMimeType } = body
    if (!name?.trim()) return Response.json({ error: 'Name is required' }, { status: 400 })
    if (!imageBase64) return Response.json({ error: 'Image is required' }, { status: 400 })
    const validatedImage = validateUploadedImage({ data: imageBase64, mimeType: imageMimeType }, 'character_image')
    if (!validatedImage.ok) return jsonError(validatedImage.error, 400)

    let description: string
    let archetypeRaw: string

    try {
      ;[description, archetypeRaw] = await Promise.all([
        geminiVision(validatedImage.image.data, validatedImage.image.mimeType, CHARACTER_CARD_PROMPT),
        geminiVision(validatedImage.image.data, validatedImage.image.mimeType, ARCHETYPE_EXTRACT_PROMPT),
      ])
    } catch (e: unknown) {
      console.error('[characters] Gemini Vision error:', (e as Error).message)
      return Response.json({ error: 'Analyse du personnage échouée' }, { status: 500 })
    }

    if (!description) {
      return Response.json({ error: 'Description vide retournée par le modèle' }, { status: 500 })
    }

    const { data, error } = await supabase
      .from('character_profiles')
      .insert({
        user_id: user.id,
        name: sanitizeText(name, 80),
        description,
        image_preview: typeof body.imagePreview === 'string' ? body.imagePreview.slice(0, 12_000_000) : `data:${validatedImage.image.mimeType};base64,${validatedImage.image.data}`,
        role: sanitizeText(body.metadata?.role, 120),
        server: sanitizeText(body.metadata?.server, 120),
        style: sanitizeText(body.metadata?.style, 120),
        metadata: body.metadata ?? {},
      })
      .select('id, name, image_preview, role, server, style, created_at')
      .single()

    if (error) return Response.json({ error: error.message }, { status: 500 })

    try {
      const parsed = JSON.parse(archetypeRaw) as { archetype?: string; tags?: string[]; style_summary?: string }
      if (parsed.archetype && parsed.style_summary) {
        const service = createServiceClient()
        await service.from('character_style_pool').insert({
          archetype: parsed.archetype,
          style_tags: parsed.tags ?? [],
          description: parsed.style_summary,
        })
      }
    } catch {
      // Non-blocking — global pool feed failure doesn't affect the user
    }

    return Response.json({ character: data })
  })
  .get('/:id', async ({ request, params }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user, supabase } = auth

    const { data, error } = await supabase
      .from('character_profiles')
      .select('id, name, description, image_preview, role, server, style, metadata, created_at')
      .eq('id', params.id)
      .eq('user_id', user.id)
      .single()

    if (error || !data) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json({ character: data })
  })
  .patch('/:id', async ({ request, params }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user, supabase } = auth

    const body = await request.json().catch(() => null) as { name?: string; role?: string; server?: string; style?: string } | null
    if (!body) return Response.json({ error: 'Invalid JSON' }, { status: 400 })

    const updates: Record<string, string> = {}
    if (typeof body.name === 'string') updates.name = sanitizeText(body.name, 80)
    if (typeof body.role === 'string') updates.role = sanitizeText(body.role, 120)
    if (typeof body.server === 'string') updates.server = sanitizeText(body.server, 120)
    if (typeof body.style === 'string') updates.style = sanitizeText(body.style, 120)
    if (Object.keys(updates).length === 0) return Response.json({ error: 'Nothing to update' }, { status: 400 })

    const { data, error } = await supabase
      .from('character_profiles')
      .update(updates)
      .eq('id', params.id)
      .eq('user_id', user.id)
      .select('id, name, description, image_preview, role, server, style, created_at')
      .single()

    if (error || !data) return Response.json({ error: error?.message ?? 'Not found' }, { status: 404 })
    return Response.json({ character: data })
  })
  .delete('/:id', async ({ request, params }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user, supabase } = auth

    const { error } = await supabase
      .from('character_profiles')
      .delete()
      .eq('id', params.id)
      .eq('user_id', user.id)

    if (error) return Response.json({ error: error.message }, { status: 500 })
    return Response.json({ ok: true })
  })
