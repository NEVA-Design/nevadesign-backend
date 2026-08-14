import { Elysia } from 'elysia'
import { createAnonClient, createServiceClient, getAuth } from '../lib/supabase'
import { evaluateSignupSecurity } from '../lib/signup-security'
import { env } from '../config/env'

function clientIp(request: Request) {
  const raw = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? ''
  return raw.split(',')[0]?.trim() || 'unknown'
}

export const authRoutes = new Elysia({ prefix: '/auth' })
  .post('/signup', async ({ request }) => {
    const body = await request.json().catch(() => null) as {
      email?: string
      password?: string
      display_name?: string
    } | null

    if (!body?.email || !body.password) {
      return Response.json({ error: 'Email et mot de passe requis' }, { status: 400 })
    }

    const email = body.email
    const ip = clientIp(request)
    const origin = request.headers.get('origin') ?? env.SITE_URL
    const userAgent = request.headers.get('user-agent') ?? ''

    const service = createServiceClient()

    const limitDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: attempts, error: attemptError } = await service
      .from('signup_attempts')
      .select('id')
      .eq('ip', ip)
      .gte('created_at', limitDate)

    if (attemptError) {
      console.error('Signup attempt count error:', attemptError)
    }

    if (!attemptError && attempts && attempts.length >= 3) {
      return Response.json({ error: "Trop de tentatives d'inscription depuis cette adresse. Réessaie plus tard." }, { status: 429 })
    }

    const anon = createAnonClient()
    const { data, error } = await anon.auth.signUp({
      email,
      password: body.password,
      options: {
        emailRedirectTo: `${origin}/auth/callback`,
        data: { display_name: body.display_name ?? '' },
      },
    })

    if (error) {
      console.error('Supabase signUp error:', error)
      if (error.message.toLowerCase().includes('sending confirmation email')) {
        return Response.json({ error: "Impossible d'envoyer l'email de confirmation. Vérifie la configuration SMTP/email dans Supabase Auth." }, { status: 400 })
      }
      return Response.json({ error: error.message }, { status: 400 })
    }

    if (data.user?.id) {
      try {
        await evaluateSignupSecurity({
          service,
          userId: data.user.id,
          email,
          ipAddress: ip,
          userAgent,
        })
      } catch (securityError) {
        console.error('Signup security evaluation error:', securityError)
      }
    }

    if (!data.session) {
      return Response.json({
        success: true,
        message: 'Compte créé. Vérifie ta boîte mail pour confirmer ton inscription, puis connecte-toi.',
      })
    }

    return Response.json({
      success: true,
      session: data.session,
      user: data.user,
    })
  })
  .post('/login', async ({ request }) => {
    const body = await request.json().catch(() => null) as { email?: string; password?: string } | null
    if (!body?.email || !body.password) {
      return Response.json({ error: 'Email et mot de passe requis' }, { status: 400 })
    }

    const anon = createAnonClient()
    const { data, error } = await anon.auth.signInWithPassword({
      email: body.email,
      password: body.password,
    })

    if (error) {
      return Response.json({ error: error.message }, { status: 401 })
    }

    return Response.json({ success: true, session: data.session, user: data.user })
  })
  .post('/forgot-password', async ({ request }) => {
    const body = await request.json().catch(() => null) as { email?: string } | null
    if (!body?.email) {
      return Response.json({ error: 'Email requis' }, { status: 400 })
    }

    const origin = request.headers.get('origin') ?? env.SITE_URL
    const anon = createAnonClient()
    const { error } = await anon.auth.resetPasswordForEmail(body.email, {
      redirectTo: `${origin}/auth/callback?next=/dashboard/settings`,
    })

    // Never leak whether an email exists — always report success.
    if (error) console.error('resetPasswordForEmail error:', error)
    return Response.json({ success: true })
  })
  .post('/refresh', async ({ request }) => {
    const body = await request.json().catch(() => null) as { refresh_token?: string } | null
    if (!body?.refresh_token) {
      return Response.json({ error: 'refresh_token requis' }, { status: 400 })
    }

    const anon = createAnonClient()
    const { data, error } = await anon.auth.refreshSession({ refresh_token: body.refresh_token })

    if (error || !data.session) {
      return Response.json({ error: error?.message ?? 'Session invalide' }, { status: 401 })
    }

    return Response.json({ success: true, session: data.session, user: data.user })
  })
  // Redirects the browser straight to Supabase's hosted OAuth flow — GoTrue
  // handles the provider round-trip itself and redirects back to the
  // frontend's callback page with tokens in the URL fragment. No PKCE/code
  // exchange needed here since the frontend never touches Supabase directly.
  .get('/google', ({ request }) => {
    const url = new URL(request.url)
    const origin = request.headers.get('origin') ?? url.searchParams.get('origin') ?? env.SITE_URL
    const next = url.searchParams.get('next') ?? '/dashboard'
    const redirectTo = `${origin}/auth/callback?next=${encodeURIComponent(next)}`
    const authorizeUrl = `${env.SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`
    return Response.redirect(authorizeUrl, 302)
  })
  // Called by the frontend's callback page right after it picks up the
  // access/refresh tokens from the OAuth redirect fragment — runs the same
  // one-time signup-security check the password signup flow gets.
  .post('/oauth-complete', async ({ request }) => {
    const auth = await getAuth(request)
    if (!auth) return Response.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()
    const { data: existingEvent } = await service
      .from('signup_security_events')
      .select('id')
      .eq('user_id', auth.user.id)
      .maybeSingle()

    if (!existingEvent) {
      const ip = clientIp(request)
      const email = auth.user.email ?? 'unknown'
      const userAgent = request.headers.get('user-agent') ?? ''

      try {
        await evaluateSignupSecurity({ service, userId: auth.user.id, email, ipAddress: ip, userAgent })
      } catch (securityError) {
        console.error('OAuth signup security evaluation error:', securityError)
      }
    }

    return Response.json({ ok: true })
  })
