import { Elysia } from 'elysia'
import { requireUser, isResponse } from '../lib/require-auth'
import { createServiceClient } from '../lib/supabase'
import { verifyAdmin } from '../lib/admin'
import { PLANS } from '../lib/plans'
import { hasMfaEnabled } from '../lib/mfa'

function isMissingNotificationPrefs(error: { message?: string; code?: string } | null) {
  return Boolean(error?.message?.includes('notification_prefs') || error?.code === 'PGRST204')
}

export const meRoutes = new Elysia({ prefix: '/me' })
  .get('/', async ({ request }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user, supabase } = auth

    const service = createServiceClient()

    const [profileResult, securityEventResult, admin] = await Promise.all([
      supabase
        .from('profiles')
        .select('credits, plan, display_name, avatar_url, bio, notification_prefs, discord_id, discord_username, discord_avatar_url')
        .eq('id', user.id)
        .single(),
      service
        .from('signup_security_events')
        .select('status')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
        .then((res) => res, () => ({ data: null })),
      verifyAdmin(user),
    ])

    let { data: profile, error } = profileResult

    if (isMissingNotificationPrefs(error)) {
      const fallback = await supabase
        .from('profiles')
        .select('credits, plan, display_name, avatar_url, bio, discord_id, discord_username, discord_avatar_url')
        .eq('id', user.id)
        .single()
      profile = fallback.data as typeof profile
    }

    const credits = profile?.credits ?? 0
    const plan = (profile?.plan ?? 'free') as keyof typeof PLANS
    const maxCredits = PLANS[plan]?.credits ?? PLANS.free.credits

    const creditReviewStatus = securityEventResult?.data?.status ?? null

    return Response.json({
      id: user.id,
      email: user.email ?? '',
      user_metadata: user.user_metadata ?? {},
      credits,
      plan,
      maxCredits,
      display_name: profile?.display_name ?? '',
      avatar_url: profile?.avatar_url ?? null,
      discord: profile?.discord_id
        ? { username: profile.discord_username, avatarUrl: profile.discord_avatar_url }
        : null,
      bio: profile?.bio ?? '',
      notification_prefs: profile?.notification_prefs ?? {},
      creditReviewStatus,
      isAdmin: Boolean(admin),
      mfaEnabled: hasMfaEnabled(user),
    })
  })
