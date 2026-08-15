import { Elysia } from 'elysia'
import sharp from 'sharp'
import { requireUser, isResponse } from '../lib/require-auth'
import { createServiceClient } from '../lib/supabase'
import { checkRateLimit, jsonError, sanitizeText, securityLog } from '../lib/security'
import { checkEngineGuards } from '../lib/engine/guards'
import { deductCredits, getCredits } from '../lib/credits'
import {
  CATEGORY_IMAGE_CONFIG,
  compileLogoPrompt,
  compileScenePrompt,
  listSceneTemplates,
  type EngineCategory,
  type LogoAnswers,
  type SceneAnswers,
} from '../lib/engine/compiler'
import {
  ENGINE_MODELS,
  fetchAsReference,
  generateWithSoftRetry,
  storeBuffer,
  storeRender,
} from '../lib/engine/generation'
import { cutoutFlatBackground, makeMonochrome } from '../lib/engine/cutout'
import { makeLayerId, type Layer } from '../lib/engine/layers'
import { composeAsset, effectFileBuffer, effectsManifest } from '../lib/engine/composite'
import { GeminiError } from '../lib/ai/gemini'

// ── Le moteur produit (run 5, LOT 3/4) ───────────────────────────────────────
// Toutes les générations liées aux projets passent ici : propositions de
// logo, master 4K détouré, calque scène, régénération. Le décompte :
// 1 création débitée à l'export final (logo master = son export) ;
// 5 retouches incluses par création, la 6e reprend 1 création.

const INCLUDED_RETOUCHES = 5
const RATE_LIMIT_PER_MINUTE = 10

const LOGO_STYLES = ['chrome', 'graffiti', 'luxe', 'neon', 'cartoon', 'minimal'] as const
const LOGO_TYPES = ['lettre', 'nom', 'embleme'] as const

function isEngineCategory(value: unknown): value is EngineCategory {
  return typeof value === 'string' && value in CATEGORY_IMAGE_CONFIG
}

function parseLogoAnswers(raw: unknown): LogoAnswers | null {
  const input = raw as { type?: unknown; style?: unknown; palette?: unknown } | null
  if (!input) return null
  const type = LOGO_TYPES.includes(input.type as never) ? (input.type as LogoAnswers['type']) : null
  const style = LOGO_STYLES.includes(input.style as never) ? (input.style as LogoAnswers['style']) : null
  const palette = Array.isArray(input.palette)
    ? input.palette.filter((c): c is string => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)).slice(0, 6)
    : []
  if (!type || !style) return null
  return { type, style, palette }
}

function parseSceneAnswers(raw: unknown): SceneAnswers {
  const input = (raw ?? {}) as Record<string, unknown>
  return {
    templateId: typeof input.templateId === 'string' ? input.templateId : undefined,
    lieu: sanitizeText(input.lieu, 200) || undefined,
    personnages: sanitizeText(input.personnages, 200) || undefined,
    moment: sanitizeText(input.moment, 160) || undefined,
    props: sanitizeText(input.props, 200) || undefined,
    ambianceScene: sanitizeText(input.ambianceScene, 240) || undefined,
  }
}

async function loadOwnedProject(userId: string, projectId: string) {
  const service = createServiceClient()
  const { data } = await service
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .eq('user_id', userId)
    .maybeSingle()
  return data
}

async function loadOwnedAsset(userId: string, projectId: string, assetId: string) {
  const service = createServiceClient()
  const { data } = await service
    .from('project_assets')
    .select('*')
    .eq('id', assetId)
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .maybeSingle()
  return data
}

// Retouche : les 5 premières sont incluses, ensuite chaque retouche reprend
// 1 création. Retourne le nouvel état ou une erreur 402 prête à renvoyer.
async function chargeRetouch(userId: string, asset: { id: string; retouches_used: number }, label: string) {
  const service = createServiceClient()
  const used = (asset.retouches_used ?? 0) + 1
  let creditCharged = 0
  if (used > INCLUDED_RETOUCHES) {
    const deduction = await deductCredits(service, userId, 1, 'project_retouch', label)
    if (!deduction.success) {
      return { error: jsonError('insufficient_credits', 402, `Les ${INCLUDED_RETOUCHES} retouches incluses sont utilisées et il ne reste aucune création. Recharge dans Abonnement.`) }
    }
    creditCharged = 1
  }
  await service
    .from('project_assets')
    .update({ retouches_used: used, updated_at: new Date().toISOString() })
    .eq('id', asset.id)
  return { used, creditCharged }
}

