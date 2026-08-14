import { Elysia } from 'elysia'
import { requireUser, isResponse } from '../lib/require-auth'
import { createServiceClient } from '../lib/supabase'

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
      .select('display_name, avatar_url, discord_handle, bio, notification_prefs')
      .eq('id', user.id)
      .single()

    if (isMissingNotificationPrefs(error)) {
      const fallback = await supabase
        .from('profiles')
        .select('display_name, avatar_url, discord_handle, bio')
        .eq('id', user.id)
        .single()
      profile = fallback.data as typeof profile
    }

    return Response.json({
      email: user.email ?? '',
      display_name: profile?.display_name ?? '',
      avatar_url: profile?.avatar_url ?? null,
      discord_handle: profile?.discord_handle ?? '',
      bio: profile?.bio ?? '',
      notification_prefs: profile?.notification_prefs ?? {},
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
    if (typeof body.discord_handle === 'string') {
      updates.discord_handle = body.discord_handle.slice(0, 50).trim()
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
