import { Elysia } from 'elysia'
import { join, normalize } from 'path'
import { existsSync } from 'fs'
import { devLocalEnabled, DEV_FILES_ROOT } from '../lib/dev-local'

// Sert les fichiers écrits par le shim storage du MODE DEV LOCAL
// (data/files/<bucket>/<chemin>). En production, les fichiers vivent dans
// Supabase Storage et cette route renvoie 404.

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json',
}

export const filesRoutes = new Elysia({ prefix: '/files' })
  .get('/*', ({ params, set }) => {
    if (!devLocalEnabled()) {
      set.status = 404
      return { error: 'not_found' }
    }

    const requested = normalize(params['*'] ?? '').replaceAll('\\', '/')
    if (!requested || requested.includes('..')) {
      set.status = 400
      return { error: 'invalid_path' }
    }

    const filePath = join(DEV_FILES_ROOT, requested)
    if (!existsSync(filePath)) {
      set.status = 404
      return { error: 'not_found' }
    }

    const ext = requested.slice(requested.lastIndexOf('.')).toLowerCase()
    const file = Bun.file(filePath)
    return new Response(file, {
      headers: {
        'Content-Type': MIME_BY_EXT[ext] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      },
    })
  })
