import type { User } from '@supabase/supabase-js'
import { env } from '../config/env'

// Two-factor auth (TOTP) via Supabase Auth's built-in MFA — raw REST calls
// (same pattern as everywhere else in this backend: we don't keep a
// supabase-js client with a live session, so we drive GoTrue's factor
// endpoints directly with the user's bearer token).

const AUTH_URL = `${env.SUPABASE_URL}/auth/v1`

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    apikey: env.SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
  }
}

export type TotpFactor = {
  id: string
  factor_type: string
  status: 'verified' | 'unverified'
  friendly_name?: string
}

export function getVerifiedTotpFactor(user: User): TotpFactor | null {
  const factors = (user.factors ?? []) as TotpFactor[]
  return factors.find((f) => f.factor_type === 'totp' && f.status === 'verified') ?? null
}

export function hasMfaEnabled(user: User): boolean {
  return getVerifiedTotpFactor(user) !== null
}

export async function enrollTotp(token: string): Promise<
  { ok: true; factorId: string; qrCode: string; secret: string; uri: string } | { ok: false; message: string }
> {
  const res = await fetch(`${AUTH_URL}/factors`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ factor_type: 'totp', issuer: 'Neva Design' }),
  })

  const body = await res.json().catch(() => null) as {
    id?: string
    totp?: { qr_code?: string; secret?: string; uri?: string }
    msg?: string
    message?: string
    error_description?: string
  } | null

  if (!res.ok || !body?.id || !body.totp) {
    return { ok: false, message: body?.msg ?? body?.message ?? body?.error_description ?? 'Impossible de démarrer l’activation de l’A2F' }
  }

  return {
    ok: true,
    factorId: body.id,
    qrCode: body.totp.qr_code ?? '',
    secret: body.totp.secret ?? '',
    uri: body.totp.uri ?? '',
  }
}

export async function unenrollFactor(token: string, factorId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const res = await fetch(`${AUTH_URL}/factors/${factorId}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  })

  if (!res.ok) {
    const body = await res.json().catch(() => null) as { msg?: string; message?: string } | null
    return { ok: false, message: body?.msg ?? body?.message ?? 'Erreur lors de la désactivation de l’A2F' }
  }

  return { ok: true }
}

async function createChallenge(token: string, factorId: string): Promise<{ ok: true; challengeId: string } | { ok: false; message: string }> {
  const res = await fetch(`${AUTH_URL}/factors/${factorId}/challenge`, {
    method: 'POST',
    headers: authHeaders(token),
  })

  const body = await res.json().catch(() => null) as { id?: string; msg?: string; message?: string } | null
  if (!res.ok || !body?.id) {
    return { ok: false, message: body?.msg ?? body?.message ?? 'Impossible de générer le défi A2F' }
  }

  return { ok: true, challengeId: body.id }
}

async function verifyChallenge(
  token: string,
  factorId: string,
  challengeId: string,
  code: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const res = await fetch(`${AUTH_URL}/factors/${factorId}/verify`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ challenge_id: challengeId, code }),
  })

  if (!res.ok) {
    const body = await res.json().catch(() => null) as { msg?: string; message?: string } | null
    return { ok: false, message: body?.msg ?? body?.message ?? 'Code invalide' }
  }

  return { ok: true }
}

// Challenge + verify in one call — used both to confirm a fresh enrollment
// and as a step-up check before a sensitive action (e.g. changing email).
export async function challengeAndVerifyTotp(
  token: string,
  factorId: string,
  code: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const challenge = await createChallenge(token, factorId)
  if (!challenge.ok) return challenge
  return verifyChallenge(token, factorId, challenge.challengeId, code)
}
