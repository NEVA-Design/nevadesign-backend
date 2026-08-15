import { Elysia } from 'elysia'
import { requireAdmin, isResponse } from '../../lib/require-auth'
import {
  compileHeroPromptV2,
  compileInstructPrompt,
  compileLogoPromptV2,
  compileScenePromptLegacy,
  type CompiledPromptV2,
  type ProjectLike,
} from '../../lib/engine/compiler'
import { resolveArtDirection, type StyleAnswers } from '../../lib/engine/mapping'
import { ENGINE_MODELS, generateWithSoftRetry } from '../../lib/engine/generation'
import { generateWithOcrGate } from '../../lib/engine/ocr-gate'
import { estimateCostEur } from '../../lib/engine/pricing'
import { parseLogoAnswersV3, renderLogoBrief, type LogoAnswersV3 } from '../../lib/engine/logo-brief'
import { directLogoConcepts, type LogoConcept } from '../../lib/engine/logo-director'
import { generateLogoProposition } from '../../lib/engine/logo-pipeline'
import { pickExemplars } from '../../lib/engine/exemplars'
import { UNIVERSE_LABELS } from '../../lib/engine/mapping'
import { GeminiError } from '../../lib/ai/gemini'
import { getTrainingStatus, TrainingRequiredError } from '../../lib/engine/adn'

// ── /admin/test-moteur (run 5.2 LOT 5 → run 5.3 LOT 4) ───────────────────────
// La page de test à boutons : chaque cas affiche son brief et ses prompts
// AVANT tout lancement (GET /cases = compilation pure, zéro appel API), et
// c'est LE CLIENT qui déclenche chaque génération (POST /run). Aucun débit
// de crédits — coût réel affiché par étage, loggé en kind admin_test_*.
// Run 5.3 : cas logo v3 en DEUX temps — « Écrire les 3 concepts » (étage 1,
// les prompts du DA s'affichent dépliables) puis « Générer les 3
// propositions » (étages 2+3). Compteurs de session : rejets OCR, échecs de
// concept, coût cumulé.

// SEULE exception au « zéro logo sur flash » : la variante A/B « ancien
// chemin » ci-dessous, qui documente précisément ce qu'on a quitté.
// Aucune route produit n'y touche.
const LEGACY_FLASH_LOGO_AB = 'gemini-3.1-flash-image'

const REDSIDE_ANSWERS: StyleAnswers = { universe: 'cartel', energie: 85, modernite: 60, couleur: '#E63946' }
const ETE_ANSWERS: StyleAnswers = { universe: 'ete_plage', energie: 25, modernite: 70, couleur: '#118AB2' }
const FRUITZ_ANSWERS: StyleAnswers = { universe: 'ete_plage', energie: 45, modernite: 75, couleur: '#FF6B4A' }

const REDSIDE: ProjectLike = {
  name: 'REDSIDE',
  sector: 'fivem',
  ambiance: { styleAnswers: REDSIDE_ANSWERS },
  palette: [],
}
const VESPUCCI: ProjectLike = {
  name: 'Vespucci Life',
  sector: 'fivem',
  ambiance: { styleAnswers: ETE_ANSWERS },
  palette: [],
}
const L6RYS: ProjectLike = {
  name: 'L6RYS',
  sector: 'fivem',
  ambiance: { styleAnswers: { universe: 'rp_urbain', energie: 60, modernite: 80, couleur: '#00D2FF' } },
  palette: [],
}
const FRUITZ: ProjectLike = {
  name: 'Fruitz',
  sector: 'fivem',
  ambiance: { styleAnswers: FRUITZ_ANSWERS },
  palette: [],
}
const AZURE: ProjectLike = {
  name: 'Azure Bay',
  sector: 'fivem',
  ambiance: { styleAnswers: ETE_ANSWERS },
  palette: [],
}

// Briefs v3 des cas logo — exactement ce que le wizard v3 transmettrait.
const FRUITZ_BRIEF: LogoAnswersV3 = parseLogoAnswersV3({
  type: 'nom',
  sujet: 'fruit, été, juteux',
  ambiance: 'ete',
  couleurs: { mode: 'degrade', couleurs: ['#FF6B4A', '#FFC4A3'], angle: 45 },
  fond: 'degrade_motifs',
})!
const DAUPHIN_BRIEF: LogoAnswersV3 = parseLogoAnswersV3({
  type: 'nom',
  sujet: 'dauphin, océan',
  ambiance: 'ete',
  couleurs: { mode: 'degrade', couleurs: ['#118AB2', '#06D6A0'], angle: 90 },
  fond: 'degrade_motifs',
})!

