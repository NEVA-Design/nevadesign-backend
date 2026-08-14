import { Elysia } from 'elysia'
import { requireAdmin, isResponse } from '../../lib/require-auth'
import { DEFAULT_MAINTENANCE, maintenanceFromPayload, type MaintenancePayload } from '../../lib/maintenance'
import { createServiceClient } from '../../lib/supabase'

export const adminMaintenanceRoutes = new Elysia({ prefix: '/admin/maintenance' })
  .get('/', async ({ request }) => {
    const guard = await requireAdmin(request)
    if (isResponse(guard)) return guard

    const service = createServiceClient()
    const { data, error } = await service
      .from('site_maintenance')
      .select('*')
      .eq('id', 'global')
      .maybeSingle()

    if (error) {
      console.error('[admin/maintenance] load error:', error)
      return Response.json({
        maintenance: DEFAULT_MAINTENANCE,
        tableMissing: error.code === '42P01',
      })
    }

    return Response.json({ maintenance: data ?? DEFAULT_MAINTENANCE, tableMissing: false })
  })
  .patch('/', async ({ request }) => {
    const guard = await requireAdmin(request)
    if (isResponse(guard)) return guard
    const { admin } = guard

    const body = await request.json().catch(() => null) as MaintenancePayload | null
    if (!body) return Response.json({ error: 'Requete invalide' }, { status: 400 })

    const payload = maintenanceFromPayload(body, admin.email)
    const service = createServiceClient()
    const { data, error } = await service
      .from('site_maintenance')
      .upsert(payload, { onConflict: 'id' })
      .select('*')
      .single()

    if (error) {
      console.error('[admin/maintenance] save error:', error)
      return Response.json({
        error: error.code === '42P01'
          ? 'Table site_maintenance manquante. Applique la migration SQL.'
          : 'Erreur sauvegarde maintenance',
      }, { status: 500 })
    }

    return Response.json({ maintenance: data })
  })
