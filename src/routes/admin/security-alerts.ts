import { Elysia } from 'elysia'
import { requireAdmin, isResponse } from '../../lib/require-auth'
import { approveSignupCredits } from '../../lib/signup-security'
import { createServiceClient } from '../../lib/supabase'

type Action = 'approve' | 'reject' | 'safe' | 'abuse'

function isAction(value: unknown): value is Action {
  return value === 'approve' || value === 'reject' || value === 'safe' || value === 'abuse'
}

export const adminSecurityAlertsRoutes = new Elysia({ prefix: '/admin/security-alerts' })
  .get('/', async ({ request }) => {
    const guard = await requireAdmin(request)
    if (isResponse(guard)) return guard

    const url = new URL(request.url)
    const status = url.searchParams.get('status')
    const service = createServiceClient()

    let query = service
      .from('signup_security_events')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100)

    if (status && status !== 'all') query = query.eq('status', status)

    const { data, error } = await query

    if (error) {
      console.error('[admin/security-alerts] list error:', error)
      return Response.json({ error: 'Erreur chargement alertes' }, { status: 500 })
    }

    return Response.json({ alerts: data ?? [] })
  })
  .post('/:id', async ({ request, params }) => {
    const guard = await requireAdmin(request)
    if (isResponse(guard)) return guard
    const { admin } = guard

    const body = await request.json().catch(() => null) as { action?: unknown } | null
    if (!isAction(body?.action)) {
      return Response.json({ error: 'Action invalide' }, { status: 400 })
    }

    const service = createServiceClient()
    const { data: alert, error: findError } = await service
      .from('signup_security_events')
      .select('*')
      .eq('id', params.id)
      .single()

    if (findError || !alert) {
      return Response.json({ error: 'Alerte introuvable' }, { status: 404 })
    }

    const shouldGrant = body.action === 'approve' || body.action === 'safe'
    if (shouldGrant) {
      try {
        await approveSignupCredits(service, alert.user_id, admin.email)
      } catch (error) {
        console.error('[admin/security-alerts] grant error:', error)
        return Response.json({ error: 'Erreur attribution credits' }, { status: 500 })
      }
    }

    const nextStatus =
      body.action === 'approve'
        ? 'approved_by_admin'
        : body.action === 'safe'
        ? 'allowed'
        : 'rejected_by_admin'

    const { data, error } = await service
      .from('signup_security_events')
      .update({
        status: nextStatus,
        reviewed_by: admin.email,
        reviewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', params.id)
      .select('*')
      .single()

    if (error) {
      console.error('[admin/security-alerts] update error:', error)
      return Response.json({ error: 'Erreur mise a jour alerte' }, { status: 500 })
    }

    return Response.json({ alert: data })
  })
