import { Elysia } from 'elysia'
import { requireAdmin, isResponse } from '../../lib/require-auth'
import {
  compileHeroPromptV2,
  compileInstructPrompt,
  compileLogoPromptLegacy,
  compileLogoPromptV2,
  compileScenePromptLegacy,
  type CompiledPromptV2,
  type ProjectLike,
} from '../../lib/engine/compiler'
import { resolveArtDirection, type StyleAnswers } from '../../lib/engine/mapping'
import { ENGINE_MODELS, generateWithSoftRetry } from '../../lib/engine/generation'
import { generateWithOcrGate } from '../../lib/engine/ocr-gate'
import { estimateCostEur } from '../../lib/engine/pricing'
import { GeminiError } from '../../lib/ai/gemini'

// ── /admin/test-moteur (run 5.2, LOT 5) ──────────────────────────────────────
// La page de test à boutons : chaque cas affiche son prompt compilé AVANT
// tout lancement (GET /cases = compilation pure, zéro appel API), et c'est
// LE CLIENT qui déclenche chaque génération (POST /run). Aucun débit de
// crédits — coût réel affiché, loggé en kind admin_test_*.

const REDSIDE_ANSWERS: StyleAnswers = { universe: 'cartel', energie: 85, modernite: 60, couleur: '#E63946' }
const ETE_ANSWERS: StyleAnswers = { universe: 'ete_plage', energie: 25, modernite: 70, couleur: '#118AB2' }

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

const REDSIDE_SCENE = {
  lieu: 'rain-slick downtown Los Santos intersection at night',
  personnages: 'two rival crew figures facing away from each other',
  baseline: 'ROLEPLAY',
}