const REDSIDE_SCENE = {
  lieu: 'rain-slick downtown Los Santos intersection at night',
  personnages: 'two rival crew figures facing away from each other',
  baseline: 'ROLEPLAY',
}

type Variant = {
  id: string
  label: string
  // v1 = legacy (A/B) · v2 = run 5.2 · instruct = édition ·
  // logo_v3_concepts = étage 1 seul · logo_v3_generation = étages 2+3
  pipeline: 'v1' | 'v2' | 'instruct' | 'logo_v3_concepts' | 'logo_v3_generation'
  kind: 'logo' | 'hero'
  model: string
  count: number
  prompt: string
  referencesJointes: number
  ocrAttendus: string[]
  aspectRatio: string
}

type TestCase = {
  id: string
  titre: string
  attendu: string
  brief?: string
  variants: Variant[]
}

function v2Variant(id: string, label: string, kind: 'logo' | 'hero', compiled: CompiledPromptV2, model: string, count = 1): Variant {
  return {
    id,
    label,
    pipeline: 'v2',
    kind,
    model,
    count,
    prompt: compiled.prompt,
    referencesJointes: compiled.references.length,
    ocrAttendus: compiled.expectedTexts,
    aspectRatio: compiled.aspectRatio,
  }
}

function logoV3Case(opts: {
  id: string
  titre: string
  attendu: string
  project: ProjectLike
  brief: LogoAnswersV3
  generationLabel: string
}): TestCase {
  const { da } = daFor(opts.project)
  const briefText = renderLogoBrief({
    projectName: opts.project.name,
    answers: opts.brief,
    mappingPalette: da.palette,
    universeLabel: UNIVERSE_LABELS[da.universe],
  })
  return {
    id: opts.id,
    titre: opts.titre,
    attendu: opts.attendu,
    brief: briefText,
    variants: [
      {
        id: 'concepts',
        label: 'Étage 1 — écrire les 3 concepts (DA, thinking high)',
        pipeline: 'logo_v3_concepts',
        kind: 'logo',
        model: ENGINE_MODELS.logoDirector,
        count: 1,
        prompt: briefText,
        referencesJointes: 0,
        ocrAttendus: [],
        aspectRatio: '1:1',
      },
      {
        id: 'generation',
        label: opts.generationLabel,
        pipeline: 'logo_v3_generation',
        kind: 'logo',
        model: ENGINE_MODELS.logoImage,
        count: 3,
        prompt: '(les 3 prompts viennent de l’étage 1 — lancer « concepts » d’abord)',
        referencesJointes: 0,
        ocrAttendus: opts.brief.type === 'nom' ? [opts.project.name.toUpperCase()] : [],
        aspectRatio: '1:1',
      },
    ],
  }
}

function daFor(project: ProjectLike) {
  const answers = project.ambiance.styleAnswers as StyleAnswers
  return { da: resolveArtDirection(answers, project.name), energie: answers.energie, modernite: answers.modernite }
}

