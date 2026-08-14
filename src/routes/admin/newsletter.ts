import { Elysia } from 'elysia'
import { requireAdmin, isResponse } from '../../lib/require-auth'
import { createServiceClient } from '../../lib/supabase'
import { env } from '../../config/env'

type Audience = 'all' | 'free' | 'paid'
type SendMode = 'test' | 'broadcast'

type Recipient = {
  id: string
  email: string
  plan: string
}

type NewsletterBody = {
  audience?: Audience
  mode?: SendMode
  subject?: string
  preheader?: string
  message?: string
  ctaLabel?: string
  ctaUrl?: string
  testRecipient?: string
  confirmation?: string
}

const RESEND_BATCH_SIZE = 100

function isAudience(value: unknown): value is Audience {
  return value === 'all' || value === 'free' || value === 'paid'
}

function normalizeEmail(value: unknown) {
  if (typeof value !== 'string') return ''
  const email = value.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

function absoluteUrl(input: string, requestUrl: string) {
  const clean = input.trim()
  if (!clean) return ''
  try {
    return new URL(clean, requestUrl).toString()
  } catch {
    return ''
  }
}

async function listRecipients(audience: Audience): Promise<Recipient[]> {
  const service = createServiceClient()
  const recipients: Recipient[] = []
  const perPage = 1000
  let page = 1

  while (true) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage })
    if (error) throw new Error(error.message)

    const users = data?.users ?? []
    if (users.length === 0) break

    const ids = users.map((user) => user.id)
    const { data: profiles, error: profileError } = await service
      .from('profiles')
      .select('id, plan')
      .in('id', ids)

    if (profileError) throw new Error(profileError.message)

    const profileMap = new Map((profiles ?? []).map((profile) => [profile.id, profile.plan ?? 'free']))

    for (const user of users) {
      const email = normalizeEmail(user.email)
      if (!email) continue

      const plan = profileMap.get(user.id) ?? 'free'
      if (audience === 'free' && plan !== 'free') continue
      if (audience === 'paid' && plan === 'free') continue

      recipients.push({ id: user.id, email, plan })
    }

    if (users.length < perPage) break
    page += 1
  }

  return recipients
}

async function getStats() {
  const all = await listRecipients('all')
  const free = all.filter((recipient) => recipient.plan === 'free').length
  return {
    total: all.length,
    free,
    paid: all.length - free,
    resendConfigured: Boolean(env.RESEND_API_KEY && env.NEWSLETTER_FROM_EMAIL),
    fromEmail: env.NEWSLETTER_FROM_EMAIL,
  }
}

