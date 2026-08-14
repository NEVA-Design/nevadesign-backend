import { Elysia } from 'elysia'
import { requireUser, isResponse } from '../lib/require-auth'
import { env } from '../config/env'

export const debugRoutes = new Elysia({ prefix: '/debug' })
  .get('/models', async ({ request }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth

    const key = env.GOOGLE_AI_API_KEY
    if (!key) return Response.json({ error: 'No API key' }, { status: 500 })

    const results: Record<string, unknown> = {}

    for (const version of ['v1beta', 'v1']) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/${version}/models?key=${key}&pageSize=200`
        )
        const data = await res.json() as { models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }> }
        const imageModels = (data.models ?? []).filter((m: { name: string; supportedGenerationMethods?: string[] }) =>
          m.name.toLowerCase().includes('image') ||
          m.name.toLowerCase().includes('imagen') ||
          m.name.toLowerCase().includes('flash-exp') ||
          (m.supportedGenerationMethods ?? []).some((method: string) => method.includes('generate'))
        )
        results[version] = imageModels.map((m: { name: string; displayName?: string; supportedGenerationMethods?: string[] }) => ({
          name: m.name,
          displayName: m.displayName,
          methods: m.supportedGenerationMethods,
        }))
      } catch (e) {
        results[version] = { error: String(e) }
      }
    }

    return Response.json(results)
  })
