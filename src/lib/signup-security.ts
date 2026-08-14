import type { SupabaseClient } from '@supabase/supabase-js'

export const FREE_SIGNUP_CREDITS = 3

export type SignupSecurityStatus =
  | 'allowed'
  | 'blocked'
  | 'pending_review'
  | 'approved_by_admin'
  | 'rejected_by_admin'

export type SignupSecurityEvent = {
  id: string
  user_id: string
  email: string
  ip_address: string
  matching_user_ids: string[]
  risk_score: number
  reason: string
  status: SignupSecurityStatus
  created_at: string
}

type SignupAttemptRow = {
  user_id: string | null
}

type CreditTransactionRow = {
  user_id: string
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)))
}

async function grantSignupCreditsOnce(
  service: SupabaseClient,
  userId: string,
  description = '3 creations offertes a l inscription',
) {
  const { data: existing } = await service
    .from('credit_transactions')
    .select('id')
    .eq('user_id', userId)
    .eq('type', 'signup_bonus')
    .maybeSingle()

  if (existing) return false

  await service
    .from('profiles')
    .upsert({ id: userId, credits: 0, plan: 'free', updated_at: new Date().toISOString() }, { onConflict: 'id' })

  const { error: incrementError } = await service.rpc('increment_credits', {
    user_id: userId,
    amount: FREE_SIGNUP_CREDITS,
  })

  if (incrementError) throw incrementError

  const { error: txError } = await service.from('credit_transactions').insert({
    user_id: userId,
    amount: FREE_SIGNUP_CREDITS,
    type: 'signup_bonus',
    description,
  })

  if (txError) throw txError
  return true
}

export async function evaluateSignupSecurity({
  service,
  userId,
  email,
  ipAddress,
  userAgent,
}: {
  service: SupabaseClient
  userId: string
  email: string
  ipAddress: string
  userAgent: string
}) {
  const now = new Date().toISOString()

  await service.from('signup_attempts').insert({
    user_id: userId,
    ip: ipAddress,
    email,
    user_agent: userAgent,
    created_at: now,
  })

  if (!ipAddress || ipAddress === 'unknown') {
    const event = {
      user_id: userId,
      email,
      ip_address: ipAddress || 'unknown',
      matching_user_ids: [],
      risk_score: 55,
      reason: 'Adresse de creation non verifiable. Credits gratuits en attente de validation.',
      status: 'pending_review' as SignupSecurityStatus,
    }

    await service.from('signup_security_events').insert(event)
    return event
  }

  const { data: attempts } = await service
    .from('signup_attempts')
    .select('user_id')
    .eq('ip', ipAddress)
    .neq('user_id', userId)
    .not('user_id', 'is', null)

  const matchingUserIds = unique(((attempts ?? []) as SignupAttemptRow[])
    .map((attempt) => attempt.user_id)
    .filter((id): id is string => Boolean(id)))

  if (matchingUserIds.length === 0) {
    await grantSignupCreditsOnce(service, userId)

    const event = {
      user_id: userId,
      email,
      ip_address: ipAddress,
      matching_user_ids: [],
      risk_score: 0,
      reason: 'Aucun compte precedent detecte sur cette adresse.',
      status: 'allowed' as SignupSecurityStatus,
    }

    await service.from('signup_security_events').insert(event)
    return event
  }

  const { data: bonusRows } = await service
    .from('credit_transactions')
    .select('user_id')
    .eq('type', 'signup_bonus')
    .in('user_id', matchingUserIds)

  const confirmedBonusUserIds = unique(((bonusRows ?? []) as CreditTransactionRow[]).map((row) => row.user_id))

  const hasConfirmedFreeCreditMatch = confirmedBonusUserIds.length > 0
  const event = hasConfirmedFreeCreditMatch
    ? {
        user_id: userId,
        email,
        ip_address: ipAddress,
        matching_user_ids: confirmedBonusUserIds,
        risk_score: 92,
        reason: 'Adresse deja associee a un compte ayant recu les credits gratuits.',
        status: 'blocked' as SignupSecurityStatus,
      }
    : {
        user_id: userId,
        email,
        ip_address: ipAddress,
        matching_user_ids: matchingUserIds,
        risk_score: 65,
        reason: 'Adresse deja associee a un ou plusieurs comptes. Validation admin requise.',
        status: 'pending_review' as SignupSecurityStatus,
      }

  await service.from('signup_security_events').insert(event)
  return event
}

export async function approveSignupCredits(service: SupabaseClient, userId: string, adminEmail: string) {
  return grantSignupCreditsOnce(service, userId, `Credits gratuits approuves par ${adminEmail}`)
}
