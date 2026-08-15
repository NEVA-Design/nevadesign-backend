import { env } from '../../config/env'

// Single Gemini client used everywhere in the backend — chat, vision,
// JSON-mode reasoning steps, and image generation/editing all go through
// this file. Neva AI is Gemini-only; there is no other model provider.

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

// NOTE migration 15/08/2026 : les modèles gemini-2.0/2.5 texte sont refusés
// aux clés récentes (« no longer available to new users »). Tout le backend
// utilise désormais la génération 3.5+ ; thinkingBudget: 0 est indispensable
// sur les étapes JSON, sinon le raisonnement consomme maxOutputTokens.
export const DEFAULT_VISION_MODEL = 'gemini-3.5-flash'

export class GeminiError extends Error {
  status: number
  // true quand le modèle a refusé le contenu (safety) — c'est le signal que
  // le compilateur de prompts utilise pour tenter UNE reformulation adoucie.
  refusal: boolean
  constructor(message: string, status: number, refusal = false) {
    super(message)
    this.name = 'GeminiError'
    this.status = status
    this.refusal = refusal
  }
}

export type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } }
export type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] }

type GeminiApiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>
    }
    finishReason?: string
  }>
  promptFeedback?: { blockReason?: string }
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
  error?: { code: number; message: string; status?: string }
}

export type GeminiUsage = {
  tokensIn: number
  tokensOut: number
}

function extractUsage(response: GeminiApiResponse | null): GeminiUsage {
  return {
    tokensIn: response?.usageMetadata?.promptTokenCount ?? 0,
    tokensOut: response?.usageMetadata?.candidatesTokenCount ?? 0,
  }
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
  thinkingBudget?: number
  onUsage?: (usage: GeminiUsage) => void
}): Promise<string> {
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.4,
      maxOutputTokens: opts.maxOutputTokens ?? 1024,
      ...(opts.json ? { responseMimeType: 'application/json' } : {}),
      ...(opts.thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget: opts.thinkingBudget } } : {}),
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
  opts.onUsage?.(extractUsage(json))
  return extractText(json)
}

// ─── JSON-mode generation ──────────────────────────────────────────────────────

export async function geminiJson<T>(opts: {
  model: string
  prompt: string
  systemInstruction?: string
  temperature?: number
  maxOutputTokens?: number
  thinkingBudget?: number
  onUsage?: (usage: GeminiUsage) => void
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
  thinkingBudget?: number
  onUsage?: (usage: GeminiUsage) => void
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
      ...(opts.thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget: opts.thinkingBudget } } : {}),
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
  opts.onUsage?.(extractUsage(json))
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
  thinkingBudget?: number
  onUsage?: (usage: GeminiUsage) => void
}): Promise<T | null> {
  const text = await geminiVisionText({ ...opts, json: true })
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

// ─── Multimodal libre (N images + texte -> texte) ──────────────────────────────
// Utilisé par le pipeline d'entraînement (lots d'images analysées en un appel).

export async function geminiMultimodal(opts: {
  model: string
  parts: GeminiPart[]
  systemInstruction?: string
  temperature?: number
  maxOutputTokens?: number
  json?: boolean
  thinkingBudget?: number
  onUsage?: (usage: GeminiUsage) => void
}): Promise<string> {
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: opts.parts }],
    generationConfig: {
      temperature: opts.temperature ?? 0.2,
      maxOutputTokens: opts.maxOutputTokens ?? 2000,
      ...(opts.json ? { responseMimeType: 'application/json' } : {}),
      ...(opts.thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget: opts.thinkingBudget } } : {}),
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
  opts.onUsage?.(extractUsage(json))
  return extractText(json)
}

// ─── Streaming chat (multi-turn) ────────────────────────────────────────────────

export async function* geminiStreamText(opts: {
  model: string
  contents: GeminiContent[]
  systemInstruction?: string
  temperature?: number
  maxOutputTokens?: number
  thinkingBudget?: number
}): AsyncGenerator<string> {
  const body: Record<string, unknown> = {
    contents: opts.contents,
    generationConfig: {
      temperature: opts.temperature ?? 0.4,
      maxOutputTokens: opts.maxOutputTokens ?? 900,
      ...(opts.thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget: opts.thinkingBudget } } : {}),
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

const REFUSAL_FINISH_REASONS = new Set(['SAFETY', 'IMAGE_SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'RECITATION'])

export type GeminiImageResult = {
  dataUrl: string
  usage: GeminiUsage
}

export async function geminiImageEditRich(opts: {
  model: string
  prompt: string
  referenceImages?: Array<{ data: string; mimeType: string }>
  // Config native des modèles image récents : ratio exact et résolution
  // 1K/2K/4K rendus par le modèle lui-même (pas par recadrage local).
  // Ne passer que des champs supportés par le modèle ciblé.
  imageConfig?: { aspectRatio?: string; imageSize?: '1K' | '2K' | '4K' }
}): Promise<GeminiImageResult> {
  const validReferences = (opts.referenceImages ?? []).filter((img) => img.data && img.mimeType)
  const parts: GeminiPart[] =
    validReferences.length > 0
      ? [
          { text: `${opts.prompt}\n\nUse all attached uploaded images as references as described in the prompt above. Treat them together; do not ignore later references.` },
          ...validReferences.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data } })),
        ]
      : [{ text: opts.prompt }]

  const generationConfig: Record<string, unknown> = { responseModalities: ['IMAGE'] }
  if (opts.imageConfig && (opts.imageConfig.aspectRatio || opts.imageConfig.imageSize)) {
    generationConfig.imageConfig = {
      ...(opts.imageConfig.aspectRatio ? { aspectRatio: opts.imageConfig.aspectRatio } : {}),
      ...(opts.imageConfig.imageSize ? { imageSize: opts.imageConfig.imageSize } : {}),
    }
  }

  const res = await post(opts.model, 'generateContent', {
    contents: [{ role: 'user', parts }],
    generationConfig,
  })

  const json = (await res.json().catch(() => null)) as GeminiApiResponse | null
  if (!res.ok || !json) {
    const message = json?.error?.message ?? `Erreur moteur image ${res.status}`
    throw new GeminiError(friendlyErrorMessage(res.status, message), res.status)
  }

  const usage = extractUsage(json)
  const candidate = json.candidates?.[0]
  const imagePart = candidate?.content?.parts?.find((p) => p.inlineData?.data)
  if (!imagePart?.inlineData?.data) {
    const blockReason = json.promptFeedback?.blockReason
    const finishReason = candidate?.finishReason
    const refused = Boolean(blockReason) || REFUSAL_FINISH_REASONS.has(finishReason ?? '')
    throw new GeminiError(
      refused
        ? 'Le moteur image a refusé cette scène — reformule-la légèrement (ambiance, objets sensibles) et réessaie'
        : "Le moteur image n'a pas retourné de visuel — réessaie avec un prompt plus simple ou une autre référence",
      200,
      refused
    )
  }

  const mime = imagePart.inlineData.mimeType ?? 'image/png'
  return { dataUrl: `data:${mime};base64,${imagePart.inlineData.data}`, usage }
}

export async function geminiImageEdit(opts: {
  model: string
  prompt: string
  referenceImages?: Array<{ data: string; mimeType: string }>
}): Promise<string> {
  const result = await geminiImageEditRich(opts)
  return result.dataUrl
}
