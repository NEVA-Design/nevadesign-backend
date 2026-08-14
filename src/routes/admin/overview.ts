import { Elysia } from 'elysia'
import { requireAdmin, isResponse } from '../../lib/require-auth'
import { createServiceClient } from '../../lib/supabase'
import { PLANS } from '../../lib/plans'

type ProfileRow = {
  id: string
  credits: number | null
  plan: keyof typeof PLANS | string | null
  created_at: string | null
}

type TransactionRow = {
  amount: number | null
  type: string | null
  created_at: string | null
}

function dayKey(date: Date) {
  return date.toISOString().slice(0, 10)
}

function lastDays(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date()
    date.setDate(date.getDate() - (count - 1 - index))
    return dayKey(date)
  })
}

export const adminOverviewRoutes = new Elysia()
  .get('/admin/verify', async ({ request }) => {
    const guard = await requireAdmin(request)
    if (isResponse(guard)) return guard
    return Response.json({ email: guard.admin.email, source: guard.admin.source })
  })
  .get('/admin/overview', async ({ request }) => {
    const guard = await requireAdmin(request)
    if (isResponse(guard)) return guard

    const service = createServiceClient()
    const [{ data: profiles }, { data: transactions }, { data: authUsers }, { data: securityEvents }] = await Promise.all([
      service.from('profiles').select('id, credits, plan, created_at'),
      service.from('credit_transactions').select('amount, type, created_at').order('created_at', { ascending: false }).limit(700),
      service.auth.admin.listUsers({ page: 1, perPage: 1000 }),
      service.from('signup_security_events').select('status, ip_address, risk_score, created_at').order('created_at', { ascending: false }).limit(500),
    ])

    const profileRows = (profiles ?? []) as ProfileRow[]
    const transactionRows = (transactions ?? []) as TransactionRow[]
    const totalUsers = authUsers?.users.length ?? profileRows.length
    const paidUsers = profileRows.filter((profile) => profile.plan && profile.plan !== 'free').length
    const freeUsers = Math.max(totalUsers - paidUsers, 0)
    const conversionRate = totalUsers > 0 ? (paidUsers / totalUsers) * 100 : 0
    const monthlyRevenue = profileRows.reduce((sum, profile) => {
      const plan = profile.plan && profile.plan in PLANS ? PLANS[profile.plan as keyof typeof PLANS] : null
      return sum + (plan && plan.id !== 'free' ? plan.price : 0)
    }, 0)
    const creditsRemaining = profileRows.reduce((sum, profile) => sum + Math.max(profile.credits ?? 0, 0), 0)
    const creditsConsumed = Math.abs(transactionRows.filter((tx) => (tx.amount ?? 0) < 0).reduce((sum, tx) => sum + (tx.amount ?? 0), 0))
    const purchasedCredits = transactionRows.filter((tx) => (tx.amount ?? 0) > 0 && ['topup', 'purchase', 'subscription'].some((type) => (tx.type ?? '').includes(type))).reduce((sum, tx) => sum + (tx.amount ?? 0), 0)
    const nowMs = new Date().getTime()
    const dailyGenerations = transactionRows.filter((tx) => (tx.amount ?? 0) < 0 && tx.created_at && nowMs - new Date(tx.created_at).getTime() < 86400000).length
    const monthlyGenerations = transactionRows.filter((tx) => (tx.amount ?? 0) < 0 && tx.created_at && nowMs - new Date(tx.created_at).getTime() < 30 * 86400000).length
    const securityRows = securityEvents ?? []
    const todayKey = dayKey(new Date())
    const pendingSecurityAlerts = securityRows.filter((event) => event.status === 'pending_review').length
    const blockedFreeCreditAttempts = securityRows.filter((event) => event.status === 'blocked' || event.status === 'rejected_by_admin').length
    const duplicateIpSignupsToday = securityRows.filter((event) => event.created_at?.startsWith(todayKey) && (event.risk_score ?? 0) >= 60).length
    const estimatedCreditsSaved = blockedFreeCreditAttempts * PLANS.free.credits

    const days = lastDays(14)
    const generationSeries = days.map((day) => ({
      day,
      value: transactionRows.filter((tx) => (tx.amount ?? 0) < 0 && tx.created_at?.startsWith(day)).length,
    }))

    const planCounts = (Object.keys(PLANS) as Array<keyof typeof PLANS>).map((plan) => ({
      plan,
      label: PLANS[plan].name,
      count: profileRows.filter((profile) => (profile.plan ?? 'free') === plan).length,
    }))

    return Response.json({
      totalUsers,
      paidUsers,
      freeUsers,
      conversionRate,
      monthlyRevenue,
      creditsRemaining,
      creditsConsumed,
      purchasedCredits,
      dailyGenerations,
      monthlyGenerations,
      pendingSecurityAlerts,
      blockedFreeCreditAttempts,
      duplicateIpSignupsToday,
      estimatedCreditsSaved,
      generationSeries,
      planCounts,
    })
  })
