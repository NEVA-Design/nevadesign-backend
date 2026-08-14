import { getAuth, type AuthContext } from './supabase'
import { verifyAdmin, type VerifiedAdmin } from './admin'

export async function requireUser(request: Request): Promise<AuthContext | Response> {
  const auth = await getAuth(request)
  if (!auth) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  return auth
}

export function isResponse(value: unknown): value is Response {
  return value instanceof Response
}

export async function requireAdmin(request: Request): Promise<{ auth: AuthContext; admin: VerifiedAdmin } | Response> {
  const auth = await getAuth(request)
  if (!auth) return Response.json({ error: 'Forbidden' }, { status: 403 })

  const admin = await verifyAdmin(auth.user)
  if (!admin) return Response.json({ error: 'Forbidden' }, { status: 403 })

  return { auth, admin }
}
