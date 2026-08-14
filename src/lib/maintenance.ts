export type MaintenanceMode = {
  id: 'global'
  enabled: boolean
  title: string
  message: string
  allow_admin_access: boolean
  starts_at: string | null
  ends_at: string | null
  updated_by: string | null
  updated_at: string | null
}

export type MaintenancePayload = {
  enabled?: unknown
  title?: unknown
  message?: unknown
  allow_admin_access?: unknown
  starts_at?: unknown
  ends_at?: unknown
}

export const DEFAULT_MAINTENANCE: MaintenanceMode = {
  id: 'global',
  enabled: false,
  title: 'Maintenance en cours',
  message: 'Neva Design revient dans quelques minutes. Merci pour votre patience.',
  allow_admin_access: true,
  starts_at: null,
  ends_at: null,
  updated_by: null,
  updated_at: null,
}

export function isMaintenanceActive(settings: Pick<MaintenanceMode, 'enabled' | 'starts_at' | 'ends_at'>) {
  if (!settings.enabled) return false

  const now = Date.now()
  const starts = settings.starts_at ? new Date(settings.starts_at).getTime() : null
  const ends = settings.ends_at ? new Date(settings.ends_at).getTime() : null

  if (starts && starts > now) return false
  if (ends && ends < now) return false
  return true
}

function optionalDate(value: unknown) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null

  const date = new Date(trimmed)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function cleanText(value: unknown, fallback: string, maxLength: number) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed) return fallback
  return trimmed.slice(0, maxLength)
}

export function maintenanceFromPayload(body: MaintenancePayload, adminEmail: string) {
  return {
    id: 'global' as const,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : false,
    title: cleanText(body.title, DEFAULT_MAINTENANCE.title, 90),
    message: cleanText(body.message, DEFAULT_MAINTENANCE.message, 360),
    allow_admin_access: typeof body.allow_admin_access === 'boolean' ? body.allow_admin_access : true,
    starts_at: optionalDate(body.starts_at),
    ends_at: optionalDate(body.ends_at),
    updated_by: adminEmail,
    updated_at: new Date().toISOString(),
  }
}