// Calques par défaut d'une création : scène + logo hérité + textes réels.
function defaultLayers(opts: {
  category: EngineCategory
  sceneUrl: string
  sceneAspect: number
  project: { name: string; ambiance?: { chips?: string[] } | null; logo_master?: { url: string } | null }
}): Layer[] {
  const { category, sceneUrl, sceneAspect, project } = opts
  const chips = project.ambiance?.chips ?? []
  const isStrip = category === 'banniere_fivem'
  const isPortrait = category === 'affiche'

  const layers: Layer[] = [
    {
      id: makeLayerId(),
      type: 'scene',
      name: 'Scène',
      x: 0.5,
      y: 0.5,
      scale: 1,
      rotation: 0,
      opacity: 1,
      blend: 'normal',
      url: sceneUrl,
      aspect: sceneAspect,
    },
  ]

  if (project.logo_master?.url) {
    layers.push({
      id: makeLayerId(),
      type: 'logo',
      name: 'Logo',
      x: isStrip ? 0.055 : 0.9,
      y: isStrip ? 0.5 : 0.12,
      scale: isStrip ? 0.045 : 0.11,
      rotation: 0,
      opacity: 1,
      blend: 'normal',
      variant: 'color',
      url: project.logo_master.url,
      aspect: 1,
    })
  }

  layers.push(
    {
      id: makeLayerId(),
      type: 'text',
      name: 'Titre',
      text: project.name.toUpperCase(),
      font: 'archivo-black',
      weight: 900,
      sizeRel: isStrip ? 0.52 : isPortrait ? 0.085 : 0.13,
      x: 0.5,
      y: isStrip ? 0.5 : 0.44,
      scale: 1,
      rotation: 0,
      opacity: 1,
      blend: 'normal',
      color: '#FFFFFF',
      strokeColor: '#000000',
      strokeWidth: 0,
      shadow: { x: 0, y: 4, blur: 18, color: 'rgba(0,0,0,0.55)' },
      gradient: null,
      letterSpacing: 0.06,
      align: 'center',
      uppercase: true,
    },
    ...(chips.length && !isStrip
      ? [{
          id: makeLayerId(),
          type: 'text' as const,
          name: 'Sous-titre',
          text: chips.join('  ·  ').toUpperCase(),
          font: 'oswald',
          weight: 500,
          sizeRel: isPortrait ? 0.024 : 0.034,
          x: 0.5,
          y: isPortrait ? 0.52 : 0.58,
          scale: 1,
          rotation: 0,
          opacity: 0.92,
          blend: 'normal' as const,
          color: '#FFFFFF',
          strokeColor: '#000000',
          strokeWidth: 0,
          shadow: { x: 0, y: 2, blur: 10, color: 'rgba(0,0,0,0.5)' },
          gradient: null,
          letterSpacing: 0.32,
          align: 'center' as const,
          uppercase: true,
        }]
      : []),
    ...(!isStrip
      ? [{
          id: makeLayerId(),
          type: 'text' as const,
          name: 'Appel à l’action',
          text: 'REJOINS-NOUS',
          font: 'bebas-neue',
          weight: 400,
          sizeRel: isPortrait ? 0.03 : 0.045,
          x: 0.5,
          y: 0.9,
          scale: 1,
          rotation: 0,
          opacity: 1,
          blend: 'normal' as const,
          color: '#FFFFFF',
          strokeColor: '#000000',
          strokeWidth: 0,
          shadow: { x: 0, y: 2, blur: 12, color: 'rgba(0,0,0,0.6)' },
          gradient: null,
          letterSpacing: 0.18,
          align: 'center' as const,
          uppercase: true,
        }]
      : [])
  )

  return layers
}

// Résolution d'export plafonnée par le plan (8K Agence = upscale local
// à venir sur demande, jamais un appel API de plus).
function planLongEdgeCap(plan: string): number {
  if (plan === 'pro') return 4096
  if (plan === 'studio') return 2752
  if (plan === 'creator') return 1920
  return 1024
}

