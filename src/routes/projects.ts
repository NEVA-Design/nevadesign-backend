import { Elysia } from 'elysia'
import sharp from 'sharp'
import { requireUser, isResponse } from '../lib/require-auth'
import { createServiceClient } from '../lib/supabase'
import { jsonError, sanitizeText, validateUploadedImage } from '../lib/security'

// ── Le modèle « Projet » (run 5, LOT 1) ───────────────────────────────────────
// Un projet porte la DA complète d'un serveur : nom, secteur, ambiance,
// palette, logo master. Tout asset créé dedans hérite de ces éléments.
// Le front ne parle qu'à ces routes — jamais à Supabase directement.

export const ASSET_CATEGORIES = [
  'logo',
  'banniere_discord',
  'banniere_fivem',
  'banniere_f5',
  'affiche',
  'wallpaper',
  'loading_screen',
  'icon',
  'libre',
] as const

export type AssetCategory = (typeof ASSET_CATEGORIES)[number]

function isAssetCategory(value: unknown): value is AssetCategory {
  return typeof value === 'string' && (ASSET_CATEGORIES as readonly string[]).includes(value)
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

function sanitizeAmbiance(raw: unknown): Record<string, unknown> {
  const input = (raw ?? {}) as { universe?: unknown; chips?: unknown; references?: unknown }
  const chips = Array.isArray(input.chips)
    ? input.chips.filter((c): c is string => typeof c === 'string').map((c) => sanitizeText(c, 24)).filter(Boolean).slice(0, 3)
    : []
  const references = Array.isArray(input.references)
    ? input.references.filter((r): r is string => typeof r === 'string' && r.length < 600).slice(0, 3)
    : []
  return {
    universe: sanitizeText(input.universe, 240),
    chips,
    references,
  }
}

function sanitizePalette(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((c): c is string => typeof c === 'string' && HEX_COLOR.test(c)).slice(0, 6)
}

function clampDimension(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(64, Math.min(8192, Math.round(n)))
}

export const projectRoutes = new Elysia({ prefix: '/projects' })
  // Upload d'une image de référence (wizard ambiance / scènes) :
  // recompressée en 768 px webp côté serveur, stockée dans le bucket projets.
  .post('/uploads/reference', async ({ request }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user } = auth

    const body = await request.json().catch(() => null) as { image?: { data?: string; mimeType?: string } } | null
    const validated = validateUploadedImage(body?.image, 'reference')
    if (!validated.ok) return jsonError(validated.error, 400)

    try {
      const resized = await sharp(Buffer.from(validated.image.data, 'base64'))
        .rotate()
        .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 88 })
        .toBuffer()

      const path = `${user.id}/references/${crypto.randomUUID()}.webp`
      const service = createServiceClient()
      const { error } = await service.storage.from('neva-projects').upload(path, resized, {
        contentType: 'image/webp',
        upsert: true,
      })
      if (error) return jsonError('upload_failed', 500, "L'upload de la référence a échoué.")

      const { data } = service.storage.from('neva-projects').getPublicUrl(path)
      return Response.json({ url: data.publicUrl })
    } catch {
      return jsonError('upload_failed', 500, "L'upload de la référence a échoué.")
    }
  })

  // Liste des projets + compte d'assets + dernière activité
  .get('/', async ({ request }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user, supabase } = auth

    const [{ data: projects, error }, { data: assets }] = await Promise.all([
      supabase.from('projects').select('*').eq('user_id', user.id).order('updated_at', { ascending: false }),
      supabase.from('project_assets').select('project_id, updated_at, category').eq('user_id', user.id),
    ])
    if (error) return jsonError('projects_load_failed', 500, 'Impossible de charger vos projets.')

    const byProject = new Map<string, { count: number; last: string }>()
    for (const asset of assets ?? []) {
      const entry = byProject.get(asset.project_id) ?? { count: 0, last: '' }
      entry.count += 1
      if (String(asset.updated_at ?? '') > entry.last) entry.last = String(asset.updated_at ?? '')
      byProject.set(asset.project_id, entry)
    }

    return Response.json({
      projects: (projects ?? []).map((project) => ({
        ...project,
        assetCount: byProject.get(project.id)?.count ?? 0,
        lastActivity: byProject.get(project.id)?.last || project.updated_at,
      })),
    })
  })

  // Création de projet (écran 1 du wizard)
  .post('/', async ({ request }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user, supabase } = auth

    const body = await request.json().catch(() => null) as {
      name?: unknown
      sector?: unknown
      ambiance?: unknown
      palette?: unknown
    } | null
    if (!body) return jsonError('invalid_body', 400)

    const name = sanitizeText(body.name, 60)
    if (name.length < 2) {
      return jsonError('name_required', 400, 'Donne un nom à ton serveur (2 caractères minimum).')
    }
    const sector = body.sector === 'fivem' ? 'fivem' : 'fivem'

    const { data, error } = await supabase
      .from('projects')
      .insert({
        user_id: user.id,
        name,
        sector,
        ambiance: sanitizeAmbiance(body.ambiance),
        palette: sanitizePalette(body.palette),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (error || !data) return jsonError('project_create_failed', 500, 'La création du projet a échoué.')
    return Response.json({ project: data })
  })

  // Détail projet + assets
  .get('/:id', async ({ request, params }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user, supabase } = auth

    const { data: project } = await supabase
      .from('projects')
      .select('*')
      .eq('id', params.id)
      .eq('user_id', user.id)
      .maybeSingle()
    if (!project) return jsonError('project_not_found', 404, 'Projet introuvable.')

    const { data: assets } = await supabase
      .from('project_assets')
      .select('id, category, title, status, width, height, preview_url, retouches_used, exports, created_at, updated_at')
      .eq('project_id', params.id)
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false })

    return Response.json({ project, assets: assets ?? [] })
  })

  // Mise à jour projet (nom, ambiance, palette, logo master)
  .patch('/:id', async ({ request, params }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user, supabase } = auth

    const body = await request.json().catch(() => null) as {
      name?: unknown
      ambiance?: unknown
      palette?: unknown
      logo_master?: unknown
    } | null
    if (!body) return jsonError('invalid_body', 400)

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (body.name !== undefined) {
      const name = sanitizeText(body.name, 60)
      if (name.length < 2) return jsonError('name_required', 400, 'Nom trop court.')
      patch.name = name
    }
    if (body.ambiance !== undefined) patch.ambiance = sanitizeAmbiance(body.ambiance)
    if (body.palette !== undefined) patch.palette = sanitizePalette(body.palette)
    if (body.logo_master !== undefined) {
      const logo = body.logo_master as { url?: unknown; whiteUrl?: unknown; blackUrl?: unknown; width?: unknown; height?: unknown } | null
      patch.logo_master = logo && typeof logo.url === 'string'
        ? {
            url: logo.url,
            whiteUrl: typeof logo.whiteUrl === 'string' ? logo.whiteUrl : null,
            blackUrl: typeof logo.blackUrl === 'string' ? logo.blackUrl : null,
            width: clampDimension(logo.width, 4096),
            height: clampDimension(logo.height, 4096),
          }
        : null
    }

    const { data, error } = await supabase
      .from('projects')
      .update(patch)
      .eq('id', params.id)
      .eq('user_id', user.id)
      .select()
      .single()

    if (error || !data) return jsonError('project_update_failed', 500, 'La mise à jour du projet a échoué.')
    return Response.json({ project: data })
  })

  .delete('/:id', async ({ request, params }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user, supabase } = auth

    await supabase.from('project_assets').delete().eq('project_id', params.id).eq('user_id', user.id)
    const { error } = await supabase.from('projects').delete().eq('id', params.id).eq('user_id', user.id)
    if (error) return jsonError('project_delete_failed', 500, 'La suppression du projet a échoué.')
    return Response.json({ ok: true })
  })

  // ── Assets ────────────────────────────────────────────────────────────────
  .post('/:id/assets', async ({ request, params }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user, supabase } = auth

    const { data: project } = await supabase
      .from('projects')
      .select('id')
      .eq('id', params.id)
      .eq('user_id', user.id)
      .maybeSingle()
    if (!project) return jsonError('project_not_found', 404, 'Projet introuvable.')

    const body = await request.json().catch(() => null) as {
      category?: unknown
      title?: unknown
      width?: unknown
      height?: unknown
      layers?: unknown
      wizard_answers?: unknown
    } | null
    if (!body || !isAssetCategory(body.category)) {
      return jsonError('invalid_category', 400, 'Catégorie de création invalide.')
    }

    const { data, error } = await supabase
      .from('project_assets')
      .insert({
        project_id: params.id,
        user_id: user.id,
        category: body.category,
        title: sanitizeText(body.title, 80) || null,
        status: 'draft',
        width: clampDimension(body.width, 1920),
        height: clampDimension(body.height, 1080),
        layers: Array.isArray(body.layers) ? body.layers : [],
        wizard_answers: typeof body.wizard_answers === 'object' && body.wizard_answers ? body.wizard_answers : {},
        updated_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (error || !data) return jsonError('asset_create_failed', 500, 'La création a échoué.')

    await supabase
      .from('projects')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', params.id)
      .eq('user_id', user.id)

    return Response.json({ asset: data })
  })

  .get('/:id/assets/:assetId', async ({ request, params }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user, supabase } = auth

    const { data: asset } = await supabase
      .from('project_assets')
      .select('*')
      .eq('id', params.assetId)
      .eq('project_id', params.id)
      .eq('user_id', user.id)
      .maybeSingle()
    if (!asset) return jsonError('asset_not_found', 404, 'Création introuvable.')
    return Response.json({ asset })
  })

  // Autosave de l'éditeur : calques, titre, statut, aperçu
  .patch('/:id/assets/:assetId', async ({ request, params }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user, supabase } = auth

    const body = await request.json().catch(() => null) as {
      title?: unknown
      layers?: unknown
      status?: unknown
      preview_url?: unknown
      wizard_answers?: unknown
      width?: unknown
      height?: unknown
    } | null
    if (!body) return jsonError('invalid_body', 400)

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (body.title !== undefined) patch.title = sanitizeText(body.title, 80) || null
    if (Array.isArray(body.layers)) patch.layers = body.layers
    if (body.status === 'draft' || body.status === 'ready') patch.status = body.status
    if (typeof body.preview_url === 'string' && body.preview_url.length < 600) patch.preview_url = body.preview_url
    if (typeof body.wizard_answers === 'object' && body.wizard_answers) patch.wizard_answers = body.wizard_answers
    if (body.width !== undefined) patch.width = clampDimension(body.width, 1920)
    if (body.height !== undefined) patch.height = clampDimension(body.height, 1080)

    const { data, error } = await supabase
      .from('project_assets')
      .update(patch)
      .eq('id', params.assetId)
      .eq('project_id', params.id)
      .eq('user_id', user.id)
      .select()
      .single()

    if (error || !data) return jsonError('asset_update_failed', 500, 'La sauvegarde a échoué.')
    return Response.json({ asset: data })
  })

  .delete('/:id/assets/:assetId', async ({ request, params }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user, supabase } = auth

    const { error } = await supabase
      .from('project_assets')
      .delete()
      .eq('id', params.assetId)
      .eq('project_id', params.id)
      .eq('user_id', user.id)
    if (error) return jsonError('asset_delete_failed', 500, 'La suppression a échoué.')
    return Response.json({ ok: true })
  })
