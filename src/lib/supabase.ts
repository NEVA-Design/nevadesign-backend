import { createClient as createSupabaseClient, type SupabaseClient, type User } from '@supabase/supabase-js'
import { env } from '../config/env'

export function createServiceClient(): SupabaseClient {
  return createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export function createAnonClient(): SupabaseClient {
  return createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

// Per-request client scoped to the caller's JWT — RLS policies apply as if
// this were the logged-in user (auth.uid() resolves from the token).
export function createUserClient(accessToken: string): SupabaseClient {
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

  const supabase = createUserClient(token)
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null

  return { user: data.user, token, supabase }
}
