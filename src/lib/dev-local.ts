import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { env } from '../config/env'

// ─────────────────────────────────────────────────────────────────────────────
// MODE DEV LOCAL — émulation Supabase sur fichier JSON.
//
// Objectif : faire tourner TOUT le produit (auth, profils, crédits, projets,
// exports) sans projet Supabase, pour développer et prouver les parcours en
// local. Jamais actif en production : il faut DEV_LOCAL_MODE=1 dans le .env
// ET NODE_ENV ≠ production. Le shim ne couvre que les chaînes supabase-js
// réellement utilisées par ce backend ; toute requête non supportée logge un
// warning au lieu de casser.
// ─────────────────────────────────────────────────────────────────────────────

export function devLocalEnabled(): boolean {
  return process.env.DEV_LOCAL_MODE === '1' && env.NODE_ENV !== 'production'
}

export const DEV_USER = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'dev@neva.local',
  user_metadata: { display_name: 'Atelier Local' },
  app_metadata: {},
  aud: 'authenticated',
  created_at: '2026-08-01T00:00:00.000Z',
}

const DEV_SESSION = {
  access_token: 'dev-local-token',
  refresh_token: 'dev-local-refresh',
  token_type: 'bearer',
  expires_in: 86_400,
  expires_at: Math.floor(Date.now() / 1000) + 86_400,
  user: DEV_USER,
}

type Row = Record<string, unknown>
type Store = Record<string, Row[]>

const STORE_PATH = join(process.cwd(), 'data', 'dev-store.json')
export const DEV_FILES_ROOT = join(process.cwd(), 'data', 'files')

let store: Store | null = null

function loadStore(): Store {
  if (store) return store
  try {
    store = existsSync(STORE_PATH) ? (JSON.parse(readFileSync(STORE_PATH, 'utf-8')) as Store) : {}
  } catch {
    store = {}
  }
  // Amorçage : un profil Studio avec des créations pour dérouler tous les
  // parcours (génération, retouches, export débité).
  if (!store['profiles']?.some((p) => p.id === DEV_USER.id)) {
    store['profiles'] = store['profiles'] ?? []
    store['profiles'].push({
      id: DEV_USER.id,
      credits: 25,
      plan: 'studio',
      display_name: 'Atelier Local',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
  }
  if (!store['engine_settings']?.length) {
    store['engine_settings'] = [
      { id: 'global', generations_enabled: true, daily_cap_per_user: 80, updated_at: new Date().toISOString() },
    ]
  }
  persist()
  return store
}

function persist() {
  if (!store) return
  mkdirSync(dirname(STORE_PATH), { recursive: true })
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2))
}

function tableOf(name: string): Row[] {
  const s = loadStore()
  s[name] = s[name] ?? []
  return s[name]
}

type Filter = (row: Row) => boolean
type ExecResult = { data: unknown; error: null | { code?: string; message: string } }

class DevQuery implements PromiseLike<ExecResult> {
  private mode: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select'
  private filters: Filter[] = []
  private orderBy: { col: string; ascending: boolean } | null = null
  private limitN: number | null = null
  private singleMode: 'single' | 'maybe' | null = null
  private payload: Row | Row[] | null = null
  private conflictKey: string | null = null
  private wantRows = false

  constructor(private table: string) {}

  select(_cols?: string) {
    if (this.mode !== 'select') this.wantRows = true
    return this
  }
  insert(rows: Row | Row[]) { this.mode = 'insert'; this.payload = rows; return this }
  update(patch: Row) { this.mode = 'update'; this.payload = patch; return this }
  upsert(row: Row, opts?: { onConflict?: string }) {
    this.mode = 'upsert'
    this.payload = row
    this.conflictKey = opts?.onConflict ?? 'id'
    return this
  }
  delete() { this.mode = 'delete'; return this }

  eq(col: string, value: unknown) { this.filters.push((r) => r[col] === value); return this }
  neq(col: string, value: unknown) { this.filters.push((r) => r[col] !== value); return this }
  in(col: string, values: unknown[]) { this.filters.push((r) => values.includes(r[col])); return this }
  gte(col: string, value: unknown) { this.filters.push((r) => String(r[col] ?? '') >= String(value)); return this }
  lte(col: string, value: unknown) { this.filters.push((r) => String(r[col] ?? '') <= String(value)); return this }
  ilike(col: string, pattern: string) {
    const needle = pattern.replaceAll('%', '').toLowerCase()
    this.filters.push((r) => String(r[col] ?? '').toLowerCase().includes(needle))
    return this
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderBy = { col, ascending: opts?.ascending !== false }
    return this
  }
  limit(n: number) { this.limitN = n; return this }
  range(from: number, to: number) { this.limitN = to - from + 1; return this }

  single() { this.singleMode = 'single'; return this.exec() }
  maybeSingle() { this.singleMode = 'maybe'; return this.exec() }

