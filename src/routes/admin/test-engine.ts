import { Elysia } from 'elysia'
import { requireAdmin, isResponse } from '../../lib/require-auth'
import {
  compileHeroPromptV2,
  compileInstructPrompt,
  compileLogoFondPrompt,
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
import { generateLogoIntegral } from '../../lib/engine/logo-integral'
import { pickExemplars, pickExemplarsEtiquetes, styleQueryForMatiere } from '../../lib/engine/exemplars'
import { cutoutFlatBackground } from '../../lib/engine/cutout'
import { composeBanniereLogo, composeLogoOnFond } from '../../lib/engine/logo-compose'
import { UNIVERSE_LABELS } from '../../lib/engine/mapping'
import { GeminiError } from '../../lib/ai/gemini'
import { adnBlockBackground, getTrainingStatus, TrainingRequiredError } from '../../lib/engine/adn'

// ── /admin/test-moteur (run 5.2 → 5.4) ───────────────────────────────────────
// La page de test à boutons : chaque cas affiche son brief et ses prompts
// AVANT tout lancement (GET /cases = compilation pure, zéro appel API), et
// c'est LE CLIENT qui déclenche chaque génération (POST /run). Aucun débit
// de crédits — coût réel affiché par étage, loggé en kind admin_test_*.
// Run 5.4 (LOT 6) :
//   - badge d'état ADN/exemplars/réfs en tête, cas GRISÉS sans entraînement ;
//   - cas « Fruitz FiveM-check » : même brief qu'avant — attendu relief/
//     biseau, glow, rendu « logo de serveur », gabarits complets dépliables
//     AVANT génération, scores du contrôle (relief, glow, ADN, 64 px) après ;
//   - cas dauphin conservé (construction ALYA) ;
//   - cas étape B : 3 fonds générés SANS le logo, composition par calques,
//     déclinaisons téléchargeables (alpha, carré 1:1, bannière 16:9) ;
//   - compteurs : coût par étage, rejets OCR, échecs concept, ÉCHECS ADN.

// SEULE exception au « zéro logo sur flash » : la variante A/B « ancien
// chemin » ci-dessous, qui documente précisément ce qu'on a quitté.
// Aucune route produit n'y touche.
// Run 5.7 : LEGACY_FLASH_LOGO_AB supprimé avec l'A/B logo monolithique.

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

// Briefs des cas logo — exactement ce que le wizard v4 transmettrait (la
// question « fond » n'existe plus : l'étape A livre toujours sur #F2F2F2).
const FRUITZ_BRIEF: LogoAnswersV3 = parseLogoAnswersV3({
  type: 'nom',
  sujet: 'fruit, été, juteux',
  ambiance: 'ete',
  couleurs: { mode: 'degrade', couleurs: ['#FF6B4A', '#FFC4A3'], angle: 45 },
})!
const DAUPHIN_BRIEF: LogoAnswersV3 = parseLogoAnswersV3({
  type: 'nom',
  sujet: 'dauphin, océan',
  ambiance: 'ete',
  couleurs: { mode: 'degrade', couleurs: ['#118AB2', '#06D6A0'], angle: 90 },
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
  // logo_v3_concepts = étage 1 seul · logo_v3_generation = étages 2+3 ·
  // logo_fond_b = étape B (fonds + composition + déclinaisons)
  pipeline: 'v1' | 'v2' | 'instruct' | 'logo_v3_concepts' | 'logo_v3_generation' | 'logo_fond_b'
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
        label: 'Étage 1 — écrire les 3 gabarits maîtres (DA, thinking high)',
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
        prompt: '(les 3 prompts gabarit viennent de l’étage 1 — lancer « concepts » d’abord)',
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

// Le compilateur de fonds du cas étape B — rejoué au GET et au POST.
function compileEtapeBFond() {
  const { da, energie, modernite } = daFor(AZURE)
  return compileLogoFondPrompt({
    da,
    choix: 'signature',
    sujet: DAUPHIN_BRIEF.sujet,
    couleurs: DAUPHIN_BRIEF.couleurs.mode === 'degrade' ? DAUPHIN_BRIEF.couleurs.couleurs : da.palette,
    energie,
    modernite,
    adnFondBlock: adnBlockBackground(),
  })
}

// Compilation pure des cas — rejouée à chaque GET (et au POST, pour que le
// prompt exécuté soit exactement celui affiché).
function buildCases(): TestCase[] {
  const daRedside = resolveArtDirection(REDSIDE_ANSWERS, REDSIDE.name)
  const daEte = resolveArtDirection(ETE_ANSWERS, VESPUCCI.name)
  const daL6rys = resolveArtDirection({ universe: 'rp_urbain', energie: 60, modernite: 80, couleur: '#00D2FF' }, L6RYS.name)
  const daFruitz = resolveArtDirection(FRUITZ_ANSWERS, FRUITZ.name)

  // Run 5.7 : l'A/B « ancien chemin monolithique vs nouveau » est retiré —
  // compileLogoPromptV2 est supprimée du code (interdit : aucune génération
  // « logo entier » où que ce soit). daFruitz reste utilisé par les cas v3.
  void daFruitz

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
  const etapeBFond = compileEtapeBFond()

  return [
    logoV3Case({
      id: 'fruitz_reel',
      titre: 'Cas Fruitz FiveM-check — même brief, ADN v4 exigé',
      attendu:
        'Même brief que le test 5.3 (« fruit, été, juteux », dégradé #FF6B4A→#FFC4A3 45°). Attendu v4 : relief/biseau marqué (≥2 concepts relief sur 3), glow, rendu « logo de serveur FiveM » — PLUS JAMAIS une icône d’appli. Le gabarit maître complet de chaque concept se déplie AVANT génération ; après : scores du contrôle (relief, glow, verdict ADN, lisibilité 64 px).',
      project: FRUITZ,
      brief: FRUITZ_BRIEF,
      generationLabel: 'Étages 2+3 — générer les 3 propositions (pro 2K + relecture ADN)',
    }),
    logoV3Case({
      id: 'theme_animal',
      titre: 'Thème animal — « dauphin, océan » pour Azure Bay',
      attendu:
        'Attendu : une construction type ALYA — lettrage épousant/fusionnant la silhouette du dauphin — PAS un blason esport générique, PAS une icône d’appli. Le fond arrive à l’étape B (cas suivant) : ici le logo sort seul sur #F2F2F2.',
      project: AZURE,
      brief: DAUPHIN_BRIEF,
      generationLabel: 'Étages 2+3 — générer les 3 propositions (pro 2K + relecture ADN)',
    }),
    {
      id: 'etape_b',
      titre: 'Étape B — 3 fonds pour le logo dauphin validé, composition, déclinaisons',
      attendu:
        'Le fond se génère SANS le logo (bibliothèque de fonds en few-shot + réfs jointes) : 3 fonds signature (dégradé océan + doodles marins dérivés de « dauphin, océan »), centre calme réservé au logo. Composition locale [fond][logo] (ombre douce + glow de contact) + déclinaisons téléchargeables : PNG alpha, carré 1:1, bannière 16:9. Chaque calque régénérable indépendamment.',
      variants: [
        {
          id: 'fonds',
          label: '3 fonds + composition + déclinaisons (logo = dernier rendu du cas dauphin)',
          pipeline: 'logo_fond_b',
          kind: 'logo',
          model: ENGINE_MODELS.scene,
          count: 3,
          prompt: etapeBFond.prompt,
          referencesJointes: etapeBFond.references.length,
          ocrAttendus: [],
          aspectRatio: '1:1',
        },
      ],
    },
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

// Version grisée des cas quand l'entraînement v4 n'est pas installé : les
// titres et attendus restent lisibles, AUCUNE compilation few-shot, chaque
// variante porte le message de blocage à la place du prompt.
function buildCasesGrises(message: string): TestCase[] {
  const skeleton: Array<{ id: string; titre: string; attendu: string; variants: Array<{ id: string; label: string }> }> = [
    { id: 'fruitz_reel', titre: 'Cas Fruitz FiveM-check — même brief, ADN v4 exigé', attendu: 'Bloqué : l’ADN v4 et les exemplars manquent.', variants: [{ id: 'concepts', label: 'Étage 1 — gabarits maîtres' }, { id: 'generation', label: 'Étages 2+3 — propositions' }] },
    { id: 'ab_flash_da', titre: 'A/B — flash sans DA vs pro+gabarit+ADN', attendu: 'Bloqué : entraînement requis.', variants: [{ id: 'ancien', label: 'Ancien chemin' }, { id: 'nouveau', label: 'Nouveau chemin' }] },
    { id: 'theme_animal', titre: 'Thème animal — « dauphin, océan »', attendu: 'Bloqué : entraînement requis.', variants: [{ id: 'concepts', label: 'Étage 1' }, { id: 'generation', label: 'Étages 2+3' }] },
    { id: 'etape_b', titre: 'Étape B — 3 fonds, composition, déclinaisons', attendu: 'Bloqué : la bibliothèque de fonds manque.', variants: [{ id: 'fonds', label: '3 fonds + composition' }] },
    { id: 'ab_banniere', titre: 'A/B bannière « REDSIDE »', attendu: 'Bloqué : entraînement requis.', variants: [{ id: 'v1', label: 'Ancien chemin' }, { id: 'v2', label: 'Héro v2' }] },
    { id: 'orthographe', titre: 'Orthographe piège — « L6RYS » ×3', attendu: 'Bloqué : entraînement requis.', variants: [{ id: 'banniere', label: 'Bannière ×3' }] },
    { id: 'mapping', titre: 'Le mapping — Cartel vs Été', attendu: 'Bloqué : entraînement requis.', variants: [{ id: 'cartel', label: 'REDSIDE' }, { id: 'ete', label: 'Vespucci Life' }] },
    { id: 'gomme_instruction', titre: 'Gomme + instruction', attendu: 'Bloqué : entraînement requis.', variants: [{ id: 'chrome', label: 'Instruction' }] },
  ]
  return skeleton.map((c) => ({
    id: c.id,
    titre: c.titre,
    attendu: c.attendu,
    variants: c.variants.map((v) => ({
      id: v.id,
      label: v.label,
      pipeline: 'v2' as const,
      kind: 'logo' as const,
      model: '—',
      count: 0,
      prompt: message,
      referencesJointes: 0,
      ocrAttendus: [],
      aspectRatio: '1:1',
    })),
  }))
}

// ── État de session (mémoire process — suffisant pour la page de test) ──────
const lastRenders = new Map<string, string>()
// concepts du DA par cas logo — la génération rejoue EXACTEMENT ces prompts
const conceptsByCase = new Map<string, { concepts: LogoConcept[]; daEur: number }>()
// Les compteurs de session (run 5.4 : + échecs ADN)
const compteurs = {
  generations: 0,
  ocrRejets: 0,
  echecsConcept: 0,
  echecsAdn: 0,
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

const TRAINING_MESSAGE = 'Entraînement requis — lance `bun run scripts/train-fivem-v4.ts`'

export const adminTestEngineRoutes = new Elysia({ prefix: '/admin/test-moteur' })
  // Compilation pure — AUCUN appel API : briefs et prompts s'affichent avant tout.
  // Badge d'état d'entraînement TOUJOURS dans la réponse ; cas grisés sans v4.
  .get('/cases', async ({ request }) => {
    const guard = await requireAdmin(request)
    if (isResponse(guard)) return guard
    const entrainement = getTrainingStatus()
    let cases: TestCase[]
    if (entrainement.installed) {
      cases = buildCases()
    } else {
      cases = buildCasesGrises(`${TRAINING_MESSAGE} (${entrainement.manques.join(' ; ')})`)
    }
    return Response.json({
      cases,
      entrainement,
      bloque: !entrainement.installed,
      messageBlocage: entrainement.installed ? null : TRAINING_MESSAGE,
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
        { error: `${TRAINING_MESSAGE} (${entrainement.manques.join(' ; ')})` },
        { status: 409 }
      )
    }

    const body = await request.json().catch(() => null) as { caseId?: string; variantId?: string } | null
    const testCase = buildCases().find((c) => c.id === body?.caseId)
    const variant = testCase?.variants.find((v) => v.id === body?.variantId)
    if (!testCase || !variant) return Response.json({ error: 'Cas de test inconnu.' }, { status: 400 })

    const startedAt = Date.now()

    try {
      // ── Étage 1 seul : le DA écrit les 3 gabarits, aucune image ──────────
      if (variant.pipeline === 'logo_v3_concepts') {
        const ctx = CASE_PROJECTS[testCase.id]
        if (!ctx) return Response.json({ error: 'Cas logo sans projet câblé.' }, { status: 400 })
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
          reliefLeve: direction.reliefLeve,
          coutParEtage: { daEur, generationEur: 0, relectureEur: 0, totalEur: daEur },
          dureeMs: Date.now() - startedAt,
          compteurs,
        })
      }

      // ── Étages 2+3 : générer les propositions depuis les gabarits ────────
      if (variant.pipeline === 'logo_v3_generation') {
        const ctx = CASE_PROJECTS[testCase.id]
        const stored = conceptsByCase.get(testCase.id)
        if (!ctx || !stored) {
          return Response.json({ error: 'Lance d’abord l’étage 1 (les 3 gabarits du DA) — la génération exécute exactement ces prompts.' }, { status: 409 })
        }
        const { da, energie, modernite } = daFor(ctx.project)
        // Run 5.10 : rendu INTÉGRAL — références étiquetées de la famille du
        // concept ; la sélection calques (fond + marque) ne sert plus que de
        // plan de secours orthographe.
        const exemplarsFond = pickExemplars({ category: 'logo', da, energie, modernite, maxPrompts: 0, maxReferences: 3 })
        const styleQuery = styleQueryForMatiere(ctx.brief.matiere)
        const concepts = stored.concepts.slice(0, variant.count)

        const propositions = []
        let generationEur = 0
        let relectureEur = 0
        for (const [i, concept] of concepts.entries()) {
          const exemplarsMarque = pickExemplars({
            category: 'logo',
            da,
            energie,
            modernite,
            maxPrompts: 0,
            maxReferences: 3,
            famille: concept.famille,
            prefereLettrage: true,
          })
          const etiquetees = pickExemplarsEtiquetes({
            category: 'logo',
            da,
            energie,
            modernite,
            famille: concept.famille,
            traitements: styleQuery.traitements,
            matiereMotsCles: styleQuery.matiereMotsCles,
            max: 3,
          })
          const prop = await generateLogoIntegral({
            projectName: ctx.project.name,
            answers: ctx.brief,
            concept,
            references: etiquetees,
            fallbackReferences: { fond: exemplarsFond.references, marque: exemplarsMarque.references },
            resolution: '2K',
            log: { userId: adminUserId, kind: `admin_test_${testCase.id}_${variant.id}_${i + 1}` },
          })
          propositions.push({
            dataUrl: prop.dataUrl,
            concept: prop.concept,
            mode: prop.mode,
            promptIntegral: prop.promptIntegral,
            referencesEtiquetees: prop.referencesEtiquetees,
            ocrRejects: prop.ocrRejects,
            conceptOk: prop.conceptOk,
            adnOk: prop.adnOk,
            serveurLogo: prop.serveurLogo,
            lisible64: prop.lisible64,
            scores: prop.scores,
            defauts: prop.defauts,
            regenere: prop.regenere,
            modeLockup: prop.fallback?.modeLockup ?? false,
            fallbackLettrageLocal: prop.fallback?.fallbackLettrageLocal ?? false,
          })
          generationEur += prop.cout.generationEur
          relectureEur += prop.cout.relectureEur
          compteurs.generations += 1
          compteurs.ocrRejets += prop.ocrRejects
          if (!prop.conceptOk) compteurs.echecsConcept += 1
          if (!prop.adnOk) compteurs.echecsAdn += 1
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

      // ── Étape B : 3 fonds SANS logo + composition + déclinaisons ─────────
      if (variant.pipeline === 'logo_fond_b') {
        const logoRender =
          lastRenders.get('theme_animal:generation') ??
          lastRenders.get('fruitz_reel:generation') ??
          lastRenders.get('ab_flash_da:nouveau')
        if (!logoRender) {
          return Response.json({ error: 'Lance d’abord un cas logo (dauphin ou Fruitz, étages 2+3) — l’étape B habille un logo validé.' }, { status: 409 })
        }
        // Le rendu sort sur #F2F2F2 : détourage local → le calque logo alpha
        const logoBuffer = Buffer.from(logoRender.split(',').pop() ?? '', 'base64')
        const cutout = await cutoutFlatBackground(logoBuffer)
        const compiled = compileEtapeBFond()

        const fonds: Array<{ fondDataUrl: string; previewDataUrl: string }> = []
        let tokensIn = 0
        let tokensOut = 0
        let imagesOut = 0
        for (let i = 0; i < variant.count; i += 1) {
          const generation = await generateWithOcrGate({
            model: variant.model,
            prompt: compiled.prompt,
            referenceImages: compiled.references,
            imageConfig: { aspectRatio: '1:1', imageSize: '2K' },
            expectedTexts: [],
            log: { userId: adminUserId, kind: `admin_test_${testCase.id}_fond_${i + 1}`, resolution: '2K' },
          })
          tokensIn += generation.usage.tokensIn
          tokensOut += generation.usage.tokensOut
          imagesOut += 1
          compteurs.generations += 1
          const fondPng = Buffer.from(generation.dataUrl.split(',').pop() ?? '', 'base64')
          const preview = await composeLogoOnFond({ fondPng, logoPng: cutout.png, width: 1024, height: 1024 })
          fonds.push({
            fondDataUrl: generation.dataUrl,
            previewDataUrl: `data:image/png;base64,${preview.toString('base64')}`,
          })
        }

        // Déclinaisons du premier fond : alpha (le détourage), carré, bannière
        const firstFond = Buffer.from(fonds[0]!.fondDataUrl.split(',').pop() ?? '', 'base64')
        const [carre, banniere] = await Promise.all([
          composeLogoOnFond({ fondPng: firstFond, logoPng: cutout.png, width: 1024, height: 1024 }),
          composeBanniereLogo({ fondPng: firstFond, logoPng: cutout.png, width: 1280, height: 720 }),
        ])
        const declinaisons = {
          alphaDataUrl: `data:image/png;base64,${cutout.png.toString('base64')}`,
          carreDataUrl: `data:image/png;base64,${carre.toString('base64')}`,
          banniereDataUrl: `data:image/png;base64,${banniere.toString('base64')}`,
        }

        const coutEur = estimateCostEur({ model: variant.model, tokensIn, tokensOut, imagesOut, resolution: '2K' })
        addCost(coutEur)

        return Response.json({
          caseId: testCase.id,
          variantId: variant.id,
          fonds,
          declinaisons,
          promptExecute: compiled.prompt,
          coutEur,
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
      if (error instanceof TrainingRequiredError) {
        return Response.json({ error: error.message }, { status: 409 })
      }
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