type Variant = {
  id: string
  label: string
  // 'v1' = pipeline legacy (A/B), 'v2' = pipeline run 5.2, 'instruct' = édition
  pipeline: 'v1' | 'v2' | 'instruct'
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

// Compilation pure des 5 cas — rejouée à chaque GET (et au POST, pour que le
// prompt exécuté soit exactement celui affiché).
function buildCases(): TestCase[] {
  const daRedside = resolveArtDirection(REDSIDE_ANSWERS, REDSIDE.name)
  const daEte = resolveArtDirection(ETE_ANSWERS, VESPUCCI.name)
  const daL6rys = resolveArtDirection({ universe: 'rp_urbain', energie: 60, modernite: 80, couleur: '#00D2FF' }, L6RYS.name)

  // 1. A/B logo — mêmes réponses de wizard (nom complet), ancien chemin vs v2
  const logoV1 = compileLogoPromptLegacy({
    project: REDSIDE,
    answers: { type: 'nom', style: 'chrome', palette: ['#E63946', '#D4A017', '#0F0F0F'] },
  })
  const logoV2 = compileLogoPromptV2({ project: REDSIDE, da: daRedside, answers: { type: 'nom' }, energie: 85, modernite: 60 })

  // 2. A/B bannière « REDSIDE » — entrelacement titre/sujets attendu en v2
  const banV1 = compileScenePromptLegacy({ project: REDSIDE, category: 'banniere_discord', answers: REDSIDE_SCENE })
  const banV2 = compileHeroPromptV2({ project: REDSIDE, category: 'banniere_discord', da: daRedside, answers: REDSIDE_SCENE, energie: 85, modernite: 60 })

  // 3. Orthographe piège « L6RYS » ×3 — zéro faute affichée attendue
  const l6Logo = compileLogoPromptV2({ project: L6RYS, da: daL6rys, answers: { type: 'nom' }, energie: 60, modernite: 80 })
  const l6Hero = compileHeroPromptV2({
    project: L6RYS,
    category: 'banniere_discord',
    da: daL6rys,
    answers: { lieu: 'neon-lit underground parking garage' },
    energie: 60,
    modernite: 80,
  })

  // 4. Le mapping : deux directions nettement distinctes attendues
  const mapCartel = banV2
  const mapEte = compileHeroPromptV2({
    project: VESPUCCI,
    category: 'banniere_discord',
    da: daEte,
    answers: { templateId: 'fivem-beach-cabana-wideangle' },
    energie: 25,
    modernite: 70,
  })

  // 5. Instruction courte sur le dernier rendu v2 de ce cas ou du cas 2
  const instruct = compileInstructPrompt({
    project: REDSIDE,
    instruction: 'passe le titre en chrome poli, reflets durs',
    expectedTexts: ['REDSIDE', 'ROLEPLAY'],
  })

  return [
    {
      id: 'ab_logo',
      titre: 'A/B logo — ancien chemin vs v2',
      attendu: 'Mêmes réponses de wizard (nom complet). v1 : guide JSON brut, aucune référence jointe, « never render this name » dans le prompt. v2 : recette few-shot, références jointes, épellation forcée, OCR gate.',
      variants: [
        { id: 'v1', label: 'Ancien chemin (run 5)', pipeline: 'v1', kind: 'logo', model: ENGINE_MODELS.proposal, count: 1, prompt: logoV1.prompt, referencesJointes: 0, ocrAttendus: [], aspectRatio: '1:1' },
        v2Variant('v2', 'Chemin v2 (run 5.2)', 'logo', logoV2, ENGINE_MODELS.proposal),
      ],
    },
    {
      id: 'ab_banniere',
      titre: 'A/B bannière « REDSIDE » — ancien vs v2',
      attendu: 'v1 : scène sans texte (le titre était un calque système plat). v2 : titre REDSIDE généré DANS l’image, lettres partiellement derrière les sujets, baseline ROLEPLAY — le cas qui a déclenché le run 5.2.',
      variants: [
        { id: 'v1', label: 'Ancien chemin (scène no-text)', pipeline: 'v1', kind: 'hero', model: ENGINE_MODELS.scene, count: 1, prompt: banV1.prompt, referencesJointes: 0, ocrAttendus: [], aspectRatio: banV1.aspectRatio },
        v2Variant('v2', 'Héro v2 (titre dans l’image)', 'hero', banV2, ENGINE_MODELS.scene),
      ],
    },
    {
      id: 'orthographe',
      titre: 'Orthographe piège — « L6RYS » ×3',
      attendu: 'Trois propositions en logo et en bannière : zéro faute affichée. L’OCR gate rejette et régénère en silence (max 2 par slot) — les rejets sont comptés ci-dessous.',
      variants: [
        v2Variant('logo', 'Logo L6RYS ×3', 'logo', l6Logo, ENGINE_MODELS.proposal, 3),
        v2Variant('banniere', 'Bannière L6RYS ×3', 'hero', l6Hero, ENGINE_MODELS.scene, 3),
      ],
    },
    {
      id: 'mapping',
      titre: 'Le mapping — Cartel+Agressif+Rouge vs Été+Élégant+Teal',
      attendu: 'Deux directions nettement distinctes : lettrage condensé agressif chrome sombre étalonné rouge/noir, contre typo dégradé sunset lumière solaire cluster été.',
      variants: [
        v2Variant('cartel', 'REDSIDE — Cartel + Agressif + Rouge', 'hero', mapCartel, ENGINE_MODELS.scene),
        v2Variant('ete', 'Vespucci Life — Été + Élégant + Teal', 'hero', mapEte, ENGINE_MODELS.scene),
      ],
    },
    {
      id: 'gomme_instruction',
      titre: 'Gomme + instruction — « passe le titre en chrome »',
      attendu: 'L’instruction rejoue le dernier rendu v2 du cas 2 (à lancer d’abord) avec le changement demandé, épellation re-forcée + OCR. La gomme non destructive se teste dans l’éditeur sur n’importe quelle création (masque, taille 10-200 px, dureté, undo/redo).',
      variants: [
        {
          id: 'chrome',
          label: 'Instruction sur le rendu du cas 2 (v2)',
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

// Derniers rendus par cas/variante — mémoire process, suffisant pour la page
// de test (le cas 5 rejoue le rendu du cas 2 v2).
const lastRenders = new Map<string, string>()

export const adminTestEngineRoutes = new Elysia({ prefix: '/admin/test-moteur' })
  // Compilation pure — AUCUN appel API : les prompts s'affichent avant tout
  .get('/cases', async ({ request }) => {
    const guard = await requireAdmin(request)
    if (isResponse(guard)) return guard
    return Response.json({ cases: buildCases(), pretRendus: [...lastRenders.keys()] })
  })

  // Lancement d'UNE variante — à l'initiative du client, coût réel renvoyé
  .post('/run', async ({ request }) => {
    const guard = await requireAdmin(request)
    if (isResponse(guard)) return guard
    const adminUserId = guard.auth.user.id

    const body = await request.json().catch(() => null) as { caseId?: string; variantId?: string } | null
    const testCase = buildCases().find((c) => c.id === body?.caseId)
    const variant = testCase?.variants.find((v) => v.id === body?.variantId)
    if (!testCase || !variant) return Response.json({ error: 'Cas de test inconnu.' }, { status: 400 })

    const referenceImages: Array<{ data: string; mimeType: string }> = []
    if (variant.pipeline === 'instruct') {
      const source = lastRenders.get('ab_banniere:v2')
      if (!source) {
        return Response.json({ error: 'Lance d’abord le cas 2 (bannière v2) : l’instruction retouche son rendu.' }, { status: 409 })
      }
      referenceImages.push({ data: source.split(',').pop() ?? '', mimeType: 'image/png' })
    } else if (variant.pipeline === 'v2') {
      // recompile pour récupérer les références jointes (le prompt affiché
      // au GET est recompilé à l'identique — même code, mêmes entrées)
      const again = buildCases().find((c) => c.id === testCase.id)?.variants.find((v) => v.id === variant.id)
      if (again) variant.prompt = again.prompt
      const compiledRefs = collectReferences(testCase.id, variant.id)
      referenceImages.push(...compiledRefs)
    }

    const startedAt = Date.now()
    const results: Array<{ dataUrl: string; ocrRejects: number; retried: boolean }> = []
    let tokensIn = 0
    let tokensOut = 0
    let imagesOut = 0

    try {
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
        }
      }
    } catch (error) {
      if (error instanceof GeminiError) {
        return Response.json({ error: error.message }, { status: error.status >= 400 ? error.status : 500 })
      }
      console.error('[admin/test-moteur]', error)
      return Response.json({ error: 'Génération échouée.' }, { status: 500 })
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

    return Response.json({
      caseId: testCase.id,
      variantId: variant.id,
      promptExecute: variant.prompt,
      resultats: results,
      coutEur,
      dureeMs: Date.now() - startedAt,
    })
  })

// Références d'entraînement de la variante — recompilées comme au GET.
function collectReferences(caseId: string, variantId: string): Array<{ data: string; mimeType: string }> {
  const daRedside = resolveArtDirection(REDSIDE_ANSWERS, REDSIDE.name)
  const daEte = resolveArtDirection(ETE_ANSWERS, VESPUCCI.name)
  const daL6rys = resolveArtDirection({ universe: 'rp_urbain', energie: 60, modernite: 80, couleur: '#00D2FF' }, L6RYS.name)

  if (caseId === 'ab_logo' && variantId === 'v2') {
    return compileLogoPromptV2({ project: REDSIDE, da: daRedside, answers: { type: 'nom' }, energie: 85, modernite: 60 }).references
  }
  if ((caseId === 'ab_banniere' || caseId === 'mapping') && (variantId === 'v2' || variantId === 'cartel')) {
    return compileHeroPromptV2({ project: REDSIDE, category: 'banniere_discord', da: daRedside, answers: REDSIDE_SCENE, energie: 85, modernite: 60 }).references
  }
  if (caseId === 'mapping' && variantId === 'ete') {
    return compileHeroPromptV2({ project: VESPUCCI, category: 'banniere_discord', da: daEte, answers: { templateId: 'fivem-beach-cabana-wideangle' }, energie: 25, modernite: 70 }).references
  }
  if (caseId === 'orthographe' && variantId === 'logo') {
    return compileLogoPromptV2({ project: L6RYS, da: daL6rys, answers: { type: 'nom' }, energie: 60, modernite: 80 }).references
  }
  if (caseId === 'orthographe' && variantId === 'banniere') {
    return compileHeroPromptV2({ project: L6RYS, category: 'banniere_discord', da: daL6rys, answers: { lieu: 'neon-lit underground parking garage' }, energie: 60, modernite: 80 }).references
  }
  return []
}
