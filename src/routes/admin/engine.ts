import { Elysia } from 'elysia'
import { requireAdmin, isResponse } from '../../lib/require-auth'
import { createServiceClient } from '../../lib/supabase'
import { invalidateEngineSettingsCache } from '../../lib/engine/guards'

// Kill-switch des générations IA + plafond quotidien, modifiables à chaud
// (aucun redéploiement) : PATCH /admin/engine { generationsEnabled: false }
// coupe toutes les générations en ≤ 30 s (TTL du cache des guards).

export const adminEngineRoutes = new Elysia({ prefix: '/admin/engine' })
  .get('/', async ({ request }) => {
    const guard = await requireAdmin(request)
    if (isResponse(guard)) return guard

    const service = createServiceClient()
    const { data, error } = await service
      .from('engine_settings')
      .select('*')
      .eq('id', 'global')
      .maybeSingle()

    if (error) {
      console.error('[admin/engine] load error:', error)
      return Response.json({ error: 'Erreur lecture réglages moteur' }, { status: 500 })
    }

    return Response.json({ engine: data })
  })
  .patch('/', async ({ request }) => {
    const guard = await requireAdmin(request)
    if (isResponse(guard)) return guard
    const { admin } = guard

    const body = await request.json().catch(() => null) as {
      generationsEnabled?: boolean
      dailyCapPerUser?: number
    } | null
    if (!body) return Response.json({ error: 'Requête invalide' }, { status: 400 })

    const patch: Record<string, unknown> = {
      id: 'global',
      updated_by: admin.email,
      updated_at: new Date().toISOString(),
    }
    if (typeof body.generationsEnabled === 'boolean') {
      patch.generations_enabled = body.generationsEnabled
    }
    if (typeof body.dailyCapPerUser === 'number' && Number.isFinite(body.dailyCapPerUser)) {
      patch.daily_cap_per_user = Math.max(0, Math.min(10_000, Math.round(body.dailyCapPerUser)))
    }

    const service = createServiceClient()
    const { data, error } = await service
      .from('engine_settings')
      .upsert(patch, { onConflict: 'id' })
      .select('*')
      .single()

    if (error) {
      console.error('[admin/engine] save error:', error)
      return Response.json({ error: 'Erreur sauvegarde réglages moteur' }, { status: 500 })
    }

    invalidateEngineSettingsCache()
    return Response.json({ engine: data })
  })
