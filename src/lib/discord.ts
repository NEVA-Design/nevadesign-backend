import { env } from '../config/env'

// Discord account linking — our own Discord OAuth app, handled entirely by
// this backend (authorization code flow). Supabase Auth is not involved:
// the linked account lives in `profiles.discord_*` columns.

export type DiscordProfile = {
  discordId: string
  username: string
  avatarUrl: string | null
}

// ─── Short-lived state store for the OAuth handoff ─────────────────────────
// Discord's `state` param round-trips through the browser, so we use it to
// remember which of our users initiated the link — no need to smuggle the
// Supabase access token through Discord's URL at all.

type PendingLink = { userId: string; expiresAt: number }

const pendingLinks = new Map<string, PendingLink>()
const STATE_TTL_MS = 5 * 60_000

function cleanupExpired() {
  const now = Date.now()
  for (const [state, entry] of pendingLinks) {
    if (entry.expiresAt < now) pendingLinks.delete(state)
  }
}

export function createPendingLink(userId: string): string {
  cleanupExpired()
  const state = crypto.randomUUID()
  pendingLinks.set(state, { userId, expiresAt: Date.now() + STATE_TTL_MS })
  return state
}

export function consumePendingLink(state: string): string | null {
  const entry = pendingLinks.get(state)
  if (!entry) return null
  pendingLinks.delete(state)
  if (entry.expiresAt < Date.now()) return null
  return entry.userId
}

// ─── Discord OAuth2 — authorization code flow ───────────────────────────────

export function buildDiscordAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    redirect_uri: env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify',
    state,
    prompt: 'consent',
  })
  return `https://discord.com/api/oauth2/authorize?${params.toString()}`
}

export async function exchangeDiscordCode(code: string): Promise<{ access_token: string } | null> {
  const res = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.DISCORD_REDIRECT_URI,
    }),
  })

  if (!res.ok) {
    console.error('[discord] token exchange failed:', res.status, await res.text().catch(() => ''))
    return null
  }

  return (await res.json()) as { access_token: string }
}

export async function fetchDiscordProfile(accessToken: string): Promise<DiscordProfile | null> {
  const res = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!res.ok) {
    console.error('[discord] fetch profile failed:', res.status, await res.text().catch(() => ''))
    return null
  }

  const data = (await res.json()) as {
    id: string
    username: string
    global_name?: string | null
    avatar?: string | null
  }

  const avatarUrl = data.avatar
    ? `https://cdn.discordapp.com/avatars/${data.id}/${data.avatar}.${data.avatar.startsWith('a_') ? 'gif' : 'png'}`
    : null

  return {
    discordId: data.id,
    username: data.global_name || data.username,
    avatarUrl,
  }
}