function buildEmailHtml({
  preheader,
  message,
  ctaLabel,
  ctaUrl,
}: {
  preheader: string
  message: string
  ctaLabel: string
  ctaUrl: string
}) {
  const paragraphs = message
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p style="margin:0 0 16px;color:#d9d4c9;line-height:1.65;font-size:15px;">${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('')

  const button = ctaUrl
    ? `<a href="${escapeHtml(ctaUrl)}" style="display:inline-block;margin-top:8px;background:#C9A961;color:#0B0908;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:6px;">${escapeHtml(ctaLabel || 'Passer au niveau supérieur')}</a>`
    : ''

  return `<!doctype html>
<html>
  <body style="margin:0;background:#0B0908;font-family:Georgia,'Times New Roman',serif;">
    <span style="display:none!important;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">${escapeHtml(preheader)}</span>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0B0908;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#161310;border:1px solid rgba(243,239,230,.1);border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:24px;border-bottom:1px solid rgba(243,239,230,.08);">
                <div style="font-family:'Courier New',monospace;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#C9A961;font-weight:600;">Neva Design</div>
                <div style="margin-top:8px;color:#F3EFE6;font-size:24px;font-weight:500;">Passez au niveau supérieur</div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px;font-family:Inter,Arial,sans-serif;">
                ${paragraphs}
                ${button}
              </td>
            </tr>
            <tr>
              <td style="padding:18px 24px;border-top:1px solid rgba(243,239,230,.07);color:#8a857c;font-family:Inter,Arial,sans-serif;font-size:12px;line-height:1.5;">
                Vous recevez cet e-mail car vous disposez d'un compte Neva Design. Pour toute question, répondez simplement à ce message.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

function buildTextEmail(message: string, ctaLabel: string, ctaUrl: string) {
  return [message.trim(), ctaUrl ? `${ctaLabel || 'Passer au niveau supérieur'}: ${ctaUrl}` : '', "Vous recevez cet e-mail car vous disposez d'un compte Neva Design."].filter(Boolean).join('\n\n')
}

async function sendBatch(payload: Array<Record<string, unknown>>, idempotencyKey: string) {
  const res = await fetch('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(payload),
  })

  const body = await res.json().catch(() => null) as { data?: Array<{ id: string }>; message?: string; error?: string } | null
  if (!res.ok) {
    throw new Error(body?.message ?? body?.error ?? `Erreur Resend ${res.status}`)
  }

  return body?.data?.length ?? payload.length
}

export const adminNewsletterRoutes = new Elysia({ prefix: '/admin/newsletter' })
  .get('/', async ({ request }) => {
    const guard = await requireAdmin(request)
    if (isResponse(guard)) return guard

    try {
      return Response.json(await getStats())
    } catch (error) {
      console.error('[admin/newsletter] stats error:', error)
      return Response.json({ error: 'Impossible de charger les stats newsletter' }, { status: 500 })
    }
  })
  .post('/', async ({ request }) => {
    const guard = await requireAdmin(request)
    if (isResponse(guard)) return guard
    const { admin } = guard

    const body = await request.json().catch(() => ({})) as NewsletterBody
    const mode: SendMode = body.mode === 'broadcast' ? 'broadcast' : 'test'
    const audience: Audience = isAudience(body.audience) ? body.audience : 'free'
    const subject = body.subject?.trim() ?? ''
    const preheader = body.preheader?.trim() ?? ''
    const message = body.message?.trim() ?? ''
    const ctaLabel = body.ctaLabel?.trim() || 'Upgrade maintenant'
    const ctaUrl = absoluteUrl(body.ctaUrl ?? '/dashboard/billing', request.url)

    if (!env.RESEND_API_KEY || !env.NEWSLETTER_FROM_EMAIL) {
      return Response.json({ error: 'Configure RESEND_API_KEY et NEWSLETTER_FROM_EMAIL avant un envoi.' }, { status: 400 })
    }

    if (!subject || !message) {
      return Response.json({ error: 'Sujet et message requis.' }, { status: 400 })
    }

    if (mode === 'broadcast' && body.confirmation !== 'UPGRADE') {
      return Response.json({ error: 'Confirmation requise: tape UPGRADE.' }, { status: 400 })
    }

    const testRecipient = normalizeEmail(body.testRecipient)
    if (mode === 'test' && !testRecipient) {
      return Response.json({ error: 'Email de test invalide.' }, { status: 400 })
    }

    try {
      const recipients = mode === 'test'
        ? [{ id: 'test', email: testRecipient, plan: 'test' }]
        : await listRecipients(audience)

      if (recipients.length === 0) {
        return Response.json({ error: 'Aucun destinataire trouve.' }, { status: 400 })
      }

      const html = buildEmailHtml({ preheader, message, ctaLabel, ctaUrl })
      const text = buildTextEmail(message, ctaLabel, ctaUrl)
      const from = env.NEWSLETTER_FROM_EMAIL
      const replyTo = env.NEWSLETTER_REPLY_TO_EMAIL || undefined
      let sent = 0

      for (const [index, group] of chunk(recipients, RESEND_BATCH_SIZE).entries()) {
        const payload = group.map((recipient) => ({
          from,
          to: [recipient.email],
          subject,
          html,
          text,
          reply_to: replyTo,
          tags: [
            { name: 'type', value: 'admin_newsletter' },
            { name: 'audience', value: audience },
            { name: 'mode', value: mode },
          ],
        }))

        sent += await sendBatch(payload, `newsletter-${Date.now()}-${index}-${admin.userId}`)
      }

      return Response.json({
        sent,
        mode,
        audience,
        requested: recipients.length,
      })
    } catch (error) {
      console.error('[admin/newsletter] send error:', error)
      return Response.json({ error: (error as Error).message ?? 'Erreur envoi newsletter' }, { status: 500 })
    }
  })
