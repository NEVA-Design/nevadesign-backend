import { Elysia } from 'elysia'
import { randomUUID } from 'crypto'
import { requireAdmin, isResponse } from '../../lib/require-auth'
import {
  isPortfolioCategory,
  isPortfolioLayout,
  type NevaDesignPortfolioInput,
} from '../../lib/neva-design-portfolio'
import { createServiceClient } from '../../lib/supabase'

const BUCKET = 'neva-design-portfolio'
const MAX_SIZE = 12 * 1024 * 1024
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']

interface PortfolioPayload {
  title?: unknown
  category?: unknown
  tag?: unknown
  image_path?: unknown
  description?: unknown
  is_featured?: unknown
  is_active?: unknown
  priority?: unknown
  layout?: unknown
}

function optionalText(value: unknown) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function validatePayload(body: PortfolioPayload) {
  const title = optionalText(body.title)
  const tag = optionalText(body.tag)
  const category = isPortfolioCategory(body.category) ? body.category : null
  const layout = isPortfolioLayout(body.layout) ? body.layout : 'normal'
  const priority = Number(body.priority ?? 0)

  if (!title) return { error: 'Titre requis' }
  if (!category) return { error: 'Categorie invalide' }
  if (!tag) return { error: 'Tag requis' }
  if (!Number.isInteger(priority) || priority < 0) return { error: 'Priorite invalide' }

  return {
    payload: {
      title,
      category,
      tag,
      image_path: optionalText(body.image_path),
      description: optionalText(body.description),
      is_featured: typeof body.is_featured === 'boolean' ? body.is_featured : false,
      is_active: typeof body.is_active === 'boolean' ? body.is_active : true,
      priority,
      layout,
      updated_at: new Date().toISOString(),
    } satisfies NevaDesignPortfolioInput & { updated_at: string },
  }
}

function extensionFor(type: string) {
  if (type === 'image/png') return 'png'
  if (type === 'image/webp') return 'webp'
  return 'jpg'
}

async function ensureBucket() {
  const service = createServiceClient()
  const { data: buckets, error: listError } = await service.storage.listBuckets()

  if (listError) {
    console.error('[admin/neva-design/upload] bucket list error:', listError.message)
    return { service, error: 'Erreur storage' }
  }

  if (!buckets?.some((bucket) => bucket.id === BUCKET)) {
    const { error } = await service.storage.createBucket(BUCKET, {
      public: true,
      fileSizeLimit: MAX_SIZE,
      allowedMimeTypes: ALLOWED_TYPES,
    })

    if (error) {
      console.error('[admin/neva-design/upload] bucket create error:', error.message)
      return { service, error: 'Bucket portfolio manquant' }
    }
  }

  return { service, error: null }
}

export const adminPortfolioRoutes = new Elysia({ prefix: '/admin/neva-design/portfolio' })
  .get('/', async ({ request }) => {
    const guard = await requireAdmin(request)
    if (isResponse(guard)) return guard

    const service = createServiceClient()
    const { data, error } = await service
      .from('neva_design_portfolio')
      .select('*')
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[admin/neva-design/portfolio] list error:', error)
      return Response.json({ error: 'Erreur chargement' }, { status: 500 })
    }

    return Response.json({ items: data ?? [] })
  })
  .post('/', async ({ request }) => {
    const guard = await requireAdmin(request)
    if (isResponse(guard)) return guard

    const body = await request.json() as PortfolioPayload
    const validated = validatePayload(body)

    if ('error' in validated) {
      return Response.json({ error: validated.error }, { status: 400 })
    }

    const service = createServiceClient()
    const { data, error } = await service
      .from('neva_design_portfolio')
      .insert(validated.payload)
      .select('*')
      .single()

    if (error) {
      console.error('[admin/neva-design/portfolio] create error:', error)
      return Response.json({ error: 'Erreur creation' }, { status: 500 })
    }

    return Response.json({ item: data }, { status: 201 })
  })
  .patch('/:id', async ({ request, params }) => {
    const guard = await requireAdmin(request)
    if (isResponse(guard)) return guard

    const body = await request.json() as PortfolioPayload
    const validated = validatePayload(body)

    if ('error' in validated) {
      return Response.json({ error: validated.error }, { status: 400 })
    }

    const service = createServiceClient()
    const { data, error } = await service
      .from('neva_design_portfolio')
      .update(validated.payload)
      .eq('id', params.id)
      .select('*')
      .single()

    if (error) {
      console.error('[admin/neva-design/portfolio] update error:', error)
      return Response.json({ error: 'Erreur mise a jour' }, { status: 500 })
    }

    return Response.json({ item: data })
  })
  .delete('/:id', async ({ request, params }) => {
    const guard = await requireAdmin(request)
    if (isResponse(guard)) return guard

    const service = createServiceClient()
    const { error } = await service.from('neva_design_portfolio').delete().eq('id', params.id)

    if (error) {
      console.error('[admin/neva-design/portfolio] delete error:', error)
      return Response.json({ error: 'Erreur suppression' }, { status: 500 })
    }

    return Response.json({ ok: true })
  })
  .post('/upload', async ({ request }) => {
    const guard = await requireAdmin(request)
    if (isResponse(guard)) return guard

    let formData: Awaited<ReturnType<typeof request.formData>>
    try {
      formData = await request.formData()
    } catch {
      return Response.json({ error: 'Formulaire invalide' }, { status: 400 })
    }

    const file = formData.get('image')
    if (!file || !(file instanceof File)) {
      return Response.json({ error: 'Image requise' }, { status: 400 })
    }

    if (file.size > MAX_SIZE) {
      return Response.json({ error: 'Image trop lourde - max 12 Mo' }, { status: 400 })
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return Response.json({ error: 'Format invalide - JPG, PNG ou WebP' }, { status: 400 })
    }

    const { service, error: bucketError } = await ensureBucket()
    if (bucketError) return Response.json({ error: bucketError }, { status: 500 })

    const ext = extensionFor(file.type)
    const storagePath = `portfolio/${Date.now()}-${randomUUID()}.${ext}`
    const buffer = Buffer.from(await file.arrayBuffer())

    const { error: uploadError } = await service.storage.from(BUCKET).upload(storagePath, buffer, {
      contentType: file.type,
      upsert: false,
    })

    if (uploadError) {
      console.error('[admin/neva-design/upload] upload error:', uploadError.message)
      return Response.json({ error: `Upload echoue: ${uploadError.message}` }, { status: 500 })
    }

    const {
      data: { publicUrl },
    } = service.storage.from(BUCKET).getPublicUrl(storagePath)

    return Response.json({ image_path: `${publicUrl}?t=${Date.now()}` })
  })
