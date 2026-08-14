import type { SupabaseClient } from '@supabase/supabase-js'

export async function getCredits(supabase: SupabaseClient, userId: string): Promise<number> {
  const { data } = await supabase.from('profiles').select('credits').eq('id', userId).single()
  return data?.credits ?? 0
}

export async function deductCredits(
  supabase: SupabaseClient,
  userId: string,
  amount: number,
  type: string,
  description: string
): Promise<{ success: boolean; remaining: number }> {
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('credits')
    .eq('id', userId)
    .single()

  if (!error && profile && amount <= 0) {
    return { success: true, remaining: profile.credits }
  }

  if (error || !profile || profile.credits < amount) {
    return { success: false, remaining: profile?.credits ?? 0 }
  }

  const newCredits = profile.credits - amount

  await supabase
    .from('profiles')
    .update({ credits: newCredits, updated_at: new Date().toISOString() })
    .eq('id', userId)

  await supabase.from('credit_transactions').insert({
    user_id: userId,
    amount: -amount,
    type,
    description,
  })

  return { success: true, remaining: newCredits }
}

export async function addCredits(
  supabase: SupabaseClient,
  userId: string,
  amount: number,
  type: string,
  description: string
): Promise<void> {
  await supabase.rpc('increment_credits', { user_id: userId, amount })

  await supabase.from('credit_transactions').insert({
    user_id: userId,
    amount,
    type,
    description,
  })
}
