import { createClient as createSupabaseClient, type SupabaseClient, type User } from '@supabase/supabase-js'
import { env } from '../config/env'
import { devClient, devLocalEnabled } from './dev-local'

export function createServiceClient(): SupabaseClient {
  if (devLocalEnabled()) return devClient() as unknown as SupabaseClient
  return createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export function createAnonClient(): SupabaseClient {
  if (devLocalEnabled()) return devClient() as unknown as SupabaseClient
  return createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

// Per-request client scoped to the caller's JWT — RLS policies apply as if
// this were the logged-in user (auth.uid() resolves from the token).
export function createUserClient(accessToken: string): SupabaseClient {
  if (devLocalEnabled()) return devClient() as unknown as SupabaseClient
  return createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  })
}

export type AuthContext = {
  user: User
  token: string
  supabase: SupabaseClient
}

function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? request.headers.get('Authorization')
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token || null
}

export async function getAuth(request: Request): Promise<AuthContext | null> {
  const token = extractBearerToken(request)
  if (!token) return null
  return getAuthFromToken(token)
}

// For flows where the token can't travel as a header — e.g. a plain
// browser navigation kicking off an OAuth redirect — and arrives as a
// query param instead.
export async function getAuthFromToken(token: string): Promise<AuthContext | null> {
  const supabase = createUserClient(token)
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null

  return { user: data.user, token, supabase }
}