// Compilation pure des cas — rejouée à chaque GET (et au POST, pour que le
// prompt exécuté soit exactement celui affiché).
function buildCases(): TestCase[] {
  const daRedside = resolveArtDirection(REDSIDE_ANSWERS, REDSIDE.name)
  const daEte = resolveArtDirection(ETE_ANSWERS, VESPUCCI.name)
  const daL6rys = resolveArtDirection({ universe: 'rp_urbain', energie: 60, modernite: 80, couleur: '#00D2FF' }, L6RYS.name)
  const daFruitz = resolveArtDirection(FRUITZ_ANSWERS, FRUITZ.name)

  // A/B flash sans DA (ancien, run 5.2) vs pro+DA (nouveau) — MÊME brief
  const fruitzOldPath = compileLogoPromptV2({ project: FRUITZ, da: daFruitz, answers: { type: 'nom' }, energie: 45, modernite: 75 })

  // Cas héro conservés du run 5.2
  const banV1 = compileScenePromptLegacy({ project: REDSIDE, category: 'banniere_discord', answers: REDSIDE_SCENE })
  const banV2 = compileHeroPromptV2({ project: REDSIDE, category: 'banniere_discord', da: daRedside, answers: REDSIDE_SCENE, energie: 85, modernite: 60 })
  const l6Hero = compileHeroPromptV2({
    project: L6RYS,
    category: 'banniere_discord',
    da: daL6rys,
    answers: { lieu: 'neon-lit underground parking garage' },
    energie: 60,
    modernite: 80,
  })
  const mapEte = compileHeroPromptV2({
    project: VESPUCCI,
    category: 'banniere_discord',
    da: daEte,
    answers: { templateId: 'fivem-beach-cabana-wideangle' },
    energie: 25,
    modernite: 70,
  })
  const instruct = compileInstructPrompt({
    project: REDSIDE,
    instruction: 'passe le titre en chrome poli, reflets durs',
    expectedTexts: ['REDSIDE', 'ROLEPLAY'],
  })

  return [
    logoV3Case({
      id: 'fruitz_reel',
      titre: 'Cas Fruitz réel — le brief complet du wizard v3',
      attendu:
        'Sujet « fruit, été, juteux », dégradé corail→pêche (#FF6B4A→#FFC4A3, 45°), fond dégradé + doodles. Étage 1 : 3 concepts DISTINCTS affichés AVANT toute image (dépliables). Étage 2+3 : pro image 2K thinking + OCR + contrôle de concept. Plus jamais une boussole pour un projet fruit.',
      project: FRUITZ,
      brief: FRUITZ_BRIEF,
      generationLabel: 'Étages 2+3 — générer les 3 propositions (pro 2K + relecture)',
    }),
    {
      id: 'ab_flash_da',
      titre: 'A/B — flash sans DA (ancien) vs pro+DA (nouveau), même brief Fruitz',
      attendu:
        'Ancien (run 5.2) : flash 1K, prompt compilé sans sujet, ~2 s sans réflexion. Nouveau : le concept 1 du DA exécuté par le pro 2K avec thinking + relecture. Le nouveau chemin doit montrer le thème fruit et le dégradé — l’ancien montre ce qui ne va plus.',
      variants: [
        {
          id: 'ancien',
          label: 'Ancien chemin — flash sans DA (run 5.2)',
          pipeline: 'v1',
          kind: 'logo',
          model: LEGACY_FLASH_LOGO_AB,
          count: 1,
          prompt: fruitzOldPath.prompt,
          referencesJointes: 0,
          ocrAttendus: fruitzOldPath.expectedTexts,
          aspectRatio: '1:1',
        },
        {
          id: 'nouveau',
          label: 'Nouveau chemin — concept 1 du DA sur pro 2K (lancer d’abord l’étage 1 du cas Fruitz)',
          pipeline: 'logo_v3_generation',
          kind: 'logo',
          model: ENGINE_MODELS.logoImage,
          count: 1,
          prompt: '(le prompt = concept 1 de l’étage 1 du cas Fruitz)',
          referencesJointes: 0,
          ocrAttendus: ['FRUITZ'],
          aspectRatio: '1:1',
        },
      ],
    },
    logoV3Case({
      id: 'theme_animal',
      titre: 'Thème animal — « dauphin, océan » pour Azure Bay',
      attendu:
        'Attendu : une construction type ALYA — lettrage épousant/fusionnant la silhouette du dauphin, fond dégradé océan + doodles marins — PAS un blason esport générique. Le thème est transmis, le DA ne peut plus l’inventer.',
      project: AZURE,
      brief: DAUPHIN_BRIEF,
      generationLabel: 'Étages 2+3 — générer les 3 propositions (pro 2K + relecture)',
    }),
    {
      id: 'ab_banniere',
      titre: 'A/B bannière « REDSIDE » — ancien vs v2',
      attendu: 'v1 : scène sans texte (le titre était un calque système plat). v2 : titre REDSIDE généré DANS l’image, lettres partiellement derrière les sujets, baseline ROLEPLAY.',
      variants: [
        { id: 'v1', label: 'Ancien chemin (scène no-text)', pipeline: 'v1', kind: 'hero', model: ENGINE_MODELS.scene, count: 1, prompt: banV1.prompt, referencesJointes: 0, ocrAttendus: [], aspectRatio: banV1.aspectRatio },
        v2Variant('v2', 'Héro v2 (titre dans l’image)', 'hero', banV2, ENGINE_MODELS.scene),
      ],
    },
    {
      id: 'orthographe',
      titre: 'Orthographe piège — bannière « L6RYS » ×3',
      attendu: 'Trois bannières : zéro faute affichée, l’OCR gate rejette et régénère en silence (max 2 par slot). L’orthographe logo se vérifie désormais sur les cas Fruitz / dauphin (wordmarks, même OCR gate).',
      variants: [
        v2Variant('banniere', 'Bannière L6RYS ×3', 'hero', l6Hero, ENGINE_MODELS.scene, 3),
      ],
    },
    {
      id: 'mapping',
      titre: 'Le mapping — Cartel+Agressif+Rouge vs Été+Élégant+Teal',
      attendu: 'Deux directions nettement distinctes : lettrage condensé agressif chrome sombre étalonné rouge/noir, contre typo dégradé sunset lumière solaire cluster été.',
      variants: [
        v2Variant('cartel', 'REDSIDE — Cartel + Agressif + Rouge', 'hero', banV2, ENGINE_MODELS.scene),
        v2Variant('ete', 'Vespucci Life — Été + Élégant + Teal', 'hero', mapEte, ENGINE_MODELS.scene),
      ],
    },
    {
      id: 'gomme_instruction',
      titre: 'Gomme + instruction — « passe le titre en chrome »',
      attendu: 'L’instruction rejoue le dernier rendu v2 du cas bannière (à lancer d’abord) avec le changement demandé, épellation re-forcée + OCR. La gomme non destructive se teste dans l’éditeur.',
      variants: [
        {
          id: 'chrome',
          label: 'Instruction sur le rendu du cas bannière (v2)',
          pipeline: 'instruct',
          kind: 'hero',
          model: ENGINE_MODELS.scene,
          count: 1,
          prompt: instruct.prompt,
          referencesJointes: 1,
          ocrAttendus: instruct.expectedTexts,
          aspectRatio: '16:9',
        },
      ],
    },
  ]
}

