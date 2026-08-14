import { env } from '../../config/env'

// Single Gemini client used everywhere in the backend — chat, vision,
// JSON-mode reasoning steps, and image generation/editing all go through
// this file. Neva AI is Gemini-only; there is no other model provider.

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

export const DEFAULT_VISION_MODEL = 'gemini-2.0-flash'

export class GeminiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'GeminiError'
    this.status = status
  }
}

export type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } }
export type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] }

type GeminiApiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>
    }
  }>
  error?: { code: number; message: string; status?: string }
}

function apiKey() {
  if (!env.GEMINI_API_KEY) throw new Error("Le moteur Neva n'est pas configuré (GEMINI_API_KEY manquante)")
  return env.GEMINI_API_KEY
}

function friendlyErrorMessage(status: number, rawMessage: string): string {
  if (status === 400) return 'Requête invalide — réessaie avec un contenu plus simple'
  if (status === 403) return "Le moteur Neva n'est pas correctement configuré"
  if (status === 429) return 'Quota du moteur Neva dépassé — attends quelques minutes et réessaie'
  if (status === 503) return 'Moteur Neva temporairement indisponible — réessaie dans un instant'
  return rawMessage.replace(/gemini/gi, 'moteur Neva')
}

async function post(model: string, path: string, body: Record<string, unknown>, extraQuery = ''): Promise<Response> {
  return fetch(`${BASE_URL}/models/${model}:${path}?key=${apiKey()}${extraQuery}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function extractText(response: GeminiApiResponse): string {
  return response.candidates?.[0]?.content?.parts?.find((p) => typeof p.text === 'string')?.text?.trim() ?? ''
}

// ─── Plain text generation (single-turn) ──────────────────────────────────────

export async function geminiText(opts: {
  model: string
  prompt: string
  systemInstruction?: string
  temperature?: number
  maxOutputTokens?: number
  json?: boolean
}): Promise<string> {
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.4,
      maxOutputTokens: opts.maxOutputTokens ?? 1024,
      ...(opts.json ? { responseMimeType: 'application/json' } : {}),
    },
  }
  if (opts.systemInstruction) {
    body.systemInstruction = { parts: [{ text: opts.systemInstruction }] }
  }

  const res = await post(opts.model, 'generateContent', body)
  const json = (await res.json().catch(() => null)) as GeminiApiResponse | null
  if (!res.ok || !json) {
    const message = json?.error?.message ?? `Erreur moteur Neva ${res.status}`
    throw new GeminiError(friendlyErrorMessage(res.status, message), res.status)
  }
  return extractText(json)
}

// ─── JSON-mode generation ──────────────────────────────────────────────────────

export async function geminiJson<T>(opts: {
  model: string
  prompt: string
  systemInstruction?: string
  temperature?: number
  maxOutputTokens?: number
}): Promise<T | null> {
  const text = await geminiText({ ...opts, json: true })
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

// ─── Vision (image + text -> text) ─────────────────────────────────────────────

export async function geminiVisionText(opts: {
  model?: string
  imageBase64: string
  mimeType: string
  prompt: string
  systemInstruction?: string
  temperature?: number
  maxOutputTokens?: number
  json?: boolean
}): Promise<string> {
  const model = opts.model ?? DEFAULT_VISION_MODEL
  const body: Record<string, unknown> = {
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: opts.mimeType, data: opts.imageBase64 } },
          { text: opts.prompt },
        ],
      },
    ],
    generationConfig: {
      temperature: opts.temperature ?? 0.1,
      maxOutputTokens: opts.maxOutputTokens ?? 1400,
      ...(opts.json ? { responseMimeType: 'application/json' } : {}),
    },
  }
  if (opts.systemInstruction) {
    body.systemInstruction = { parts: [{ text: opts.systemInstruction }] }
  }

  const res = await post(model, 'generateContent', body)
  const json = (await res.json().catch(() => null)) as GeminiApiResponse | null
  if (!res.ok || !json) {
    const message = json?.error?.message ?? `Erreur moteur de vision ${res.status}`
    throw new GeminiError(friendlyErrorMessage(res.status, message), res.status)
  }
  return extractText(json)
}

export async function geminiVisionJson<T>(opts: {
  model?: string
  imageBase64: string
  mimeType: string
  prompt: string
  systemInstruction?: string
  temperature?: number
  maxOutputTokens?: number
}): Promise<T | null> {
  const text = await geminiVisionText({ ...opts, json: true })
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

// ─── Streaming chat (multi-turn) ────────────────────────────────────────────────

export async function* geminiStreamText(opts: {
  model: string
  contents: GeminiContent[]
  systemInstruction?: string
  temperature?: number
  maxOutputTokens?: number
}): AsyncGenerator<string> {
  const body: Record<string, unknown> = {
    contents: opts.contents,
    generationConfig: {
      temperature: opts.temperature ?? 0.4,
      maxOutputTokens: opts.maxOutputTokens ?? 900,
    },
  }
  if (opts.systemInstruction) {
    body.systemInstruction = { parts: [{ text: opts.systemInstruction }] }
  }

  const res = await post(opts.model, 'streamGenerateContent', body, '&alt=sse')
  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => '')
    throw new GeminiError(friendlyErrorMessage(res.status, errText || `Erreur moteur Neva ${res.status}`), res.status)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let sepIndex: number
    while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, sepIndex)
      buffer = buffer.slice(sepIndex + 2)
      const dataLine = chunk.split('\n').find((line) => line.startsWith('data:'))
      if (!dataLine) continue
      const jsonStr = dataLine.slice(5).trim()
      if (!jsonStr) continue
      try {
        const parsed = JSON.parse(jsonStr) as GeminiApiResponse
        const text = extractText(parsed)
        if (text) yield text
      } catch {
        // partial/malformed SSE chunk — skip
      }
    }
  }
}

// ─── Image generation / editing (multimodal in, image out) ────────────────────

export async function geminiImageEdit(opts: {
  model: string
  prompt: string
  referenceImages?: Array<{ data: string; mimeType: string }>
}): Promise<string> {
  const validReferences = (opts.referenceImages ?? []).filter((img) => img.data && img.mimeType)
  const parts: GeminiPart[] =
    validReferences.length > 0
      ? [
          { text: `${opts.prompt}\n\nUse all attached uploaded images as references as described in the prompt above. Treat them together; do not ignore later references.` },
          ...validReferences.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data } })),
        ]
      : [{ text: opts.prompt }]

  const res = await post(opts.model, 'generateContent', {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseModalities: ['IMAGE'] },
  })

  const json = (await res.json().catch(() => null)) as GeminiApiResponse | null
  if (!res.ok || !json) {
    const message = json?.error?.message ?? `Erreur moteur image ${res.status}`
    throw new GeminiError(friendlyErrorMessage(res.status, message), res.status)
  }

  const imagePart = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)
  if (!imagePart?.inlineData?.data) {
    throw new GeminiError("Le moteur image n'a pas retourné de visuel — réessaie avec un prompt plus simple ou une autre référence", 200)
  }

  const mime = imagePart.inlineData.mimeType ?? 'image/png'
  return `data:${mime};base64,${imagePart.inlineData.data}`
}
