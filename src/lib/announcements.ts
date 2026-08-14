export type AnnouncementKind = 'promo' | 'new' | 'update' | 'info'
export type AnnouncementAccent = 'coral' | 'orange' | 'yellow' | 'green'

export interface SiteAnnouncement {
  id: string
  title: string
  message: string
  kind: AnnouncementKind
  badge: string | null
  cta_label: string | null
  href: string | null
  accent: AnnouncementAccent
  is_active: boolean
  priority: number
  starts_at: string | null
  ends_at: string | null
  created_at: string
  updated_at: string
}

export const ANNOUNCEMENT_KINDS: AnnouncementKind[] = ['promo', 'new', 'update', 'info']
export const ANNOUNCEMENT_ACCENTS: AnnouncementAccent[] = ['coral', 'orange', 'yellow', 'green']

export const KIND_LABELS: Record<AnnouncementKind, string> = {
  promo: 'Code promo',
  new: 'Nouveau',
  update: 'Mise à jour',
  info: 'Info',
}

export const ACCENT_STYLES: Record<AnnouncementAccent, { color: string; bg: string; border: string }> = {
  coral: { color: '#F08A85', bg: '#F08A8514', border: '#F08A8533' },
  orange: { color: '#E5C36E', bg: '#E5C36E14', border: '#E5C36E33' },
  yellow: { color: '#A48BE8', bg: '#B4A8FF12', border: '#B4A8FF33' },
  green: { color: '#8FC7B2', bg: '#7ED4A612', border: '#7ED4A633' },
}

export function isAnnouncementKind(value: unknown): value is AnnouncementKind {
  return typeof value === 'string' && ANNOUNCEMENT_KINDS.includes(value as AnnouncementKind)
}

export function isAnnouncementAccent(value: unknown): value is AnnouncementAccent {
  return typeof value === 'string' && ANNOUNCEMENT_ACCENTS.includes(value as AnnouncementAccent)
}