// ── État de session (mémoire process — suffisant pour la page de test) ──────
const lastRenders = new Map<string, string>()
// concepts du DA par cas logo v3 — la génération rejoue EXACTEMENT ces prompts
const conceptsByCase = new Map<string, { concepts: LogoConcept[]; daEur: number }>()
// Les compteurs demandés au LOT 4 : rejets OCR, échecs de concept, coût cumulé
const compteurs = {
  generations: 0,
  ocrRejets: 0,
  echecsConcept: 0,
  regenerationsCiblees: 0,
  coutCumuleEur: 0,
}

function addCost(eur: number) {
  compteurs.coutCumuleEur = Math.round((compteurs.coutCumuleEur + eur) * 10000) / 10000
}

const CASE_PROJECTS: Record<string, { project: ProjectLike; brief: LogoAnswersV3 }> = {
  fruitz_reel: { project: FRUITZ, brief: FRUITZ_BRIEF },
  ab_flash_da: { project: FRUITZ, brief: FRUITZ_BRIEF },
  theme_animal: { project: AZURE, brief: DAUPHIN_BRIEF },
}

export const adminTestEngineRoutes = new Elysia({ prefix: '/admin/test-moteur' })
  // Compilation pure — AUCUN appel API : briefs et prompts s'affichent avant tout.
  // LOT 0 (run 5.4) : le badge d'état d'entraînement part TOUJOURS dans la
  // réponse ; sans entraînement v4, les cas sont renvoyés grisés (bloque:true).
  .get('/cases', async ({ request }) => {
    const guard = await requireAdmin(request)
    if (isResponse(guard)) return guard
    const entrainement = getTrainingStatus()
    let cases: TestCase[] = []
    try {
      cases = buildCases()
    } catch (error) {
      if (!(error instanceof TrainingRequiredError)) throw error
      // aucun exemplar installé : la compilation few-shot est impossible —
      // la page affiche les cas grisés avec le message d'entraînement requis
    }
    return Response.json({
      cases,
      entrainement,
      bloque: !entrainement.installed,
      messageBlocage: entrainement.installed ? null : 'Entraînement requis — lance `bun run scripts/train-fivem-v4.ts`',
      pretRendus: [...lastRenders.keys()],
      conceptsPrets: [...conceptsByCase.keys()],
      compteurs,
    })
  })

  // Compteurs seuls (rafraîchissement léger côté page)
  .get('/compteurs', async ({ request }) => {
    const guard = await requireAdmin(request)
    if (isResponse(guard)) return guard
    return Response.json({ compteurs })
  })

  // Lancement d'UNE variante — à l'initiative du client, coût réel renvoyé
  .post('/run', async ({ request }) => {
    const guard = await requireAdmin(request)
    if (isResponse(guard)) return guard
    const adminUserId = guard.auth.user.id

    // LOT 0 : aucun lancement possible tant que l'entraînement v4 manque.
    const entrainement = getTrainingStatus()
    if (!entrainement.installed) {
      return Response.json(
        { error: `Entraînement requis — lance \`bun run scripts/train-fivem-v4.ts\` (${entrainement.manques.join(' ; ')})` },
        { status: 409 }
      )
    }

    const body = await request.json().catch(() => null) as { caseId?: string; variantId?: string } | null
    const testCase = buildCases().find((c) => c.id === body?.caseId)
    const variant = testCase?.variants.find((v) => v.id === body?.variantId)
    if (!testCase || !variant) return Response.json({ error: 'Cas de test inconnu.' }, { status: 400 })

    const startedAt = Date.now()

    try {
      // ── Étage 1 seul : le DA écrit les 3 concepts, aucune image ──────────
      if (variant.pipeline === 'logo_v3_concepts') {
        const ctx = CASE_PROJECTS[testCase.id]
        if (!ctx) return Response.json({ error: 'Cas logo v3 sans projet câblé.' }, { status: 400 })
        const { da, energie, modernite } = daFor(ctx.project)
        const direction = await directLogoConcepts({
          project: ctx.project,
          da,
          answers: ctx.brief,
          energie,
          modernite,
          log: { userId: adminUserId },
        })
        const daEur = estimateCostEur({
          model: ENGINE_MODELS.logoDirector,
          tokensIn: direction.usage.tokensIn,
          tokensOut: direction.usage.tokensOut,
        })
        conceptsByCase.set(testCase.id, { concepts: direction.concepts, daEur })
        // le brief Fruitz nourrit aussi l'A/B (variante « nouveau »)
        if (testCase.id === 'fruitz_reel') conceptsByCase.set('ab_flash_da', { concepts: direction.concepts, daEur })
        addCost(daEur)
        return Response.json({
          caseId: testCase.id,
          variantId: variant.id,
          concepts: direction.concepts,
          coutParEtage: { daEur, generationEur: 0, relectureEur: 0, totalEur: daEur },
          dureeMs: Date.now() - startedAt,
          compteurs,
        })
      }

      // ── Étages 2+3 : générer les propositions depuis les concepts ────────
      if (variant.pipeline === 'logo_v3_generation') {
        const ctx = CASE_PROJECTS[testCase.id]
        const stored = conceptsByCase.get(testCase.id)
        if (!ctx || !stored) {
          return Response.json({ error: 'Lance d’abord l’étage 1 (les 3 concepts du DA) — la génération exécute exactement ces prompts.' }, { status: 409 })
        }
        const { da, energie, modernite } = daFor(ctx.project)
        const exemplars = pickExemplars({ category: 'logo', da, energie, modernite, maxPrompts: 0, maxReferences: 3 })
        const concepts = stored.concepts.slice(0, variant.count)

        const propositions = []
        let generationEur = 0
        let relectureEur = 0
        for (const [i, concept] of concepts.entries()) {
          const prop = await generateLogoProposition({
            projectName: ctx.project.name,
            answers: ctx.brief,
            concept,
            references: exemplars.references,
            resolution: '2K',
            log: { userId: adminUserId, kind: `admin_test_${testCase.id}_${variant.id}_${i + 1}` },
          })
          propositions.push({
            dataUrl: prop.dataUrl,
            concept: prop.concept,
            ocrRejects: prop.ocrRejects,
            conceptOk: prop.conceptOk,
            defauts: prop.defauts,
            regenere: prop.regenere,
          })
          generationEur += prop.cout.generationEur
          relectureEur += prop.cout.relectureEur
          compteurs.generations += 1
          compteurs.ocrRejets += prop.ocrRejects
          if (!prop.conceptOk) compteurs.echecsConcept += 1
          if (prop.regenere) compteurs.regenerationsCiblees += 1
        }
        addCost(generationEur + relectureEur)

        const last = propositions[propositions.length - 1]
        if (last) lastRenders.set(`${testCase.id}:${variant.id}`, last.dataUrl)

        return Response.json({
          caseId: testCase.id,
          variantId: variant.id,
          propositions,
          coutParEtage: {
            daEur: stored.daEur,
            generationEur: Math.round(generationEur * 10000) / 10000,
            relectureEur: Math.round(relectureEur * 10000) / 10000,
            totalEur: Math.round((stored.daEur + generationEur + relectureEur) * 10000) / 10000,
          },
          dureeMs: Date.now() - startedAt,
          compteurs,
        })
      }

      // ── Chemins v1 / v2 / instruct (run 5.2, conservés) ──────────────────
      const referenceImages: Array<{ data: string; mimeType: string }> = []
      if (variant.pipeline === 'instruct') {
        const source = lastRenders.get('ab_banniere:v2')
        if (!source) {
          return Response.json({ error: 'Lance d’abord le cas bannière (v2) : l’instruction retouche son rendu.' }, { status: 409 })
        }
        referenceImages.push({ data: source.split(',').pop() ?? '', mimeType: 'image/png' })
      } else if (variant.pipeline === 'v2') {
        referenceImages.push(...collectReferences(testCase.id, variant.id))
      }

      const results: Array<{ dataUrl: string; ocrRejects: number; retried: boolean }> = []
      let tokensIn = 0
      let tokensOut = 0
      let imagesOut = 0

      for (let i = 0; i < variant.count; i += 1) {
        if (variant.pipeline === 'v1') {
          const result = await generateWithSoftRetry({
            model: variant.model,
            prompt: variant.prompt,
            imageConfig: { aspectRatio: variant.aspectRatio, imageSize: '1K' },
            log: { userId: adminUserId, kind: `admin_test_${testCase.id}_${variant.id}`, resolution: '1K' },
          })
          results.push({ dataUrl: result.dataUrl, ocrRejects: 0, retried: result.retried })
          tokensIn += result.usage.tokensIn
          tokensOut += result.usage.tokensOut
          imagesOut += 1
        } else {
          const result = await generateWithOcrGate({
            model: variant.model,
            prompt: variant.prompt,
            referenceImages,
            imageConfig: { aspectRatio: variant.aspectRatio, imageSize: '1K' },
            expectedTexts: variant.ocrAttendus,
            log: { userId: adminUserId, kind: `admin_test_${testCase.id}_${variant.id}`, resolution: '1K' },
          })
          results.push({ dataUrl: result.dataUrl, ocrRejects: result.ocrRejects, retried: result.retried })
          tokensIn += result.usage.tokensIn
          tokensOut += result.usage.tokensOut
          // les rejets OCR sont des images générées puis écartées : payées
          imagesOut += 1 + result.ocrRejects
          compteurs.ocrRejets += result.ocrRejects
        }
        compteurs.generations += 1
      }

      const last = results[results.length - 1]
      if (last) lastRenders.set(`${testCase.id}:${variant.id}`, last.dataUrl)

      const coutEur = estimateCostEur({
        model: variant.model,
        tokensIn,
        tokensOut,
        imagesOut,
        resolution: '1K',
      })
      addCost(coutEur)

      return Response.json({
        caseId: testCase.id,
        variantId: variant.id,
        promptExecute: variant.prompt,
        resultats: results,
        coutEur,
        dureeMs: Date.now() - startedAt,
        compteurs,
      })
    } catch (error) {
      if (error instanceof GeminiError) {
        return Response.json({ error: error.message }, { status: error.status >= 400 ? error.status : 500 })
      }
      console.error('[admin/test-moteur]', error)
      return Response.json({ error: (error as Error).message || 'Génération échouée.' }, { status: 500 })
    }
  })

