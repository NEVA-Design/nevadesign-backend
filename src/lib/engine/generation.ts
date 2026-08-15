import { geminiImageEditRich, GeminiError, type GeminiImageResult } from '../ai/gemini'
import { createServiceClient } from '../supabase'
import { logGeneration } from './guards'
import { softenPrompt } from './compiler'

// Génération moteur (run 5, LOT 3) : modèles par étape, retry adouci sur
// refus safety, stockage des rendus, journal de coût systématique.

// Résolutions par étape : propositions et itérations en 1K, master à la
// résolution du plan de l'abonné (8K = upscale local à l'export).
export const ENGINE_MODELS = {
  // 3 propositions de logo — rapide et économique
  proposal: 'gemini-3.1-flash-image',
  // calque scène des créations — la barre de qualité du produit
  scene: 'gemini-3-pro-image',
  // master final (logo 4K, scène à la résolution du plan)
  master: 'gemini-3-pro-image',
} as const

export function planImageSize(plan: string): '1K' | '2K' | '4K' {
  if (plan === 'pro') return '4K'
  if (plan === 'studio') return '2K'
  return '1K'
}

export type EngineGenerationLog = {
  userId: string
  projectId?: string | null
  assetId?: string | null
  kind: string
  resolution?: string
}

export type EngineGenerationResult = GeminiImageResult & {
  retried: boolean
  finalPrompt: string
  durationMs: number
}

// UNE reformulation adoucie maximum sur refus, tout est loggé (taux de
// refus mesurable par kind dans generation_logs).
export async function generateWithSoftRetry(opts: {
  model: string
  prompt: string
  referenceImages?: Array<{ data: string; mimeType: string }>
  imageConfig?: { aspectRatio?: string; imageSize?: '1K' | '2K' | '4K' }
  log: EngineGenerationLog
}): Promise<EngineGenerationResult> {
  const startedAt = Date.now()
  const baseLog = {
    userId: opts.log.userId,
    projectId: opts.log.projectId ?? null,
    assetId: opts.log.assetId ?? null,
    kind: opts.log.kind,
    model: opts.model,
    resolution: opts.log.resolution ?? opts.imageConfig?.imageSize ?? null,
  }

  try {
    const result = await geminiImageEditRich({
      model: opts.model,
      prompt: opts.prompt,
      referenceImages: opts.referenceImages,
      imageConfig: opts.imageConfig,
    })
    void logGeneration({
      ...baseLog,
      imagesOut: 1,
      tokensIn: result.usage.tokensIn,
      tokensOut: result.usage.tokensOut,
      durationMs: Date.now() - startedAt,
    })
    return { ...result, retried: false, finalPrompt: opts.prompt, durationMs: Date.now() - startedAt }
  } catch (error) {
    const gemini = error as GeminiError
    if (!(gemini instanceof GeminiError) || !gemini.refusal) throw error

    // Refus safety → une reformulation adoucie, une seule
    void logGeneration({ ...baseLog, imagesOut: 0, refused: true })
    const { softened } = softenPrompt(opts.prompt)
    try {
      const result = await geminiImageEditRich({
        model: opts.model,
        prompt: softened,
        referenceImages: opts.referenceImages,
        imageConfig: opts.imageConfig,
      })
      void logGeneration({
        ...baseLog,
        imagesOut: 1,
        tokensIn: result.usage.tokensIn,
        tokensOut: result.usage.tokensOut,
        retried: true,
        durationMs: Date.now() - startedAt,
      })
      return { ...result, retried: true, finalPrompt: softened, durationMs: Date.now() - startedAt }
    } catch (retryError) {
      const retryGemini = retryError as GeminiError
      void logGeneration({ ...baseLog, imagesOut: 0, refused: true, retried: true })
      if (retryGemini instanceof GeminiError && retryGemini.refusal) {
        throw new GeminiError(
          'Cette scène est refusée par le moteur, même adoucie. Reformule-la : retire les éléments les plus sensibles (armes visibles, violence, substances) et réessaie.',
          422,
          true
        )
      }
      throw retryError
    }
  }
}

// ── Stockage des rendus ──────────────────────────────────────────────────────
const BUCKET = 'neva-projects'

export async function storeRender(path: string, dataUrl: string): Promise<string> {
  const base64 = dataUrl.split(',').pop() ?? ''
  const buffer = Buffer.from(base64, 'base64')
  const contentType = dataUrl.startsWith('data:image/webp') ? 'image/webp' : 'image/png'
  return storeBuffer(path, buffer, contentType)
}

export async function storeBuffer(path: string, buffer: Buffer, contentType: string): Promise<string> {
  const service = createServiceClient()
  const { error } = await service.storage.from(BUCKET).upload(path, buffer, { contentType, upsert: true })
  if (error) throw new Error(`Stockage échoué (${path}) : ${error.message}`)
  const { data } = service.storage.from(BUCKET).getPublicUrl(path)
  return data.publicUrl
}

// Récupère un rendu stocké pour le repasser en référence Gemini.
export async function fetchAsReference(url: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const buffer = Buffer.from(await res.arrayBuffer())
    const mimeType = res.headers.get('content-type') ?? 'image/png'
    return { data: buffer.toString('base64'), mimeType: mimeType.split(';')[0] ?? 'image/png' }
  } catch {
    return null
  }
}
