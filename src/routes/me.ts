import { Elysia } from 'elysia'
import { requireUser, isResponse } from '../lib/require-auth'
import { createServiceClient } from '../lib/supabase'
import { PLANS } from '../lib/plans'

function isMissingNotificationPrefs(error: { message?: string; code?: string } | null) {
  return Boolean(error?.message?.includes('notification_prefs') || error?.code === 'PGRST204')
}

export const meRoutes = new Elysia({ prefix: '/me' })
  .get('/', async ({ request }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user, supabase } = auth

    let { data: profile, error } = await supabase
      .from('profiles')
      .select('credits, plan, display_name, avatar_url, discord_handle, bio, notification_prefs')
      .eq('id', user.id)
      .single()

    if (isMissingNotificationPrefs(error)) {
      const fallback = await supabase
        .from('profiles')
        .select('credits, plan, display_name, avatar_url, discord_handle, bio')
        .eq('id', user.id)
        .single()
      profile = fallback.data as typeof profile
    }

    const credits = profile?.credits ?? 0
    const plan = (profile?.plan ?? 'free') as keyof typeof PLANS
    const maxCredits = PLANS[plan]?.credits ?? PLANS.free.credits

    let creditReviewStatus: string | null = null
    try {
      const service = createServiceClient()
      const { data: securityEvent } = await service
        .from('signup_security_events')
        .select('status')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      creditReviewStatus = securityEvent?.status ?? null
    } catch {
      creditReviewStatus = null
    }

    return Response.json({
      id: user.id,
      email: user.email ?? '',
      user_metadata: user.user_metadata ?? {},
      credits,
      plan,
      maxCredits,
      display_name: profile?.display_name ?? '',
      avatar_url: profile?.avatar_url ?? null,
      discord_handle: profile?.discord_handle ?? '',
      bio: profile?.bio ?? '',
      notification_prefs: profile?.notification_prefs ?? {},
      creditReviewStatus,
    })
  })