// Références d'entraînement des variantes v2 héro — recompilées comme au GET.
function collectReferences(caseId: string, variantId: string): Array<{ data: string; mimeType: string }> {
  const daRedside = resolveArtDirection(REDSIDE_ANSWERS, REDSIDE.name)
  const daEte = resolveArtDirection(ETE_ANSWERS, VESPUCCI.name)
  const daL6rys = resolveArtDirection({ universe: 'rp_urbain', energie: 60, modernite: 80, couleur: '#00D2FF' }, L6RYS.name)

  if ((caseId === 'ab_banniere' || caseId === 'mapping') && (variantId === 'v2' || variantId === 'cartel')) {
    return compileHeroPromptV2({ project: REDSIDE, category: 'banniere_discord', da: daRedside, answers: REDSIDE_SCENE, energie: 85, modernite: 60 }).references
  }
  if (caseId === 'mapping' && variantId === 'ete') {
    return compileHeroPromptV2({ project: VESPUCCI, category: 'banniere_discord', da: daEte, answers: { templateId: 'fivem-beach-cabana-wideangle' }, energie: 25, modernite: 70 }).references
  }
  if (caseId === 'orthographe' && variantId === 'banniere') {
    return compileHeroPromptV2({ project: L6RYS, category: 'banniere_discord', da: daL6rys, answers: { lieu: 'neon-lit underground parking garage' }, energie: 60, modernite: 80 }).references
  }
  return []
}
