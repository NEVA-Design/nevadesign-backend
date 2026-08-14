import { Elysia } from 'elysia'
import { requireAdmin, isResponse } from '../../lib/require-auth'
import { createServiceClient } from '../../lib/supabase'
import { PLANS } from '../../lib/plans'

const VALID_PLANS = ['free', 'creator', 'studio', 'pro'] as const
type Plan = typeof VALID_PLANS[number]

export const adminUsersRoutes = new Elysia({ prefix: '/admin/users' })
  .get('/', async ({ request }) => {
    const guard = await requireAdmin(request)
    if (isResponse(guard)) return guard

    const url = new URL(request.url)
    const q = url.searchParams.get('q')?.trim().toLowerCase() ?? ''
    const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1'))
    const perPage = 20

    const service = createServiceClient()

    let authUsers: Array<{
      id: string
      email?: string
      created_at: string
    }>
    let total = 0

    if (q) {
      const { data } = await service.auth.admin.listUsers({ page: 1, perPage: 1000 })
      const all = data?.users ?? []
      const filtered = all.filter(u => u.email?.toLowerCase().includes(q))
      total = filtered.length
      const start = (page - 1) * perPage
      authUsers = filtered.slice(start, start + perPage)
    } else {
      const { data } = await service.auth.admin.listUsers({ page, perPage })
      authUsers = data?.users ?? []
      const { count } = await service.from('profiles').select('*', { count: 'exact', head: true })
      total = count ?? authUsers.length
    }

    if (authUsers.length === 0) {
      return Response.json({ users: [], total: 0, page, perPage })
    }

    const ids = authUsers.map(u => u.id)
    const { data: profiles } = await service
      .from('profiles')
      .select('id, credits, plan, stripe_subscription_id, subscription_status')
      .in('id', ids)

    const profileMap = new Map((profiles ?? []).map(p => [p.id, p]))

    const users = authUsers.map(u => {
      const profile = profileMap.get(u.id)
      return {
        id: u.id,
        email: u.email ?? '(no email)',
        created_at: u.created_at,
        plan: profile?.plan ?? 'free',
        credits: profile?.credits ?? 0,
        stripe_subscription_id: profile?.stripe_subscription_id ?? null,
        subscription_status: profile?.subscription_status ?? null,
      }
    })

    return Response.json({ users, total, page, perPage })
  })
  .post('/:id/credits', async ({ request, params }) => {
    const guard = await requireAdmin(request)
    if (isResponse(guard)) return guard
    const { admin } = guard

    const userId = params.id
    const body = await request.json() as {
      action: 'add' | 'set' | 'reset'
      amount?: number
    }

    if (!['add', 'set', 'reset'].includes(body.action)) {
      return Response.json({ error: 'Action invalide' }, { status: 400 })
    }

    const service = createServiceClient()

    const { data: profile, error: profileErr } = await service
      .from('profiles')
      .select('credits, plan')
      .eq('id', userId)
      .single()

    if (profileErr || !profile) return Response.json({ error: 'Utilisateur introuvable' }, { status: 404 })

    let newCredits: number
    let logDescription: string

    if (body.action === 'add') {
      const amount = Number(body.amount)
      if (!amount || amount <= 0 || !Number.isInteger(amount)) {
        return Response.json({ error: 'Montant invalide' }, { status: 400 })
      }
      newCredits = profile.credits + amount
      logDescription = `Admin (${admin.email}): +${amount} créations ajoutées (ancien: ${profile.credits} → nouveau: ${newCredits})`
    } else if (body.action === 'set') {
      const amount = Number(body.amount)
      if (amount === undefined || amount < 0 || !Number.isInteger(amount)) {
        return Response.json({ error: 'Montant invalide' }, { status: 400 })
      }
      newCredits = amount
      logDescription = `Admin (${admin.email}): créations définies à ${newCredits} (ancien: ${profile.credits})`
    } else {
      const plan = profile.plan as keyof typeof PLANS
      newCredits = PLANS[plan as keyof typeof PLANS]?.credits ?? PLANS.free.credits
      logDescription = `Admin (${admin.email}): créations réinitialisées au plan ${plan} (${newCredits})`
    }

    const { data: updated, error: updateErr } = await service
      .from('profiles')
      .update({ credits: newCredits, updated_at: new Date().toISOString() })
      .eq('id', userId)
      .select('credits')
      .single()

    if (updateErr) {
      console.error('[admin/credits] update error:', updateErr)
      return Response.json({ error: 'Erreur mise à jour' }, { status: 500 })
    }

    await service.from('credit_transactions').insert({
      user_id: userId,
      amount: newCredits - profile.credits,
      type: `admin_credits_${body.action}`,
      description: logDescription,
    })

    return Response.json({ credits: updated.credits })
  })
  .post('/:id/plan', async ({ request, params }) => {
    const guard = await requireAdmin(request)
    if (isResponse(guard)) return guard
    const { admin } = guard

    const userId = params.id
    const body = await request.json() as {
      plan?: string
      resetCredits?: boolean
      cancelSubscription?: boolean
    }

    const plan = body.plan as Plan
    if (!VALID_PLANS.includes(plan)) {
      return Response.json({ error: 'Plan invalide' }, { status: 400 })
    }

    const service = createServiceClient()

    const { data: { user }, error: userErr } = await service.auth.admin.getUserById(userId)
    if (userErr || !user) return Response.json({ error: 'Utilisateur introuvable' }, { status: 404 })

    const updatePayload: Record<string, unknown> = {
      plan,
      updated_at: new Date().toISOString(),
    }

    if (body.resetCredits) {
      updatePayload.credits = PLANS[plan].credits
    }

    if (body.cancelSubscription) {
      updatePayload.stripe_subscription_id = null
      updatePayload.subscription_status = null
    }

    const { data: updated, error: updateErr } = await service
      .from('profiles')
      .update(updatePayload)
      .eq('id', userId)
      .select('credits, plan')
      .single()

    if (updateErr) {
      console.error('[admin/plan] update error:', updateErr)
      return Response.json({ error: 'Erreur mise à jour' }, { status: 500 })
    }

    await service.from('credit_transactions').insert({
      user_id: userId,
      amount: 0,
      type: 'admin_plan_change',
      description: `Admin (${admin.email}): plan changé en ${plan}${body.resetCredits ? ` · créations réinitialisées à ${PLANS[plan].credits}` : ''}${body.cancelSubscription ? ' · abonnement Stripe supprimé' : ''}`,
    })

    return Response.json({ plan: updated.plan, credits: updated.credits })
  })