export const engineRoutes = new Elysia({ prefix: '/engine' })
  // Bibliothèque d'effets maison — générés une fois, gratuits à vie
  .get('/effects', () => {
    return Response.json({
      effects: effectsManifest().map((effect) => ({
        ...effect,
        url: `/engine/effects/${effect.id}.png`,
      })),
    })
  })
  .get('/effects/:file', ({ params, set }) => {
    const id = params.file.replace(/\.png$/, '')
    const buffer = effectFileBuffer(id)
    if (!buffer) {
      set.status = 404
      return { error: 'not_found' }
    }
    return new Response(buffer, {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' },
    })
  })

  // ── Export final : compositing serveur à la résolution du plan ──────────
  .post('/export', async ({ request }) => {
    try {
      const auth = await requireUser(request)
      if (isResponse(auth)) return auth
      const { user } = auth

      const rate = checkRateLimit(`engine:${user.id}`, RATE_LIMIT_PER_MINUTE)
      if (!rate.ok) return jsonError('rate_limited', 429)

      const body = await request.json().catch(() => null) as { projectId?: string; assetId?: string } | null
      if (!body?.projectId || !body.assetId) return jsonError('invalid_body', 400)

      const project = await loadOwnedProject(user.id, body.projectId)
      if (!project) return jsonError('project_not_found', 404, 'Projet introuvable.')
      const asset = await loadOwnedAsset(user.id, body.projectId, body.assetId)
      if (!asset) return jsonError('asset_not_found', 404, 'Création introuvable.')

      const service = createServiceClient()
      const credits = await getCredits(service, user.id)
      if (credits < 1) {
        return jsonError('insufficient_credits', 402, "L'export débite 1 création — il n'en reste aucune. Recharge dans Abonnement.")
      }

      const { data: profile } = await service.from('profiles').select('plan').eq('id', user.id).single()
      const cap = planLongEdgeCap(profile?.plan ?? 'free')
      const scale = Math.min(1, cap / Math.max(asset.width, asset.height))
      const targetWidth = Math.max(64, Math.round(asset.width * scale))
      const targetHeight = Math.max(64, Math.round(asset.height * scale))

      const layers = (asset.layers ?? []) as Layer[]

      // Master de scène : itérations en 1K, export re-rendu à la résolution
      // du plan (référence = rendu 1K, composition conservée).
      let sceneOverrideUrl: string | null = null
      const sceneLayer = layers.find((l) => l.type === 'scene' && l.url)
      if (sceneLayer?.url && Math.max(targetWidth, targetHeight) > 1400) {
        const guard = await checkEngineGuards(user.id, 1)
        if (!guard.ok) return jsonError(guard.code, guard.status, guard.message)

        const reference = await fetchAsReference(sceneLayer.url)
        if (reference) {
          const answers = parseSceneAnswers(asset.wizard_answers)
          const compiled = compileScenePrompt({ project, category: asset.category as EngineCategory, answers })
          const imageSize = Math.max(targetWidth, targetHeight) > 2752 ? '4K' : '2K'
          const master = await generateWithSoftRetry({
            model: ENGINE_MODELS.master,
            prompt: `${compiled.prompt}\n\nEXACT RE-RENDER: the attached reference is the approved 1K render of this scene. Reproduce it IDENTICALLY — same composition, same subject, same lighting, same grading — at maximum sharpness and detail.`,
            referenceImages: [reference],
            imageConfig: { aspectRatio: compiled.aspectRatio, imageSize },
            log: { userId: user.id, projectId: body.projectId, assetId: asset.id, kind: `export_scene_${asset.category}`, resolution: imageSize },
          })
          sceneOverrideUrl = await storeRender(
            `${user.id}/${body.projectId}/${asset.id}/scene-master-${Date.now()}.png`,
            master.dataUrl
          )
        }
      }

      const png = await composeAsset({
        layers,
        logoMaster: project.logo_master ?? null,
        width: targetWidth,
        height: targetHeight,
        sceneOverrideUrl,
      })

      const url = await storeBuffer(
        `${user.id}/${body.projectId}/${asset.id}/exports/export-${Date.now()}.png`,
        png,
        'image/png'
      )

      const deduction = await deductCredits(service, user.id, 1, 'project_export', `Export ${asset.category} — ${project.name}`)
      if (!deduction.success) {
        return jsonError('insufficient_credits', 402, "Plus de création disponible pour l'export.")
      }

      await service
        .from('project_assets')
        .update({
          status: 'exported',
          preview_url: url,
          exports: [...(asset.exports ?? []), { url, resolution: `${targetWidth}×${targetHeight}`, at: new Date().toISOString() }],
          updated_at: new Date().toISOString(),
        })
        .eq('id', asset.id)

      return Response.json({
        url,
        resolution: `${targetWidth}×${targetHeight}`,
        remaining: deduction.remaining,
        creditCharged: 1,
      })
    } catch (error) {
      if (error instanceof GeminiError) return jsonError('generation_failed', error.status >= 400 ? error.status : 500, error.message)
      console.error('[engine/export]', error)
      return jsonError('server_error', 500)
    }
  })

  // Templates de scène (wizard) — titres FR issus du .txt du client
  .get('/templates', () => {
    return Response.json({
      templates: listSceneTemplates().map((t) => ({
        id: t.id,
        titre: t.titre,
        scene_type: t.scene_type,
        personnages: t.personnages,
      })),
    })
  })

  // ── Logo : 3 propositions en 1K ─────────────────────────────────────────
  .post('/logo/proposals', async ({ request }) => {
    try {
      const auth = await requireUser(request)
      if (isResponse(auth)) return auth
      const { user } = auth

      const rate = checkRateLimit(`engine:${user.id}`, RATE_LIMIT_PER_MINUTE)
      if (!rate.ok) return jsonError('rate_limited', 429)

      const body = await request.json().catch(() => null) as {
        projectId?: string
        assetId?: string
        answers?: unknown
      } | null
      const answers = parseLogoAnswers(body?.answers)
      if (!body?.projectId || !answers) return jsonError('invalid_body', 400, 'Réponses du questionnaire logo incomplètes.')

      const project = await loadOwnedProject(user.id, body.projectId)
      if (!project) return jsonError('project_not_found', 404, 'Projet introuvable.')
      if (project.logo_master?.url) {
        return jsonError('logo_already_set', 409, 'Le logo master est en place — il se compose, il ne se régénère pas.')
      }

      const guard = await checkEngineGuards(user.id, 3)
      if (!guard.ok) return jsonError(guard.code, guard.status, guard.message)

      const service = createServiceClient()
      // Une création doit être disponible pour ouvrir le chantier logo
      const credits = await getCredits(service, user.id)
      if (credits < 1) {
        return jsonError('insufficient_credits', 402, 'Il faut au moins 1 création disponible pour lancer un logo. Recharge dans Abonnement.')
      }

      // Asset logo : créé à la première salve, réutilisé ensuite
      let asset = body.assetId ? await loadOwnedAsset(user.id, body.projectId, body.assetId) : null
      let retouchesUsed = asset?.retouches_used ?? 0
      let creditCharged = 0
      if (!asset) {
        const { data } = await service
          .from('project_assets')
          .insert({
            project_id: body.projectId,
            user_id: user.id,
            category: 'logo',
            title: `Logo ${project.name}`,
            status: 'draft',
            width: 4096,
            height: 4096,
            layers: [],
            wizard_answers: answers,
            updated_at: new Date().toISOString(),
          })
          .select()
          .single()
        asset = data
      } else {
        // « 3 autres » : consomme une retouche (5 incluses, la 6e = 1 création)
        const charge = await chargeRetouch(user.id, asset, `Logo ${project.name} — 3 nouvelles propositions`)
        if ('error' in charge) return charge.error
        retouchesUsed = charge.used ?? retouchesUsed
        creditCharged = charge.creditCharged ?? 0
      }
      if (!asset) return jsonError('asset_create_failed', 500)

      const compiled = compileLogoPrompt({ project, answers })

      const generations = await Promise.all(
        Array.from({ length: 3 }, () =>
          generateWithSoftRetry({
            model: ENGINE_MODELS.proposal,
            prompt: compiled.prompt,
            imageConfig: { aspectRatio: '1:1', imageSize: '1K' },
            log: { userId: user.id, projectId: body.projectId, assetId: asset.id, kind: 'logo_proposal', resolution: '1K' },
          })
        )
      )

      const proposals = await Promise.all(
        generations.map((gen, i) =>
          storeRender(`${user.id}/${body.projectId}/logo/proposition-${Date.now()}-${i}.png`, gen.dataUrl)
        )
      )

      await service
        .from('project_assets')
        .update({
          wizard_answers: answers,
          compiled_prompts: [...(asset.compiled_prompts ?? []), { kind: 'logo_proposals', prompt: compiled.prompt, at: new Date().toISOString() }],
          updated_at: new Date().toISOString(),
        })
        .eq('id', asset.id)

      // Héritage : la palette choisie pour le logo devient celle du projet
      if (answers.palette.length && !(project.palette ?? []).length) {
        await service.from('projects').update({ palette: answers.palette, updated_at: new Date().toISOString() }).eq('id', project.id)
      }

      return Response.json({
        assetId: asset.id,
        proposals,
        compiledPrompt: compiled.prompt,
        retouchesUsed,
        includedRetouches: INCLUDED_RETOUCHES,
        creditCharged,
      })
    } catch (error) {
      if (error instanceof GeminiError) return jsonError('generation_failed', error.status >= 400 ? error.status : 500, error.message)
      console.error('[engine/logo/proposals]', error)
      return jsonError('server_error', 500)
    }
  })

  // ── Logo : master 4K + détourage + déclinaisons ─────────────────────────
  .post('/logo/master', async ({ request }) => {
    try {
      const auth = await requireUser(request)
      if (isResponse(auth)) return auth
      const { user } = auth

      const rate = checkRateLimit(`engine:${user.id}`, RATE_LIMIT_PER_MINUTE)
      if (!rate.ok) return jsonError('rate_limited', 429)

      const body = await request.json().catch(() => null) as {
        projectId?: string
        assetId?: string
        chosenUrl?: string
      } | null
      if (!body?.projectId || !body.assetId || typeof body.chosenUrl !== 'string') {
        return jsonError('invalid_body', 400)
      }

      const project = await loadOwnedProject(user.id, body.projectId)
      if (!project) return jsonError('project_not_found', 404, 'Projet introuvable.')
      const asset = await loadOwnedAsset(user.id, body.projectId, body.assetId)
      if (!asset) return jsonError('asset_not_found', 404, 'Création logo introuvable.')

      const guard = await checkEngineGuards(user.id, 1)
      if (!guard.ok) return jsonError(guard.code, guard.status, guard.message)

      const service = createServiceClient()
      const credits = await getCredits(service, user.id)
      if (credits < 1) {
        return jsonError('insufficient_credits', 402, 'Plus de création disponible pour finaliser le logo. Recharge dans Abonnement.')
      }

      const reference = await fetchAsReference(body.chosenUrl)
      if (!reference) return jsonError('reference_unreachable', 400, 'La proposition choisie est introuvable.')

      const answers = parseLogoAnswers(asset.wizard_answers) ?? { type: 'embleme', style: 'minimal', palette: project.palette ?? [] }
      const compiled = compileLogoPrompt({ project, answers })

      const masterPrompt = [
        'Reproduce the EXACT same logo as the attached reference image — identical design, identical colors, identical proportions. Do not redesign, do not add elements.',
        'Render it at maximum sharpness with vector-grade clean edges.',
        `Background: perfectly flat, uniform, seamless ${compiled.background === '#FFFFFF' ? 'pure white (#FFFFFF)' : 'pure black (#000000)'}. Nothing else in the frame. The logo must not touch the edges — keep 12% padding.`,
        'Square 1:1 composition, logo perfectly centered.',
      ].join('\n')

      const master = await generateWithSoftRetry({
        model: ENGINE_MODELS.master,
        prompt: masterPrompt,
        referenceImages: [reference],
        imageConfig: { aspectRatio: '1:1', imageSize: '4K' },
        log: { userId: user.id, projectId: body.projectId, assetId: asset.id, kind: 'logo_master', resolution: '4K' },
      })

      // Détourage local (zéro appel API) + déclinaisons blanc/noir
      const masterBuffer = Buffer.from(master.dataUrl.split(',').pop() ?? '', 'base64')
      const cutout = await cutoutFlatBackground(masterBuffer)
      const [white, black] = await Promise.all([
        makeMonochrome(cutout.png, 'white'),
        makeMonochrome(cutout.png, 'black'),
      ])

      const base = `${user.id}/${body.projectId}/logo`
      const [url, whiteUrl, blackUrl] = await Promise.all([
        storeBuffer(`${base}/master.png`, cutout.png, 'image/png'),
        storeBuffer(`${base}/master-blanc.png`, white, 'image/png'),
        storeBuffer(`${base}/master-noir.png`, black, 'image/png'),
      ])

      const deduction = await deductCredits(service, user.id, 1, 'project_creation', `Logo master — ${project.name}`)
      if (!deduction.success) {
        return jsonError('insufficient_credits', 402, 'Plus de création disponible. Recharge dans Abonnement.')
      }

      const logoMaster = { url, whiteUrl, blackUrl, width: cutout.width, height: cutout.height }
      await service.from('projects').update({ logo_master: logoMaster, updated_at: new Date().toISOString() }).eq('id', project.id)
      await service
        .from('project_assets')
        .update({
          status: 'exported',
          preview_url: url,
          exports: [...(asset.exports ?? []), { url, resolution: '4K', at: new Date().toISOString() }],
          compiled_prompts: [...(asset.compiled_prompts ?? []), { kind: 'logo_master', prompt: masterPrompt, at: new Date().toISOString() }],
          updated_at: new Date().toISOString(),
        })
        .eq('id', asset.id)

      return Response.json({ logoMaster, remaining: deduction.remaining })
    } catch (error) {
      if (error instanceof GeminiError) return jsonError('generation_failed', error.status >= 400 ? error.status : 500, error.message)
      console.error('[engine/logo/master]', error)
      return jsonError('server_error', 500)
    }
  })

  // ── Calque scène d'une création ─────────────────────────────────────────
  .post('/scene', async ({ request }) => {
    try {
      const auth = await requireUser(request)
      if (isResponse(auth)) return auth
      const { user } = auth

      const rate = checkRateLimit(`engine:${user.id}`, RATE_LIMIT_PER_MINUTE)
      if (!rate.ok) return jsonError('rate_limited', 429)

      const body = await request.json().catch(() => null) as {
        projectId?: string
        category?: unknown
        title?: unknown
        answers?: unknown
      } | null
      if (!body?.projectId || !isEngineCategory(body.category) || body.category === 'logo') {
        return jsonError('invalid_body', 400, 'Catégorie de création invalide.')
      }

      const project = await loadOwnedProject(user.id, body.projectId)
      if (!project) return jsonError('project_not_found', 404, 'Projet introuvable.')
      if (!project.logo_master?.url) {
        return jsonError('logo_required', 409, "Crée d'abord le logo du projet — c'est lui qui signe chaque visuel.")
      }

      const guard = await checkEngineGuards(user.id, 1)
      if (!guard.ok) return jsonError(guard.code, guard.status, guard.message)

      const service = createServiceClient()
      const credits = await getCredits(service, user.id)
      if (credits < 1) {
        return jsonError('insufficient_credits', 402, 'Il faut au moins 1 création disponible. Recharge dans Abonnement.')
      }

      const answers = parseSceneAnswers(body.answers)
      const compiled = compileScenePrompt({ project, category: body.category, answers })
      const config = CATEGORY_IMAGE_CONFIG[body.category]

      const generation = await generateWithSoftRetry({
        model: ENGINE_MODELS.scene,
        prompt: compiled.prompt,
        imageConfig: { aspectRatio: compiled.aspectRatio, imageSize: '1K' },
        log: { userId: user.id, projectId: body.projectId, kind: `scene_${body.category}`, resolution: '1K' },
      })

      const sceneBuffer = Buffer.from(generation.dataUrl.split(',').pop() ?? '', 'base64')
      const meta = await sharp(sceneBuffer).metadata()
      const sceneAspect = meta.width && meta.height ? meta.width / meta.height : config.canvas.width / config.canvas.height

      const { data: asset } = await service
        .from('project_assets')
        .insert({
          project_id: body.projectId,
          user_id: user.id,
          category: body.category,
          title: sanitizeText(body.title, 80) || null,
          status: 'draft',
          width: config.canvas.width,
          height: config.canvas.height,
          layers: [],
          wizard_answers: answers,
          updated_at: new Date().toISOString(),
        })
        .select()
        .single()
      if (!asset) return jsonError('asset_create_failed', 500)

      const sceneUrl = await storeRender(`${user.id}/${body.projectId}/${asset.id}/scene-${Date.now()}.png`, generation.dataUrl)
      const layers = defaultLayers({ category: body.category, sceneUrl, sceneAspect, project })

      const { data: updated } = await service
        .from('project_assets')
        .update({
          layers,
          compiled_prompts: [{ kind: 'scene', prompt: generation.finalPrompt, retried: generation.retried, at: new Date().toISOString() }],
          updated_at: new Date().toISOString(),
        })
        .eq('id', asset.id)
        .select()
        .single()

      await service.from('projects').update({ updated_at: new Date().toISOString() }).eq('id', project.id)

      return Response.json({ asset: updated ?? asset, compiledPrompt: generation.finalPrompt, retried: generation.retried })
    } catch (error) {
      if (error instanceof GeminiError) return jsonError('generation_failed', error.status >= 400 ? error.status : 500, error.message)
      console.error('[engine/scene]', error)
      return jsonError('server_error', 500)
    }
  })

  // ── Régénérer le calque scène (retouche) ────────────────────────────────
  .post('/scene/regenerate', async ({ request }) => {
    try {
      const auth = await requireUser(request)
      if (isResponse(auth)) return auth
      const { user } = auth

      const rate = checkRateLimit(`engine:${user.id}`, RATE_LIMIT_PER_MINUTE)
      if (!rate.ok) return jsonError('rate_limited', 429)

      const body = await request.json().catch(() => null) as {
        projectId?: string
        assetId?: string
        answers?: unknown
        keepComposition?: boolean
      } | null
      if (!body?.projectId || !body.assetId) return jsonError('invalid_body', 400)

      const project = await loadOwnedProject(user.id, body.projectId)
      if (!project) return jsonError('project_not_found', 404, 'Projet introuvable.')
      const asset = await loadOwnedAsset(user.id, body.projectId, body.assetId)
      if (!asset) return jsonError('asset_not_found', 404, 'Création introuvable.')

      const guard = await checkEngineGuards(user.id, 1)
      if (!guard.ok) return jsonError(guard.code, guard.status, guard.message)

      const charge = await chargeRetouch(user.id, asset, `Retouche scène — ${project.name}`)
      if ('error' in charge) return charge.error

      const previousAnswers = parseSceneAnswers(asset.wizard_answers)
      const newAnswers = { ...previousAnswers, ...parseSceneAnswers(body.answers) }
      const category = asset.category as EngineCategory
      const compiled = compileScenePrompt({ project, category, answers: newAnswers })

      const layers = (asset.layers ?? []) as Layer[]
      const sceneLayer = layers.find((l) => l.type === 'scene')

      let prompt = compiled.prompt
      const referenceImages: Array<{ data: string; mimeType: string }> = []
      if (body.keepComposition && sceneLayer?.url) {
        const reference = await fetchAsReference(sceneLayer.url)
        if (reference) {
          referenceImages.push(reference)
          prompt = `${compiled.prompt}\n\nKEEP COMPOSITION: the attached reference is the previous render of this exact scene. Keep the same composition, camera, framing and main subject placement — apply only the changes described above.`
        }
      }

      const generation = await generateWithSoftRetry({
        model: ENGINE_MODELS.scene,
        prompt,
        referenceImages,
        imageConfig: { aspectRatio: compiled.aspectRatio, imageSize: '1K' },
        log: { userId: user.id, projectId: body.projectId, assetId: asset.id, kind: `retouch_${category}`, resolution: '1K' },
      })

      const sceneBuffer = Buffer.from(generation.dataUrl.split(',').pop() ?? '', 'base64')
      const meta = await sharp(sceneBuffer).metadata()
      const sceneUrl = await storeRender(`${user.id}/${body.projectId}/${asset.id}/scene-${Date.now()}.png`, generation.dataUrl)

      const service = createServiceClient()
      const newLayers = layers.map((layer) =>
        layer.type === 'scene'
          ? { ...layer, url: sceneUrl, aspect: meta.width && meta.height ? meta.width / meta.height : layer.aspect }
          : layer
      )
      const { data: updated } = await service
        .from('project_assets')
        .update({
          layers: newLayers,
          wizard_answers: newAnswers,
          compiled_prompts: [
            ...(asset.compiled_prompts ?? []),
            { kind: 'retouch', prompt: generation.finalPrompt, keepComposition: Boolean(body.keepComposition), retried: generation.retried, at: new Date().toISOString() },
          ],
          updated_at: new Date().toISOString(),
        })
        .eq('id', asset.id)
        .select()
        .single()

      securityLog('engine_retouch', { userId: user.id, assetId: asset.id, used: charge.used ?? 0 })

      return Response.json({
        asset: updated,
        retouchesUsed: charge.used,
        includedRetouches: INCLUDED_RETOUCHES,
        creditCharged: charge.creditCharged,
        retried: generation.retried,
      })
    } catch (error) {
      if (error instanceof GeminiError) return jsonError('generation_failed', error.status >= 400 ? error.status : 500, error.message)
      console.error('[engine/scene/regenerate]', error)
      return jsonError('server_error', 500)
    }
  })
