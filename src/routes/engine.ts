import { Elysia } from 'elysia'
import sharp from 'sharp'
import { requireUser, isResponse } from '../lib/require-auth'
import { createServiceClient } from '../lib/supabase'
import { checkRateLimit, jsonError, sanitizeText, securityLog } from '../lib/security'
import { checkEngineGuards } from '../lib/engine/guards'
import { deductCredits, getCredits } from '../lib/credits'
import {
  CATEGORY_IMAGE_CONFIG,
  compileHeroPromptV2,
  compileInstructPrompt,
  compileLogoFondPrompt,
  listSceneTemplates,
  type EngineCategory,
  type SceneAnswers,
} from '../lib/engine/compiler'
import { composeBanniereLogo, composeLogoOnFond } from '../lib/engine/logo-compose'
import { LOGO_FOND_CHOIX, type LogoFondChoix } from '../lib/engine/logo-brief'
import { artDirectionForProject } from '../lib/engine/mapping'
import { adnBlockBackground, getTrainingStatus, requireTraining, TrainingRequiredError } from '../lib/engine/adn'
import {
  ENGINE_MODELS,
  fetchAsReference,
  storeBuffer,
  storeRender,
} from '../lib/engine/generation'
import { generateWithOcrGate } from '../lib/engine/ocr-gate'
import { parseLogoAnswersV3, LOGO_AMBIANCE_TAG } from '../lib/engine/logo-brief'
import { directLogoConcepts, type LogoConcept } from '../lib/engine/logo-director'
import { generateLogoProposition, type LogoProposition } from '../lib/engine/logo-pipeline'
import { assembleLogo, declineMonochrome } from '../lib/engine/logo-stack'
import { pickExemplars, styleQueryForMatiere } from '../lib/engine/exemplars'
import { estimateCostEur } from '../lib/engine/pricing'
import { makeLayerId, type Layer } from '../lib/engine/layers'
import { composeAsset, effectFileBuffer, effectsManifest } from '../lib/engine/composite'
import { GeminiError } from '../lib/ai/gemini'

// ── Le moteur produit (run 5.2, LOT 3/4) ─────────────────────────────────────
// Toutes les générations liées aux projets passent ici. Depuis le run 5.2 :
// le calque héro embarque le TITRE GÉNÉRÉ DANS L'IMAGE (plus aucun calque
// texte système), chaque appel joint des références d'entraînement, et
// l'OCR gate rejette en silence tout lettrage mal épelé (max 2 par slot).
// Le décompte : 1 création débitée à l'export final (logo master = son
// export) ; 5 retouches incluses par création, la 6e reprend 1 création.

const INCLUDED_RETOUCHES = 5
const RATE_LIMIT_PER_MINUTE = 10

// Garde-fou run 5.4 (LOT 0) : plus AUCUNE génération logo/héro sans
// entraînement v4 installé — la « dégradation propre » est supprimée.
function trainingRequiredResponse(error: unknown): Response | null {
  if (error instanceof TrainingRequiredError) {
    return jsonError('training_required', 409, error.message)
  }
  return null
}

const TRAINING_REQUIRED_UI_MESSAGE = 'Entraînement requis — lance `bun run scripts/train-fivem-v4.ts`'

