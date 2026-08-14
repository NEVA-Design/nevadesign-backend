import type { SupabaseClient, User } from '@supabase/supabase-js'
import { env } from '../config/env'
import { createServiceClient } from './supabase'

export type VerifiedAdmin = {
  userId: string
  email: string
  source: 'env' | 'database'
}

export function getBootstrapAdminEmails() {
  return env.ADMIN_EMAILS.split(',').map((email) => email.trim().toLowerCase()).filter(Boolean)
}

// ADMIN_EMAILS remains the bootstrap safety list. Database admins are managed from /admin/admins.
export async function verifyAdmin(user: User | null, _supabase?: SupabaseClient): Promise<VerifiedAdmin | null> {
  if (!user?.email) return null

  const email = user.email.toLowerCase()
  if (getBootstrapAdminEmails().includes(email)) {
    return { userId: user.id, email: user.email, source: 'env' }
  }

  try {
    const service = createServiceClient()
    const { data } = await service
      .from('admin_users')
      .select('email')
      .eq('email', email)
      .eq('is_active', true)
      .maybeSingle()

    if (!data) return null
    return { userId: user.id, email: user.email, source: 'database' }
  } catch (error) {
    console.error('[admin] verify database admin failed:', error)
    return null
  }
}
