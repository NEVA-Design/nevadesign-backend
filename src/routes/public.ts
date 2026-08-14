import { Elysia } from 'elysia'
import { createAnonClient } from '../lib/supabase'
import { DEFAULT_MAINTENANCE } from '../lib/maintenance'

// Unauthenticated endpoints — RLS grants `anon` read access to these tables.
export const publicRoutes = new Elysia()
  .get('/maintenance', async () => {
    const anon = createAnonClient()
    const { data, error } = await anon
      .from('site_maintenance')
      .select('*')
      .eq('id', 'global')
      .maybeSingle()

    if (error) {
      return Response.json({ maintenance: DEFAULT_MAINTENANCE, tableMissing: error.code === '42P01' })
    }

    return Response.json({ maintenance: data ?? DEFAULT_MAINTENANCE, tableMissing: false })
  })
  .get('/portfolio', async () => {
    const anon = createAnonClient()
    const { data, error } = await anon
      .from('neva_design_portfolio')
      .select('*')
      .eq('is_active', true)
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[portfolio] load error:', error)
      return Response.json({ items: [] })
    }

    return Response.json({ items: data ?? [] })
  })
