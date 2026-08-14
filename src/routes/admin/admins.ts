import { Elysia } from 'elysia'
import { getBootstrapAdminEmails } from '../../lib/admin'
import { requireAdmin, isResponse } from '../../lib/require-auth'
import { createServiceClient } from '../../lib/supabase'

function normalizeEmail(value: unknown) {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null
  return email
}

export const adminAdminsRoutes = new Elysia({ prefix: '/admin/admins' })
  .get('/', async ({ request }) => {
    const guard = await requireAdmin(request)
    if (isResponse(guard)) return guard

    const service = createServiceClient()
    const { data, error } = await service
      .from('admin_users')
      .select('id, email, is_active, created_at, created_by')
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[admin/admins] list error:', error)
      return Response.json({ error: error.message }, { status: 500 })
    }

    const bootstrapAdmins = getBootstrapAdminEmails().map(email => ({
      id: `env:${email}`,
      email,
      is_active: true,
      source: 'env' as const,
      created_at: null,
      created_by: null,
    }))

    const databaseAdmins = (data ?? []).map(item => ({
      ...item,
      source: 'database' as const,
    }))

    return Response.json({ admins: [...bootstrapAdmins, ...databaseAdmins] })
  })
  .post('/', async ({ request }) => {
    const guard = await requireAdmin(request)
    if (isResponse(guard)) return guard
    const { admin } = guard

    const body = await request.json() as { email?: unknown }
    const email = normalizeEmail(body.email)
    if (!email) return Response.json({ error: 'Email invalide' }, { status: 400 })

    if (getBootstrapAdminEmails().includes(email)) {
      return Response.json({ error: 'Cet email est deja admin via ADMIN_EMAILS' }, { status: 409 })
    }

    const service = createServiceClient()
    const { data, error } = await service
      .from('admin_users')
      .upsert(
        {
          email,
          is_active: true,
          created_by: admin.userId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'email' }
      )
      .select('id, email, is_active, created_at, created_by')
      .single()

    if (error) {
      console.error('[admin/admins] create error:', error)
      return Response.json({ error: error.message }, { status: 500 })
    }

    return Response.json({ admin: { ...data, source: 'database' as const } })
  })
  .delete('/:id', async ({ request, params }) => {
    const guard = await requireAdmin(request)
    if (isResponse(guard)) return guard
    const { admin } = guard

    const { id } = params
    if (id.startsWith('env:')) {
      return Response.json({ error: 'Impossible de retirer un admin configure dans ADMIN_EMAILS' }, { status: 400 })
    }

    const service = createServiceClient()

    const { data: target, error: targetErr } = await service
      .from('admin_users')
      .select('id, email')
      .eq('id', id)
      .maybeSingle()

    if (targetErr) {
      console.error('[admin/admins] find error:', targetErr)
      return Response.json({ error: targetErr.message }, { status: 500 })
    }

    if (!target) return Response.json({ error: 'Admin introuvable' }, { status: 404 })

    if (target.email.toLowerCase() === admin.email.toLowerCase()) {
      return Response.json({ error: 'Tu ne peux pas retirer ton propre acces admin depuis cette page' }, { status: 400 })
    }

    const { error } = await service
      .from('admin_users')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', id)

    if (error) {
      console.error('[admin/admins] delete error:', error)
      return Response.json({ error: error.message }, { status: 500 })
    }

    return Response.json({ ok: true })
  })
