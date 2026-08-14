import { Elysia } from 'elysia'
import { requireUser, isResponse } from '../lib/require-auth'
import { ONE_SHOT_PACKS } from '../lib/resources'

const USAGE_TYPES = ['chat', 'image_generation', 'image_enhancement', 'image_audit', 'image_audit_improved', 'character_asset']

export const dashboardRoutes = new Elysia({ prefix: '/dashboard' })
  .get('/overview', async ({ request }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user, supabase } = auth

    const monthStart = new Date()
    monthStart.setDate(1)
    monthStart.setHours(0, 0, 0, 0)

    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    const [{ count: todayCount }, { count: monthCount }, { data: announcementRaw }, { data: recentRaw }] = await Promise.all([
      supabase
        .from('credit_transactions')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .in('type', USAGE_TYPES)
        .gte('created_at', todayStart.toISOString()),
      supabase
        .from('credit_transactions')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .in('type', USAGE_TYPES)
        .gte('created_at', monthStart.toISOString()),
      supabase
        .from('site_announcements')
        .select('*')
        .eq('is_active', true)
        .order('priority', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(2),
      supabase
        .from('credit_transactions')
        .select('type, description, amount, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(8),
    ])

    const recentActivity = (recentRaw ?? []).filter((t) => USAGE_TYPES.includes(t.type))

    return Response.json({
      todayCount: todayCount ?? 0,
      monthCount: monthCount ?? 0,
      announcements: announcementRaw ?? [],
      recentActivity,
    })
  })
  .get('/downloads', async ({ request }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user, supabase } = auth

    const { data: purchases } = await supabase
      .from('resource_purchases')
      .select('resource_id, created_at')
      .eq('user_id', user.id)

    const ownedIds = new Set((purchases ?? []).map((p) => p.resource_id))

    const ownedPacks = Object.values(ONE_SHOT_PACKS)
      .filter((p) => ownedIds.has(p.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        tagline: p.tagline,
        downloadUrl: p.downloadUrl,
        purchasedAt: purchases?.find((pu) => pu.resource_id === p.id)?.created_at ?? null,
      }))

    return Response.json({ ownedPacks })
  })
