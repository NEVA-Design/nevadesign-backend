import { createServiceClient } from '../supabase'
import { securityLog } from '../security'
import { estimateCostEur } from './pricing'

// Garde-fous transverses des générations IA (run 5, LOT 0) :
// 1. kill-switch : engine_settings.generations_enabled — coupe tout sans
//    redéploiement (cache mémoire 30 s, PATCH /admin/engine ou SQL direct)
// 2. plafond quotidien d'images générées par compte (anti-emballement de
//    coût, distinct du compteur de créations/crédits)
// 3. journal de coût : chaque appel loggé dans generation_logs

export type EngineSettings = {
  generations_enabled: boolean
  daily_cap_per_user: number
}

const DEFAULT_SETTINGS: EngineSettings = {
  generations_enabled: true,
  daily_cap_per_user: 80,
}

const SETTINGS_CACHE_MS = 30_000
let settingsCache: { at: number; settings: EngineSettings } | null = null

export async function getEngineSettings(): Promise<EngineSettings> {
  if (settingsCache && Date.now() - settingsCache.at < SETTINGS_CACHE_MS) {
    return settingsCache.settings
  }

  try {
    const service = createServiceClient()
    const { data } = await service
      .from('engine_settings')
      .select('generations_enabled, daily_cap_per_user')
      .eq('id', 'global')
      .single()

    const settings: EngineSettings = data
      ? {
          generations_enabled: data.generations_enabled ?? true,
          daily_cap_per_user: data.daily_cap_per_user ?? DEFAULT_SETTINGS.daily_cap_per_user,
        }
      : DEFAULT_SETTINGS

    settingsCache = { at: Date.now(), settings }
    return settings
  } catch {
    // DB injoignable : on n'invente pas un blocage — l'auth aurait déjà
    // échoué si Supabase était réellement down.
    return settingsCache?.settings ?? DEFAULT_SETTINGS
  }
}

export function invalidateEngineSettingsCache() {
  settingsCache = null
}

export type GuardResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string }

export async function checkEngineGuards(userId: string, imagesRequested = 1): Promise<GuardResult> {
  const settings = await getEngineSettings()

  if (!settings.generations_enabled) {
    securityLog('engine_disabled_hit', { userId })
    return {
      ok: false,
      status: 503,
      code: 'engine_disabled',
      message: 'Les générations sont momentanément en pause. Réessaie dans quelques minutes.',
    }
  }

  try {
    const service = createServiceClient()
    const dayStart = new Date()
    dayStart.setUTCHours(0, 0, 0, 0)

    const { data } = await service
      .from('generation_logs')
      .select('images_out')
      .eq('user_id', userId)
      .gte('created_at', dayStart.toISOString())

    const usedToday = (data ?? []).reduce((sum, row) => sum + (row.images_out ?? 0), 0)
    if (usedToday + imagesRequested > settings.daily_cap_per_user) {
      securityLog('daily_cap_reached', { userId, usedToday, cap: settings.daily_cap_per_user })
      return {
        ok: false,
        status: 429,
        code: 'daily_cap_reached',
        message: 'Plafond quotidien de générations atteint pour ce compte. Réessaie demain ou contacte le support.',
      }
    }
  } catch (error) {
    // Compteur illisible : on laisse passer mais on trace — mieux vaut une
    // génération de trop qu'un produit mort sur un incident DB.
    securityLog('daily_cap_check_failed', { userId, error: (error as Error).message })
  }

  return { ok: true }
}

export type GenerationLogEntry = {
  userId: string | null
  projectId?: string | null
  assetId?: string | null
  kind: string
  model: string
  resolution?: string | null
  imagesOut?: number
  tokensIn?: number | null
  tokensOut?: number | null
  refused?: boolean
  retried?: boolean
  durationMs?: number
  batch?: boolean
}

// Fire-and-forget : ne jette jamais, une écriture de log ratée ne doit
// pas faire échouer une génération réussie.
export async function logGeneration(entry: GenerationLogEntry): Promise<void> {
  try {
    const service = createServiceClient()
    await service.from('generation_logs').insert({
      user_id: entry.userId,
      project_id: entry.projectId ?? null,
      asset_id: entry.assetId ?? null,
      kind: entry.kind,
      model: entry.model,
      resolution: entry.resolution ?? null,
      images_out: entry.imagesOut ?? 0,
      tokens_in: entry.tokensIn ?? null,
      tokens_out: entry.tokensOut ?? null,
      cost_eur: estimateCostEur({
        model: entry.model,
        tokensIn: entry.tokensIn,
        tokensOut: entry.tokensOut,
        imagesOut: entry.imagesOut ?? 0,
        resolution: entry.resolution,
        batch: entry.batch,
      }),
      refused: entry.refused ?? false,
      retried: entry.retried ?? false,
      duration_ms: entry.durationMs ?? null,
    })
  } catch (error) {
    console.warn('[generation-log] écriture échouée :', (error as Error).message)
  }
}