  then<T1 = ExecResult, T2 = never>(
    onfulfilled?: ((value: ExecResult) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null
  ): PromiseLike<T1 | T2> {
    return this.exec().then(onfulfilled, onrejected)
  }

  private matching(rows: Row[]): Row[] {
    return rows.filter((r) => this.filters.every((f) => f(r)))
  }

  private async exec(): Promise<ExecResult> {
    const rows = tableOf(this.table)

    if (this.mode === 'insert') {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}]
      const inserted = list.map((row) => ({
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        ...row,
      }))
      rows.push(...inserted)
      persist()
      const data = this.singleMode ? inserted[0] : inserted
      return { data: this.wantRows || this.singleMode ? data : null, error: null }
    }

    if (this.mode === 'update') {
      const targets = this.matching(rows)
      for (const row of targets) Object.assign(row, this.payload)
      persist()
      const data = this.singleMode ? targets[0] ?? null : targets
      if (this.singleMode === 'single' && !targets.length) {
        return { data: null, error: { message: 'Row not found' } }
      }
      return { data: this.wantRows || this.singleMode ? data : null, error: null }
    }

    if (this.mode === 'upsert') {
      const row = (this.payload ?? {}) as Row
      const key = this.conflictKey ?? 'id'
      const existing = rows.find((r) => r[key] === row[key])
      let result: Row
      if (existing) {
        Object.assign(existing, row)
        result = existing
      } else {
        result = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...row }
        rows.push(result)
      }
      persist()
      return { data: this.singleMode || this.wantRows ? (this.singleMode ? result : [result]) : null, error: null }
    }

    if (this.mode === 'delete') {
      const s = loadStore()
      const kept = rows.filter((r) => !this.filters.every((f) => f(r)))
      const removed = rows.length - kept.length
      s[this.table] = kept
      persist()
      return { data: removed, error: null }
    }

    // select
    let result = this.matching(rows).map((r) => ({ ...r }))
    if (this.orderBy) {
      const { col, ascending } = this.orderBy
      result.sort((a, b) => (String(a[col] ?? '') < String(b[col] ?? '') ? -1 : 1) * (ascending ? 1 : -1))
    }
    if (this.limitN != null) result = result.slice(0, this.limitN)

    if (this.singleMode === 'single') {
      if (result.length !== 1) return { data: null, error: { code: 'PGRST116', message: 'Expected a single row' } }
      return { data: result[0], error: null }
    }
    if (this.singleMode === 'maybe') {
      return { data: result[0] ?? null, error: null }
    }
    return { data: result, error: null }
  }
}

function devStorageBucket(bucket: string) {
  return {
    async upload(path: string, body: Uint8Array | ArrayBuffer | Buffer, _opts?: Record<string, unknown>) {
      try {
        const filePath = join(DEV_FILES_ROOT, bucket, path)
        mkdirSync(dirname(filePath), { recursive: true })
        const buffer = body instanceof ArrayBuffer ? Buffer.from(body) : Buffer.from(body as Uint8Array)
        writeFileSync(filePath, buffer)
        return { data: { path }, error: null }
      } catch (error) {
        return { data: null, error: { message: (error as Error).message } }
      }
    },
    getPublicUrl(path: string) {
      return { data: { publicUrl: `http://localhost:${env.PORT}/files/${bucket}/${path}` } }
    },
    async remove(paths: string[]) {
      for (const p of paths) {
        try {
          const { unlinkSync } = await import('fs')
          unlinkSync(join(DEV_FILES_ROOT, bucket, p))
        } catch { /* déjà absent */ }
      }
      return { data: paths, error: null }
    },
  }
}

let warned = false

export function devClient() {
  if (!warned) {
    warned = true
    console.warn('⚠️  [dev-local] MODE DEV LOCAL ACTIF — Supabase émulé sur data/dev-store.json. Jamais en production.')
  }
  return {
    from(table: string) { return new DevQuery(table) },
    rpc(fn: string, args: Record<string, unknown>) {
      if (fn === 'increment_credits') {
        const profile = tableOf('profiles').find((p) => p.id === args.user_id)
        if (profile) {
          profile.credits = Number(profile.credits ?? 0) + Number(args.amount ?? 0)
          profile.updated_at = new Date().toISOString()
          persist()
        }
        return Promise.resolve({ data: null, error: null })
      }
      console.warn(`[dev-local] rpc non supportée : ${fn}`)
      return Promise.resolve({ data: null, error: null })
    },
    auth: {
      async getUser(_token?: string) {
        return { data: { user: DEV_USER }, error: null }
      },
      async signInWithPassword(_creds: { email: string; password: string }) {
        return { data: { user: DEV_USER, session: { ...DEV_SESSION } }, error: null }
      },
      async signUp(_creds: Record<string, unknown>) {
        return { data: { user: DEV_USER, session: { ...DEV_SESSION } }, error: null }
      },
      async refreshSession(_args: { refresh_token: string }) {
        return { data: { user: DEV_USER, session: { ...DEV_SESSION } }, error: null }
      },
      async resetPasswordForEmail(_email: string, _opts?: Record<string, unknown>) {
        return { data: {}, error: null }
      },
      admin: {
        async getUserById(id: string) {
          return { data: { user: id === DEV_USER.id ? DEV_USER : null }, error: null }
        },
        async listUsers() {
          return { data: { users: [DEV_USER] }, error: null }
        },
      },
    },
    storage: {
      from(bucket: string) { return devStorageBucket(bucket) },
    },
  }
}
