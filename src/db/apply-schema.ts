import { SQL } from 'bun'
import { readFileSync } from 'fs'
import { join } from 'path'
import { env } from '../config/env'

// Auto-creates/updates the full Supabase schema on startup — idempotent
// (CREATE ... IF NOT EXISTS, DROP POLICY IF EXISTS before each CREATE
// POLICY), so it's safe to run on every boot. Needs a direct Postgres
// connection (SUPABASE_DB_URL) — the Supabase REST API has no generic
// SQL execution endpoint, so the anon/service-role keys alone can't do this.
export async function applySchema() {
  if (!env.SUPABASE_DB_URL) {
    console.warn('[db] SUPABASE_DB_URL not set — skipping schema auto-creation. Apply src/db/schema.sql manually if tables are missing.')
    return
  }

  const schemaPath = join(import.meta.dir, 'schema.sql')
  const schemaSql = readFileSync(schemaPath, 'utf-8')

  const sql = new SQL(env.SUPABASE_DB_URL)
  try {
    await sql.unsafe(schemaSql)
    console.log('[db] schema ensured (tables, policies, functions up to date)')
  } catch (error) {
    console.error('[db] schema auto-creation failed — check SUPABASE_DB_URL and run src/db/schema.sql manually if needed:', error)
  } finally {
    await sql.close()
  }
}
