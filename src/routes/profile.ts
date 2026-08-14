import { Elysia } from 'elysia'
import { requireUser, isResponse } from '../lib/require-auth'
import { createAnonClient, createServiceClient, getAuthFromToken } from '../lib/supabase'
import {
  buildDiscordAuthorizeUrl,
  consumePendingLink,
  createPendingLink,
  exchangeDiscordCode,
  fetchDiscordProfile,
} from '../lib/discord'
import { challengeAndVerifyTotp, enrollTotp, getVerifiedTotpFactor, unenrollFactor } from '../lib/mfa'
import { env } from '../config/env'

function isMissingNotificationPrefs(error: { message?: string; code?: string } | null) {
  return Boolean(error?.message?.includes('notification_prefs') || error?.code === 'PGRST204')
}

export const profileRoutes = new Elysia({ prefix: '/profile' })
  .get('/', async ({ request }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user, supabase } = auth

    let { data: profile, error } = await supabase
      .from('profiles')
      .select('display_name, avatar_url, bio, notification_prefs, discord_id, discord_username, discord_avatar_url')
      .eq('id', user.id)
      .single()

    if (isMissingNotificationPrefs(error)) {
      const fallback = await supabase
        .from('profiles')
        .select('display_name, avatar_url, bio, discord_id, discord_username, discord_avatar_url')
        .eq('id', user.id)
        .single()
      profile = fallback.data as typeof profile
    }

    return Response.json({
      email: user.email ?? '',
      display_name: profile?.display_name ?? '',
      avatar_url: profile?.avatar_url ?? null,
      bio: profile?.bio ?? '',
      notification_prefs: profile?.notification_prefs ?? {},
      discord: profile?.discord_id
        ? { username: profile.discord_username, avatarUrl: profile.discord_avatar_url }
        : null,
    })
  })
  .patch('/', async ({ request }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user, supabase } = auth

    let body: Record<string, unknown>
    try {
      body = await request.json() as Record<string, unknown>
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }

    if (typeof body.display_name === 'string') {
      updates.display_name = body.display_name.slice(0, 100).trim()
    }
    if (typeof body.bio === 'string') {
      updates.bio = body.bio.slice(0, 500)
    }
    if (
      body.notification_prefs !== undefined &&
      typeof body.notification_prefs === 'object' &&
      body.notification_prefs !== null
    ) {
      const prefs = body.notification_prefs as Record<string, unknown>
      updates.notification_prefs = {
        sound: Boolean(prefs.sound),
        browser: Boolean(prefs.browser),
      }
    }

    let { error } = await supabase.from('profiles').update(updates).eq('id', user.id)
    if (isMissingNotificationPrefs(error) && 'notification_prefs' in updates) {
      delete updates.notification_prefs
      const retry = await supabase.from('profiles').update(updates).eq('id', user.id)
      error = retry.error
    }
    if (error) {
      return Response.json({ success: false, error: { code: 'profile_update_failed', message: error.message } }, { status: 500 })
    }

    return Response.json({ success: true, data: { ok: true }, ok: true })
  })
  .post('/avatar', async ({ request }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user } = auth

    let formData: Awaited<ReturnType<typeof request.formData>>
    try {
      formData = await request.formData()
    } catch {
      return Response.json({ error: 'Invalid form data' }, { status: 400 })
    }

    const file = formData.get('avatar')
    if (!file || !(file instanceof File)) {
      return Response.json({ error: 'No file provided' }, { status: 400 })
    }

    if (file.size > 4 * 1024 * 1024) {
      return Response.json({ error: 'Fichier trop lourd — max 4 Mo' }, { status: 400 })
    }

    const ALLOWED = ['image/jpeg', 'image/png', 'image/webp']
    if (!ALLOWED.includes(file.type)) {
      return Response.json({ error: 'Format invalide — JPG, PNG ou WebP uniquement' }, { status: 400 })
    }

    const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'
    const storagePath = `${user.id}/avatar.${ext}`

    const bytes = await file.arrayBuffer()
    const buffer = Buffer.from(bytes)

    const service = createServiceClient()

    const { error: uploadError } = await service.storage
      .from('avatars')
      .upload(storagePath, buffer, { contentType: file.type, upsert: true })

    if (uploadError) {
      console.error('[avatar upload]', uploadError.message)
      return Response.json({ error: `Upload échoué: ${uploadError.message}` }, { status: 500 })
    }

    const { data: { publicUrl } } = service.storage.from('avatars').getPublicUrl(storagePath)
    const urlWithCacheBust = `${publicUrl}?t=${Date.now()}`

    await service
      .from('profiles')
      .update({ avatar_url: urlWithCacheBust, updated_at: new Date().toISOString() })
      .eq('id', user.id)

    return Response.json({ url: urlWithCacheBust })
  })
  .post('/password', async ({ request }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { supabase } = auth

    const body = await request.json().catch(() => null) as { password?: string } | null
    if (!body?.password || body.password.length < 6) {
      return Response.json({ error: 'Mot de passe invalide — 6 caractères minimum' }, { status: 400 })
    }

    const { error } = await supabase.auth.updateUser({ password: body.password })
    if (error) {
      return Response.json({ error: error.message }, { status: 400 })
    }

    return Response.json({ success: true })
  })
  // Browser navigation (not a fetch), so it can't carry an Authorization
  // header — the frontend passes the access token as a query param
  // instead. Only ever seen by our own backend and the user's browser.
  .get('/discord/link', async ({ request }) => {
    const url = new URL(request.url)
    const token = url.searchParams.get('token')
    const origin = request.headers.get('origin') ?? url.searchParams.get('origin') ?? env.SITE_URL

    if (!token) return Response.json({ error: 'Unauthorized' }, { status: 401 })

    const auth = await getAuthFromToken(token)
    if (!auth) return Response.json({ error: 'Unauthorized' }, { status: 401 })

    if (!env.DISCORD_CLIENT_ID || !env.DISCORD_REDIRECT_URI) {
      console.error('[profile/discord/link] Discord OAuth app not configured')
      return Response.redirect(`${origin}/dashboard/settings?discordError=not_configured`, 302)
    }

    const state = createPendingLink(auth.user.id)
    return Response.redirect(buildDiscordAuthorizeUrl(state), 302)
  })
  // Discord redirects the browser here directly after consent — this must
  // match DISCORD_REDIRECT_URI exactly, registered on the Discord Developer
  // Portal. We exchange the code ourselves (client secret never leaves the
  // backend) and store the linked account with the service role, keyed by
  // the userId resolved from `state` — no Supabase identity involved.
  .get('/discord/callback', async ({ request }) => {
    const url = new URL(request.url)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const origin = env.SITE_URL

    if (!code || !state) {
      return Response.redirect(`${origin}/dashboard/settings?discordError=missing_code`, 302)
    }

    const userId = consumePendingLink(state)
    if (!userId) {
      return Response.redirect(`${origin}/dashboard/settings?discordError=expired`, 302)
    }

    const tokenResponse = await exchangeDiscordCode(code)
    if (!tokenResponse) {
      return Response.redirect(`${origin}/dashboard/settings?discordError=token_exchange_failed`, 302)
    }

    const discordProfile = await fetchDiscordProfile(tokenResponse.access_token)
    if (!discordProfile) {
      return Response.redirect(`${origin}/dashboard/settings?discordError=profile_fetch_failed`, 302)
    }

    const service = createServiceClient()
    const { error } = await service
      .from('profiles')
      .update({
        discord_id: discordProfile.discordId,
        discord_username: discordProfile.username,
        discord_avatar_url: discordProfile.avatarUrl,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)

    if (error) {
      console.error('[profile/discord/callback] db update failed:', error)
      return Response.redirect(`${origin}/dashboard/settings?discordError=save_failed`, 302)
    }

    return Response.redirect(`${origin}/dashboard/settings?discordLinked=1`, 302)
  })
  .post('/discord/unlink', async ({ request }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user, supabase } = auth

    const { error } = await supabase
      .from('profiles')
      .update({
        discord_id: null,
        discord_username: null,
        discord_avatar_url: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id)

    if (error) {
      console.error('[profile/discord/unlink] failed:', error)
      return Response.json({ error: 'Erreur lors de la déconnexion Discord' }, { status: 500 })
    }

    return Response.json({ success: true })
  })
  // --- Two-factor auth (TOTP) --------------------------------------------
  .post('/2fa/enroll', async ({ request }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user, token } = auth

    const existing = getVerifiedTotpFactor(user)
    if (existing) {
      return Response.json({ error: 'A2F déjà activée' }, { status: 400 })
    }

    const result = await enrollTotp(token)
    if (!result.ok) {
      return Response.json({ error: result.message }, { status: 400 })
    }

    return Response.json({
      factorId: result.factorId,
      qrCode: result.qrCode,
      secret: result.secret,
      uri: result.uri,
    })
  })
  .post('/2fa/enroll/verify', async ({ request }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { token } = auth

    const body = await request.json().catch(() => null) as { factorId?: string; code?: string } | null
    if (!body?.factorId || !body?.code) {
      return Response.json({ error: 'Code manquant' }, { status: 400 })
    }

    const result = await challengeAndVerifyTotp(token, body.factorId, body.code)
    if (!result.ok) {
      return Response.json({ error: result.message }, { status: 400 })
    }

    return Response.json({ success: true })
  })
  .post('/2fa/disable', async ({ request }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user, token } = auth

    const factor = getVerifiedTotpFactor(user)
    if (!factor) {
      return Response.json({ error: 'A2F non activée' }, { status: 400 })
    }

    const body = await request.json().catch(() => null) as { code?: string } | null
    if (!body?.code) {
      return Response.json({ error: 'Code A2F requis pour désactiver' }, { status: 400 })
    }

    const check = await challengeAndVerifyTotp(token, factor.id, body.code)
    if (!check.ok) {
      return Response.json({ error: check.message }, { status: 400 })
    }

    const result = await unenrollFactor(token, factor.id)
    if (!result.ok) {
      return Response.json({ error: result.message }, { status: 400 })
    }

    return Response.json({ success: true })
  })
  // --- Email change, gated by password or 2FA -----------------------------
  .post('/email', async ({ request }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user, supabase } = auth

    const body = await request.json().catch(() => null) as
      | { newEmail?: string; password?: string; code?: string }
      | null

    const newEmail = body?.newEmail?.trim().toLowerCase()
    if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      return Response.json({ error: 'Adresse email invalide' }, { status: 400 })
    }
    if (newEmail === user.email) {
      return Response.json({ error: 'Cette adresse est déjà la tienne' }, { status: 400 })
    }

    const factor = getVerifiedTotpFactor(user)

    if (factor) {
      if (!body?.code) {
        return Response.json({ error: 'Code A2F requis' }, { status: 400 })
      }
      const check = await challengeAndVerifyTotp(auth.token, factor.id, body.code)
      if (!check.ok) {
        return Response.json({ error: check.message }, { status: 400 })
      }
    } else {
      if (!body?.password) {
        return Response.json({ error: 'Mot de passe requis' }, { status: 400 })
      }
      if (!user.email) {
        return Response.json({ error: 'Compte invalide' }, { status: 400 })
      }
      const anon = createAnonClient()
      const { error: signInError } = await anon.auth.signInWithPassword({
        email: user.email,
        password: body.password,
      })
      if (signInError) {
        return Response.json({ error: 'Mot de passe incorrect' }, { status: 400 })
      }
    }

    const { error } = await supabase.auth.updateUser({ email: newEmail })
    if (error) {
      return Response.json({ error: error.message }, { status: 400 })
    }

    return Response.json({
      success: true,
      message: 'Vérifie ta boîte mail pour confirmer le changement d’adresse.',
    })
  })