function isEngineCategory(value: unknown): value is EngineCategory {
  return typeof value === 'string' && value in CATEGORY_IMAGE_CONFIG
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
    baseline: sanitizeText(input.baseline, 80) || undefined,
    logoInScene: input.logoInScene === true,
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

// Pile par défaut d'une création v2 : [héro scène+titre] [logo PNG composé].
// Le titre vit DANS le héro — plus aucun calque texte système.
function defaultLayers(opts: {
  category: EngineCategory
  sceneUrl: string
  sceneAspect: number
  project: { logo_master?: { url: string } | null }
}): Layer[] {
  const { category, sceneUrl, sceneAspect, project } = opts
  const isStrip = category === 'banniere_fivem'

  const layers: Layer[] = [
    {
      id: makeLayerId(),
      type: 'scene',
      name: 'Héro (scène + titre)',
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

  return layers
}

// Textes que le héro d'un asset doit afficher — sert aux retouches et au
// re-rendu d'export pour re-forcer l'épellation et re-passer l'OCR gate.
function expectedTextsForAsset(project: { name: string }, category: EngineCategory, answers: SceneAnswers): string[] {
  if (category === 'icon') return []
  const texts = [project.name.trim().toUpperCase()]
  const baseline = (answers.baseline ?? '').trim().toUpperCase()
  if (baseline) texts.push(baseline)
  return texts
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
  // ── Badge d'état de l'entraînement (run 5.4, LOT 0) ─────────────────────
  // Le wizard et la page de test l'affichent en tête : le client ne doit
  // plus JAMAIS pouvoir tester sans savoir si l'ADN est actif.
  .get('/training-status', async ({ request }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    return Response.json({ training: getTrainingStatus(), message: TRAINING_REQUIRED_UI_MESSAGE })
  })

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

      // L'export peut re-rendre le master : même garde que la génération.
      requireTraining()

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
      // du plan (référence = rendu 1K, composition conservée, épellation
      // re-forcée et re-validée par l'OCR gate).
      let sceneOverrideUrl: string | null = null
      const sceneLayer = layers.find((l) => l.type === 'scene' && l.url)
      if (sceneLayer?.url && Math.max(targetWidth, targetHeight) > 1400) {
        const guard = await checkEngineGuards(user.id, 1)
        if (!guard.ok) return jsonError(guard.code, guard.status, guard.message)

        const reference = await fetchAsReference(sceneLayer.url)
        if (reference) {
          const category = asset.category as EngineCategory
          const answers = parseSceneAnswers(asset.wizard_answers)
          const { da, energie, modernite } = artDirectionForProject(project)
          const compiled = compileHeroPromptV2({ project, category: category as Exclude<EngineCategory, 'logo'>, da, answers, energie, modernite })
          const imageSize = Math.max(targetWidth, targetHeight) > 2752 ? '4K' : '2K'
          const master = await generateWithOcrGate({
            model: ENGINE_MODELS.master,
            prompt: `${compiled.prompt}\n\nEXACT RE-RENDER: the LAST attached image is the approved 1K render of this exact hero. Reproduce it IDENTICALLY — same composition, same subjects, same title lettering and spelling, same grading — at maximum sharpness and detail.`,
            referenceImages: [reference],
            imageConfig: { aspectRatio: compiled.aspectRatio, imageSize },
            expectedTexts: expectedTextsForAsset(project, category, answers),
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
      const training = trainingRequiredResponse(error)
      if (training) return training
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

  // ── Logo v3 : le pipeline réfléchi (run 5.3, LOT 1) ─────────────────────
  // Étage 1 : le DA (Gemini 3.1 Pro, thinking HIGH) écrit 3 concepts
  // distincts. Étage 2 : chaque concept est exécuté par le pro image (2K,
  // thinking, 2-3 références jointes). Étage 3 : OCR gate + contrôle de
  // concept, 1 régénération ciblée max. Le flash ne touche plus au logo.
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
      const answers = parseLogoAnswersV3(body?.answers)
      if (!body?.projectId || !answers) return jsonError('invalid_body', 400, 'Réponses du questionnaire logo incomplètes.')

      // LOT 0 : pas d'entraînement v4 installé = pas de génération, point.
      requireTraining()

      const project = await loadOwnedProject(user.id, body.projectId)
      if (!project) return jsonError('project_not_found', 404, 'Projet introuvable.')
      if (project.logo_master?.url) {
        return jsonError('logo_already_set', 409, 'Le logo master est en place — il se compose, il ne se régénère pas.')
      }

      // Run 5.7 : 3 propositions × (fond + emblème) + régénérations ciblées
      const guard = await checkEngineGuards(user.id, 6)
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

      const { da, energie, modernite } = artDirectionForProject(project)

      // ÉTAGE 1 — le directeur artistique écrit 3 concepts distincts
      const direction = await directLogoConcepts({
        project,
        da,
        answers,
        energie,
        modernite,
        log: { userId: user.id, projectId: body.projectId, assetId: asset.id },
      })
      const daEur = estimateCostEur({
        model: ENGINE_MODELS.logoDirector,
        tokensIn: direction.usage.tokensIn,
        tokensOut: direction.usage.tokensOut,
      })

      // Références jointes à CHAQUE génération : cluster du mapping d'abord,
      // puis les références uploadées par l'utilisateur (3 max au total).
      // Run 5.5 (wizard v4) : le tag d'ambiance du logo pilote la sélection.
      // Run 5.8 (chantier 2) : la MARQUE (lockup/emblème) reçoit 3 références
      // de la MÊME famille de rendu que son concept, lettrage travaillé
      // privilégié — sinon le transfert de style est faible. Le fond garde la
      // sélection cluster + les références utilisateur.
      const daLogo = answers.ambiance
        ? { ...da, clusterTags: [...new Set([...da.clusterTags, LOGO_AMBIANCE_TAG[answers.ambiance]])] }
        : da
      const exemplarsFond = pickExemplars({ category: 'logo', da: daLogo, energie, modernite, maxPrompts: 0, maxReferences: 2 })
      const fondRefs = [...exemplarsFond.references]
      const userRefs = ((project.ambiance?.references ?? []) as string[]).slice(0, 3 - fondRefs.length)
      for (const url of userRefs) {
        const ref = await fetchAsReference(url)
        if (ref) fondRefs.push(ref)
      }
      // Run 5.9 (chantier 1) : la matière demandée au wizard pilote aussi la
      // sélection — les références jointes exécutent le traitement demandé.
      const styleQuery = styleQueryForMatiere(answers.matiere)
      const marqueParFamille = new Map<string, ReturnType<typeof pickExemplars>>()
      const marquePourFamille = (famille: LogoConcept['famille']) => {
        let sel = marqueParFamille.get(famille)
        if (!sel) {
          sel = pickExemplars({
            category: 'logo',
            da: daLogo,
            energie,
            modernite,
            maxPrompts: 0,
            maxReferences: 3,
            famille,
            prefereLettrage: true,
            traitements: styleQuery.traitements,
            matiereMotsCles: styleQuery.matiereMotsCles,
          })
          marqueParFamille.set(famille, sel)
        }
        return sel
      }

      // ÉTAGES 2 + 3 — un concept = une proposition, relue avant affichage.
      // allSettled : un concept qui échoue (OCR à bout, refus) ne coule pas
      // les deux autres.
      const settled = await Promise.allSettled(
        direction.concepts.map((concept, i) =>
          generateLogoProposition({
            projectName: project.name,
            answers,
            concept,
            references: { fond: fondRefs, marque: marquePourFamille(concept.famille).references },
            resolution: '2K',
            log: { userId: user.id, projectId: body.projectId, assetId: asset.id, kind: `logo_proposal_${i + 1}` },
          })
        )
      )
      const propositions = settled
        .filter((s): s is PromiseFulfilledResult<LogoProposition> => s.status === 'fulfilled')
        .map((s) => s.value)
      if (!propositions.length) {
        const firstError = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected')
        const reason = firstError?.reason as Error | undefined
        return jsonError('generation_failed', 502, reason?.message ?? 'Aucune proposition n’a passé la relecture — relance la génération.')
      }

      // Run 5.7 : les CALQUES de chaque proposition sont stockés avec elle —
      // le master 4K sera un ré-assemblage local (zéro appel API), et chaque
      // calque reste régénérable/ajustable indépendamment.
      const stamp = Date.now()
      const stored = await Promise.all(
        propositions.map(async (prop, i) => {
          const base = `${user.id}/${body.projectId}/logo/proposition-${stamp}-${i}`
          const [url, alphaUrl, fondUrl, lockupUrl, emblemeUrl] = await Promise.all([
            storeRender(`${base}.png`, prop.dataUrl),
            storeRender(`${base}-alpha.png`, prop.layers.alphaDataUrl),
            prop.layers.fondDataUrl ? storeRender(`${base}-fond.png`, prop.layers.fondDataUrl) : Promise.resolve(null),
            prop.layers.lockupDataUrl ? storeRender(`${base}-lockup.png`, prop.layers.lockupDataUrl) : Promise.resolve(null),
            prop.layers.emblemeDataUrl ? storeRender(`${base}-embleme.png`, prop.layers.emblemeDataUrl) : Promise.resolve(null),
          ])
          return {
            url,
            layers: { alphaUrl, fondUrl, lockupUrl, emblemeUrl },
            concept: prop.concept,
            famille: prop.concept.famille,
            ocrRejects: prop.ocrRejects,
            conceptOk: prop.conceptOk,
            adnOk: prop.adnOk,
            serveurLogo: prop.serveurLogo,
            lisible64: prop.lisible64,
            scores: prop.scores,
            defauts: prop.defauts,
            regenere: prop.regenere,
            calqueRegenere: prop.calqueRegenere,
            modeLockup: prop.modeLockup,
            fallbackLettrageLocal: prop.fallbackLettrageLocal,
            // run 5.8 (chantier 5) : les prompts calques RÉELLEMENT envoyés à
            // l'API — un rendu raté se rejoue désormais à l'identique.
            promptsCalques: prop.promptsCalques,
          }
        })
      )

      const coutParEtage = {
        daEur,
        generationEur: Math.round(propositions.reduce((s, p) => s + p.cout.generationEur, 0) * 10000) / 10000,
        relectureEur: Math.round(propositions.reduce((s, p) => s + p.cout.relectureEur, 0) * 10000) / 10000,
      }

      await service
        .from('project_assets')
        .update({
          wizard_answers: answers,
          compiled_prompts: [
            ...(asset.compiled_prompts ?? []),
            {
              kind: 'logo_concepts',
              concepts: direction.concepts,
              // run 5.7 : url → calques, pour le ré-assemblage 4K local du master
              // run 5.8 : + les prompts calques réellement envoyés (rejouables)
              propositions: stored.map((p) => ({
                url: p.url,
                layers: p.layers,
                concept: p.concept,
                modeLockup: p.modeLockup,
                fallbackLettrageLocal: p.fallbackLettrageLocal,
                promptsCalques: p.promptsCalques,
              })),
              references: fondRefs.length,
              exemplars: exemplarsFond.slugs,
              exemplarsMarque: Object.fromEntries([...marqueParFamille.entries()].map(([f, s]) => [f, s.slugs])),
              coutParEtage,
              at: new Date().toISOString(),
            },
          ],
          updated_at: new Date().toISOString(),
        })
        .eq('id', asset.id)

      // Héritage : la palette dérivée du mapping devient celle du projet
      if (da.palette.length && !(project.palette ?? []).length) {
        await service.from('projects').update({ palette: da.palette, updated_at: new Date().toISOString() }).eq('id', project.id)
      }

      return Response.json({
        assetId: asset.id,
        propositions: stored,
        // compat éditeur/wizard : la liste d'URLs reste disponible
        proposals: stored.map((p) => p.url),
        concepts: direction.concepts,
        coutParEtage: {
          ...coutParEtage,
          totalEur: Math.round((coutParEtage.daEur + coutParEtage.generationEur + coutParEtage.relectureEur) * 10000) / 10000,
        },
        retouchesUsed,
        includedRetouches: INCLUDED_RETOUCHES,
        creditCharged,
      })
    } catch (error) {
      const training = trainingRequiredResponse(error)
      if (training) return training
      if (error instanceof GeminiError) return jsonError('generation_failed', error.status >= 400 ? error.status : 500, error.message)
      console.error('[engine/logo/proposals]', error)
      return jsonError('server_error', 500)
    }
  })

  // ── Logo : master 4K + détourage #F2F2F2 + déclinaisons ─────────────────
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

      requireTraining()

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

      const answers = parseLogoAnswersV3(asset.wizard_answers) ?? parseLogoAnswersV3({ type: 'embleme' })!

      // ── Run 5.7 : le master 4K est un RÉ-ASSEMBLAGE LOCAL des calques ──────
      // stockés avec la proposition — ZÉRO appel API. Le lettrage est re-rendu
      // net à l'échelle 4K (vraie police), le fond et l'emblème sont upscalés.
      // La reproduction monolithique 4K « Reproduce the EXACT same logo » est
      // SUPPRIMÉE (elle réveillait le prior « gaming logo 2015 »).
      type StoredLayers = { alphaUrl: string | null; fondUrl: string | null; lockupUrl?: string | null; emblemeUrl: string | null }
      const conceptEntries = ((asset.compiled_prompts ?? []) as Array<{
        kind?: string
        propositions?: Array<{ url: string; layers: StoredLayers; concept: LogoConcept }>
      }>).filter((e) => e.kind === 'logo_concepts')
      let chosen: { layers: StoredLayers; concept: LogoConcept } | null = null
      for (const entry of [...conceptEntries].reverse()) {
        const hit = (entry.propositions ?? []).find((p) => p.url === body.chosenUrl)
        if (hit) {
          chosen = hit
          break
        }
      }
      if (!chosen?.concept?.calques) {
        return jsonError(
          'proposition_layers_missing',
          409,
          'Cette proposition date d’avant le pipeline par calques (run 5.7) — relance « 3 propositions » pour obtenir des propositions ré-assemblables.'
        )
      }

      const fetchLayer = async (url: string | null): Promise<Buffer | null> => {
        if (!url) return null
        const ref = await fetchAsReference(url)
        return ref ? Buffer.from(ref.data, 'base64') : null
      }
      const [fondPng, lockupPng, emblemePng] = await Promise.all([
        fetchLayer(chosen.layers.fondUrl),
        fetchLayer(chosen.layers.lockupUrl ?? null),
        fetchLayer(chosen.layers.emblemeUrl),
      ])

      const cutoutNeeded = answers.fond === 'transparent'
      const stack = await assembleLogo({
        fondPng: cutoutNeeded ? undefined : fondPng ?? undefined,
        lockupPng: lockupPng ?? undefined,
        emblemePng: emblemePng ?? undefined,
        recette: chosen.concept.calques,
        taille: 4096,
      })

      // Déclinaisons : dérivées du couple lettrage+emblème SANS le fond —
      // le détourage est trivial par construction (plus de flood-fill).
      const masterPng: Buffer = cutoutNeeded ? stack.alpha : stack.master
      const masterWidth = stack.width
      const masterHeight = stack.height
      const [white, black] = await Promise.all([
        declineMonochrome(stack.alpha, 'white'),
        declineMonochrome(stack.alpha, 'black'),
      ])

      const base = `${user.id}/${body.projectId}/logo`
      const [url, whiteUrl, blackUrl] = await Promise.all([
        storeBuffer(`${base}/master.png`, masterPng, 'image/png'),
        storeBuffer(`${base}/master-blanc.png`, white, 'image/png'),
        storeBuffer(`${base}/master-noir.png`, black, 'image/png'),
      ])

      const deduction = await deductCredits(service, user.id, 1, 'project_creation', `Logo master — ${project.name}`)
      if (!deduction.success) {
        return jsonError('insufficient_credits', 402, 'Plus de création disponible. Recharge dans Abonnement.')
      }

      const logoMaster = { url, whiteUrl, blackUrl, width: masterWidth, height: masterHeight }
      await service.from('projects').update({ logo_master: logoMaster, updated_at: new Date().toISOString() }).eq('id', project.id)
      await service
        .from('project_assets')
        .update({
          status: 'exported',
          preview_url: url,
          exports: [...(asset.exports ?? []), { url, resolution: '4K', at: new Date().toISOString() }],
          compiled_prompts: [
            ...(asset.compiled_prompts ?? []),
            { kind: 'logo_master', assemblage: 'local_4k_calques_run57', chosenUrl: body.chosenUrl, at: new Date().toISOString() },
          ],
          updated_at: new Date().toISOString(),
        })
        .eq('id', asset.id)

      return Response.json({ logoMaster, remaining: deduction.remaining })
    } catch (error) {
      const training = trainingRequiredResponse(error)
      if (training) return training
      if (error instanceof GeminiError) return jsonError('generation_failed', error.status >= 400 ? error.status : 500, error.message)
      console.error('[engine/logo/master]', error)
      return jsonError('server_error', 500)
    }
  })

  // ── Étape B (run 5.4, LOT 4) : les FONDS du logo, générés SANS lui ──────
  // « Ton logo est prêt. On lui fait une scène ? » — le fond signature
  // (dégradé + doodles du sujet), atmosphérique (sombre dramatique) ou scène.
  // Chaque fond généré = 1 retouche du compteur. Le logo n'apparaît JAMAIS
  // dans la génération : la composition [fond][logo] est locale (ombre douce
  // + glow de contact), et chaque calque se régénère indépendamment.
  .post('/logo/fond/proposals', async ({ request }) => {
    try {
      const auth = await requireUser(request)
      if (isResponse(auth)) return auth
      const { user } = auth

      const rate = checkRateLimit(`engine:${user.id}`, RATE_LIMIT_PER_MINUTE)
      if (!rate.ok) return jsonError('rate_limited', 429)

      const body = await request.json().catch(() => null) as {
        projectId?: string
        assetId?: string
        choix?: unknown
        ambianceScene?: unknown
        count?: unknown
      } | null
      const choix = LOGO_FOND_CHOIX.includes(body?.choix as LogoFondChoix) ? (body?.choix as LogoFondChoix) : null
      if (!body?.projectId || !body.assetId || !choix) {
        return jsonError('invalid_body', 400, 'Choisis un type de fond (signature, atmosphérique ou scène).')
      }
      const count = Math.max(1, Math.min(3, Number(body.count) || 2))

      requireTraining()

      const project = await loadOwnedProject(user.id, body.projectId)
      if (!project) return jsonError('project_not_found', 404, 'Projet introuvable.')
      if (!project.logo_master?.url) {
        return jsonError('logo_required', 409, "Valide d'abord le logo master — l'étape B habille un logo prêt.")
      }
      const asset = await loadOwnedAsset(user.id, body.projectId, body.assetId)
      if (!asset) return jsonError('asset_not_found', 404, 'Création logo introuvable.')

      const guard = await checkEngineGuards(user.id, count)
      if (!guard.ok) return jsonError(guard.code, guard.status, guard.message)

      const logoRef = await fetchAsReference(project.logo_master.url)
      if (!logoRef) return jsonError('reference_unreachable', 400, 'Le logo master est introuvable.')
      const logoPng = Buffer.from(logoRef.data, 'base64')

      const answers = parseLogoAnswersV3(asset.wizard_answers)
      const { da, energie, modernite } = artDirectionForProject(project)
      const couleurs =
        answers?.couleurs.mode === 'degrade' ? answers.couleurs.couleurs
        : answers?.couleurs.mode === 'unie' ? [answers.couleurs.couleur]
        : da.palette

      const compiled = compileLogoFondPrompt({
        da,
        choix,
        sujet: answers?.sujet ?? '',
        couleurs,
        ambianceScene: sanitizeText(body.ambianceScene, 200) || undefined,
        energie,
        modernite,
        adnFondBlock: adnBlockBackground(),
      })

      const fonds: Array<{ fondUrl: string; previewUrl: string; choix: LogoFondChoix }> = []
      let retouchesUsed = asset.retouches_used ?? 0
      let creditCharged = 0
      for (let i = 0; i < count; i += 1) {
        // 1 fond généré = 1 retouche — débitée AVANT la génération du fond
        const charge = await chargeRetouch(user.id, { id: asset.id, retouches_used: retouchesUsed }, `Fond de logo (${choix}) — ${project.name}`)
        if ('error' in charge) {
          if (!fonds.length) return charge.error
          break
        }
        retouchesUsed = charge.used ?? retouchesUsed + 1
        creditCharged += charge.creditCharged ?? 0

        const generation = await generateWithOcrGate({
          model: ENGINE_MODELS.scene,
          prompt: compiled.prompt,
          referenceImages: compiled.references,
          imageConfig: { aspectRatio: '1:1', imageSize: '2K' },
          expectedTexts: [],
          log: { userId: user.id, projectId: body.projectId, assetId: asset.id, kind: `logo_fond_${choix}`, resolution: '2K' },
        })
        const fondPng = Buffer.from(generation.dataUrl.split(',').pop() ?? '', 'base64')
        const stamp = `${Date.now()}-${i}`
        const [fondUrl, previewUrl] = await Promise.all([
          storeBuffer(`${user.id}/${body.projectId}/logo/fonds/fond-${stamp}.png`, fondPng, 'image/png'),
          composeLogoOnFond({ fondPng, logoPng, width: 1024, height: 1024 }).then((png) =>
            storeBuffer(`${user.id}/${body.projectId}/logo/fonds/preview-${stamp}.png`, png, 'image/png')
          ),
        ])
        fonds.push({ fondUrl, previewUrl, choix })
      }

      const service = createServiceClient()
      await service
        .from('project_assets')
        .update({
          compiled_prompts: [
            ...(asset.compiled_prompts ?? []),
            { kind: 'logo_fond', choix, prompt: compiled.prompt, exemplars: compiled.exemplarSlugs, references: compiled.references.length, fonds: fonds.length, at: new Date().toISOString() },
          ],
          updated_at: new Date().toISOString(),
        })
        .eq('id', asset.id)

      return Response.json({ fonds, retouchesUsed, includedRetouches: INCLUDED_RETOUCHES, creditCharged })
    } catch (error) {
      const training = trainingRequiredResponse(error)
      if (training) return training
      if (error instanceof GeminiError) return jsonError('generation_failed', error.status >= 400 ? error.status : 500, error.message)
      console.error('[engine/logo/fond/proposals]', error)
      return jsonError('server_error', 500)
    }
  })

  // ── Étape B — validation d'un fond : déclinaisons automatiques ──────────
  // Composition 100 % locale (zéro appel API, zéro débit) : PNG alpha (le
  // master existe déjà) · carré 1:1 logo+fond (avatar Discord) · bannière
  // 16:9 simple. Stockées au projet (logo_scene).
  .post('/logo/fond/apply', async ({ request }) => {
    try {
      const auth = await requireUser(request)
      if (isResponse(auth)) return auth
      const { user } = auth

      const rate = checkRateLimit(`engine:${user.id}`, RATE_LIMIT_PER_MINUTE)
      if (!rate.ok) return jsonError('rate_limited', 429)

      const body = await request.json().catch(() => null) as {
        projectId?: string
        assetId?: string
        fondUrl?: string
      } | null
      if (!body?.projectId || !body.assetId || typeof body.fondUrl !== 'string') {
        return jsonError('invalid_body', 400)
      }

      const project = await loadOwnedProject(user.id, body.projectId)
      if (!project) return jsonError('project_not_found', 404, 'Projet introuvable.')
      if (!project.logo_master?.url) return jsonError('logo_required', 409, 'Le logo master manque.')
      const asset = await loadOwnedAsset(user.id, body.projectId, body.assetId)
      if (!asset) return jsonError('asset_not_found', 404, 'Création logo introuvable.')

      const [fondRef, logoRef] = await Promise.all([
        fetchAsReference(body.fondUrl),
        fetchAsReference(project.logo_master.url),
      ])
      if (!fondRef || !logoRef) return jsonError('reference_unreachable', 400, 'Fond ou logo master introuvable.')
      const fondPng = Buffer.from(fondRef.data, 'base64')
      const logoPng = Buffer.from(logoRef.data, 'base64')

      const [carrePng, bannierePng] = await Promise.all([
        composeLogoOnFond({ fondPng, logoPng, width: 2048, height: 2048 }),
        composeBanniereLogo({ fondPng, logoPng }),
      ])

      const base = `${user.id}/${body.projectId}/logo`
      const [carreUrl, banniereUrl] = await Promise.all([
        storeBuffer(`${base}/carre-fond.png`, carrePng, 'image/png'),
        storeBuffer(`${base}/banniere-fond.png`, bannierePng, 'image/png'),
      ])

      const service = createServiceClient()
      const logoScene = {
        fondUrl: body.fondUrl,
        carreUrl,
        banniereUrl,
        alphaUrl: project.logo_master.url,
        at: new Date().toISOString(),
      }
      await service.from('projects').update({ logo_scene: logoScene, updated_at: new Date().toISOString() }).eq('id', project.id)
      await service
        .from('project_assets')
        .update({
          exports: [
            ...(asset.exports ?? []),
            { url: carreUrl, resolution: '2048×2048', at: new Date().toISOString() },
            { url: banniereUrl, resolution: '1920×1080', at: new Date().toISOString() },
          ],
          updated_at: new Date().toISOString(),
        })
        .eq('id', asset.id)

      return Response.json({ logoScene })
    } catch (error) {
      if (error instanceof GeminiError) return jsonError('generation_failed', error.status >= 400 ? error.status : 500, error.message)
      console.error('[engine/logo/fond/apply]', error)
      return jsonError('server_error', 500)
    }
  })

  // ── Héro v2 d'une création : scène + titre en UNE génération ────────────
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

      // LOT 0 : le chemin héro refuse aussi de générer sans entraînement.
      requireTraining()

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
      const { da, energie, modernite } = artDirectionForProject(project)
      const category = body.category as Exclude<EngineCategory, 'logo'>
      const compiled = compileHeroPromptV2({ project, category, da, answers, energie, modernite })
      const config = CATEGORY_IMAGE_CONFIG[category]

      // Option pré-câblée : logo master intégré à la génération — il voyage
      // en PREMIÈRE référence (le prompt le désigne ainsi), les références
      // d'entraînement suivent.
      const referenceImages = [...compiled.references]
      if (answers.logoInScene && project.logo_master?.url) {
        const logoRef = await fetchAsReference(project.logo_master.url)
        if (logoRef) referenceImages.unshift(logoRef)
      }

      const generation = await generateWithOcrGate({
        model: ENGINE_MODELS.scene,
        prompt: compiled.prompt,
        referenceImages,
        imageConfig: { aspectRatio: compiled.aspectRatio, imageSize: '1K' },
        expectedTexts: compiled.expectedTexts,
        log: { userId: user.id, projectId: body.projectId, kind: `scene_${category}`, resolution: '1K' },
      })

      const sceneBuffer = Buffer.from(generation.dataUrl.split(',').pop() ?? '', 'base64')
      const meta = await sharp(sceneBuffer).metadata()
      const sceneAspect = meta.width && meta.height ? meta.width / meta.height : config.canvas.width / config.canvas.height

      const { data: asset } = await service
        .from('project_assets')
        .insert({
          project_id: body.projectId,
          user_id: user.id,
          category,
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
      const layers = defaultLayers({ category, sceneUrl, sceneAspect, project })

      const { data: updated } = await service
        .from('project_assets')
        .update({
          layers,
          compiled_prompts: [{ kind: 'hero', prompt: generation.finalPrompt, exemplars: compiled.exemplarSlugs, references: referenceImages.length, ocrRejects: generation.ocrRejects, retried: generation.retried, at: new Date().toISOString() }],
          updated_at: new Date().toISOString(),
        })
        .eq('id', asset.id)
        .select()
        .single()

      await service.from('projects').update({ updated_at: new Date().toISOString() }).eq('id', project.id)

      return Response.json({ asset: updated ?? asset, compiledPrompt: generation.finalPrompt, retried: generation.retried })
    } catch (error) {
      const training = trainingRequiredResponse(error)
      if (training) return training
      if (error instanceof GeminiError) return jsonError('generation_failed', error.status >= 400 ? error.status : 500, error.message)
      console.error('[engine/scene]', error)
      return jsonError('server_error', 500)
    }
  })

  // ── Régénérer le héro (retouche par réponses de wizard) ─────────────────
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

      requireTraining()

      const project = await loadOwnedProject(user.id, body.projectId)
      if (!project) return jsonError('project_not_found', 404, 'Projet introuvable.')
      const asset = await loadOwnedAsset(user.id, body.projectId, body.assetId)
      if (!asset) return jsonError('asset_not_found', 404, 'Création introuvable.')

      const guard = await checkEngineGuards(user.id, 1)
      if (!guard.ok) return jsonError(guard.code, guard.status, guard.message)

      const charge = await chargeRetouch(user.id, asset, `Retouche héro — ${project.name}`)
      if ('error' in charge) return charge.error

      const previousAnswers = parseSceneAnswers(asset.wizard_answers)
      const newAnswers = { ...previousAnswers, ...parseSceneAnswers(body.answers) }
      const category = asset.category as Exclude<EngineCategory, 'logo'>
      const { da, energie, modernite } = artDirectionForProject(project)
      const compiled = compileHeroPromptV2({ project, category, da, answers: newAnswers, energie, modernite })

      const layers = (asset.layers ?? []) as Layer[]
      const sceneLayer = layers.find((l) => l.type === 'scene')

      // keepComposition : SEUL le rendu précédent voyage (le prompt le
      // désigne sans ambiguïté) ; sinon, les références d'entraînement.
      let prompt = compiled.prompt
      let referenceImages: Array<{ data: string; mimeType: string }> = compiled.references
      if (body.keepComposition && sceneLayer?.url) {
        const reference = await fetchAsReference(sceneLayer.url)
        if (reference) {
          referenceImages = [reference]
          prompt = `${compiled.prompt}\n\nKEEP COMPOSITION: the attached reference is the previous render of this exact hero. Keep the same composition, camera, framing, subject placement and title placement — apply only the changes described above, spelling kept perfect.`
        }
      }

      const generation = await generateWithOcrGate({
        model: ENGINE_MODELS.scene,
        prompt,
        referenceImages,
        imageConfig: { aspectRatio: compiled.aspectRatio, imageSize: '1K' },
        expectedTexts: compiled.expectedTexts,
        log: { userId: user.id, projectId: body.projectId, assetId: asset.id, kind: `retouch_${category}`, resolution: '1K' },
      })

      const sceneBuffer = Buffer.from(generation.dataUrl.split(',').pop() ?? '', 'base64')
      const meta = await sharp(sceneBuffer).metadata()
      const sceneUrl = await storeRender(`${user.id}/${body.projectId}/${asset.id}/scene-${Date.now()}.png`, generation.dataUrl)

      const service = createServiceClient()
      // le masque de gomme est lié au rendu précédent : il saute avec lui
      const newLayers = layers.map((layer) =>
        layer.type === 'scene'
          ? { ...layer, url: sceneUrl, maskUrl: undefined, aspect: meta.width && meta.height ? meta.width / meta.height : layer.aspect }
          : layer
      )
      const { data: updated } = await service
        .from('project_assets')
        .update({
          layers: newLayers,
          wizard_answers: newAnswers,
          compiled_prompts: [
            ...(asset.compiled_prompts ?? []),
            { kind: 'retouch', prompt: generation.finalPrompt, keepComposition: Boolean(body.keepComposition), ocrRejects: generation.ocrRejects, retried: generation.retried, at: new Date().toISOString() },
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
      const training = trainingRequiredResponse(error)
      if (training) return training
      if (error instanceof GeminiError) return jsonError('generation_failed', error.status >= 400 ? error.status : 500, error.message)
      console.error('[engine/scene/regenerate]', error)
      return jsonError('server_error', 500)
    }
  })

  // ── Régénérer un calque par instruction courte (run 5.2, LOT 4) ─────────
  // « passe le titre en chrome », « scène de nuit », « retire le personnage
  // de gauche » — 1 retouche du compteur, rendu actuel joint, OCR gate.
  .post('/layer/instruct', async ({ request }) => {
    try {
      const auth = await requireUser(request)
      if (isResponse(auth)) return auth
      const { user } = auth

      const rate = checkRateLimit(`engine:${user.id}`, RATE_LIMIT_PER_MINUTE)
      if (!rate.ok) return jsonError('rate_limited', 429)

      const body = await request.json().catch(() => null) as {
        projectId?: string
        assetId?: string
        instruction?: unknown
      } | null
      const instruction = sanitizeText(body?.instruction, 240)
      if (!body?.projectId || !body.assetId || instruction.length < 3) {
        return jsonError('invalid_body', 400, 'Décris la retouche en quelques mots.')
      }

      requireTraining()

      const project = await loadOwnedProject(user.id, body.projectId)
      if (!project) return jsonError('project_not_found', 404, 'Projet introuvable.')
      const asset = await loadOwnedAsset(user.id, body.projectId, body.assetId)
      if (!asset) return jsonError('asset_not_found', 404, 'Création introuvable.')

      const layers = (asset.layers ?? []) as Layer[]
      const sceneLayer = layers.find((l) => l.type === 'scene' && l.url)
      if (!sceneLayer?.url) return jsonError('no_scene_layer', 400, 'Cette création n’a pas de calque héro à retoucher.')

      const guard = await checkEngineGuards(user.id, 1)
      if (!guard.ok) return jsonError(guard.code, guard.status, guard.message)

      const charge = await chargeRetouch(user.id, asset, `Instruction — ${project.name} : ${instruction.slice(0, 60)}`)
      if ('error' in charge) return charge.error

      const reference = await fetchAsReference(sceneLayer.url)
      if (!reference) return jsonError('reference_unreachable', 400, 'Le rendu actuel est introuvable.')

      const category = asset.category as EngineCategory
      const answers = parseSceneAnswers(asset.wizard_answers)
      const expectedTexts = expectedTextsForAsset(project, category, answers)
      const compiled = compileInstructPrompt({ project, instruction, expectedTexts })

      const generation = await generateWithOcrGate({
        model: ENGINE_MODELS.scene,
        prompt: compiled.prompt,
        referenceImages: [reference],
        imageConfig: { aspectRatio: CATEGORY_IMAGE_CONFIG[category].aspectRatio, imageSize: '1K' },
        expectedTexts: compiled.expectedTexts,
        log: { userId: user.id, projectId: body.projectId, assetId: asset.id, kind: `instruct_${category}`, resolution: '1K' },
      })

      const sceneBuffer = Buffer.from(generation.dataUrl.split(',').pop() ?? '', 'base64')
      const meta = await sharp(sceneBuffer).metadata()
      const sceneUrl = await storeRender(`${user.id}/${body.projectId}/${asset.id}/scene-${Date.now()}.png`, generation.dataUrl)

      const service = createServiceClient()
      const newLayers = layers.map((layer) =>
        layer.type === 'scene'
          ? { ...layer, url: sceneUrl, maskUrl: undefined, aspect: meta.width && meta.height ? meta.width / meta.height : layer.aspect }
          : layer
      )
      const { data: updated } = await service
        .from('project_assets')
        .update({
          layers: newLayers,
          compiled_prompts: [
            ...(asset.compiled_prompts ?? []),
            { kind: 'instruct', prompt: generation.finalPrompt, instruction, ocrRejects: generation.ocrRejects, retried: generation.retried, at: new Date().toISOString() },
          ],
          updated_at: new Date().toISOString(),
        })
        .eq('id', asset.id)
        .select()
        .single()

      securityLog('engine_instruct', { userId: user.id, assetId: asset.id, used: charge.used ?? 0 })

      return Response.json({
        asset: updated,
        retouchesUsed: charge.used,
        includedRetouches: INCLUDED_RETOUCHES,
        creditCharged: charge.creditCharged,
        retried: generation.retried,
      })
    } catch (error) {
      const training = trainingRequiredResponse(error)
      if (training) return training
      if (error instanceof GeminiError) return jsonError('generation_failed', error.status >= 400 ? error.status : 500, error.message)
      console.error('[engine/layer/instruct]', error)
      return jsonError('server_error', 500)
    }
  })

  // ── Masque de gomme non destructive (run 5.2, LOT 4) ────────────────────
  // La gomme de l'éditeur peint un masque alpha côté client ; il est stocké
  // ici (PNG, résolution du rendu 1K) et appliqué au compositing. Aucune
  // génération, aucun débit : effacer est gratuit et réversible.
  .post('/mask', async ({ request }) => {
    try {
      const auth = await requireUser(request)
      if (isResponse(auth)) return auth
      const { user } = auth

      const rate = checkRateLimit(`engine-mask:${user.id}`, 30)
      if (!rate.ok) return jsonError('rate_limited', 429)

      const body = await request.json().catch(() => null) as {
        projectId?: string
        assetId?: string
        layerId?: string
        mask?: string
      } | null
      if (!body?.projectId || !body.assetId || !body.layerId || typeof body.mask !== 'string') {
        return jsonError('invalid_body', 400)
      }
      if (!body.mask.startsWith('data:image/png;base64,') || body.mask.length > 3_000_000) {
        return jsonError('invalid_mask', 400, 'Masque invalide.')
      }

      const asset = await loadOwnedAsset(user.id, body.projectId, body.assetId)
      if (!asset) return jsonError('asset_not_found', 404, 'Création introuvable.')
      const layers = (asset.layers ?? []) as Layer[]
      if (!layers.some((l) => l.id === body.layerId)) {
        return jsonError('layer_not_found', 404, 'Calque introuvable.')
      }

      // Ré-encodage sharp : neutralise tout PNG malicieux et borne la taille
      const raw = Buffer.from(body.mask.split(',').pop() ?? '', 'base64')
      const png = await sharp(raw)
        .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer()

      const url = await storeBuffer(
        `${user.id}/${body.projectId}/${body.assetId}/mask-${body.layerId}-${Date.now()}.png`,
        png,
        'image/png'
      )

      return Response.json({ maskUrl: url })
    } catch (error) {
      console.error('[engine/mask]', error)
      return jsonError('server_error', 500)
    }
  })
