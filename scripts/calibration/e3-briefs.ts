/*
 * Run 6 — EXPÉRIENCE E3 : le DA v6 sur CINQ briefs, un concept chacun.
 *
 * Question tranchée : le prompt en 3 phrases + les archétypes de construction
 * font-ils monter l'overlap au-dessus du seuil de leur archétype — et sur des
 * briefs que le moteur n'a jamais vus ?
 *
 * L'expérience tient en DEUX PHASES SÉPARÉES, et c'est délibéré : la phase 1
 * ne produit que du texte (les 5 prompts), la phase 2 seule paie des images.
 * L'opérateur lit les prompts entre les deux et décide. Rien n'oblige à
 * enchaîner.
 *
 *   1. bun run scripts/calibration/e3-briefs.ts                  → le PLAN, 0 €
 *   2. bun run scripts/calibration/e3-briefs.ts --concepts --fresh-concepts
 *                                                                → 5 appels DA
 *   3. bun run scripts/calibration/e3-briefs.ts --render         → 5 images
 *
 * Options : --plafond <eur> (plafond DUR de la phase 2, défaut 1,20 €)
 *           --briefs a,b,c (sous-ensemble)   --resolution 1K|2K (défaut 2K)
 *
 * Ce qui est mesuré, et où — dit sans arrondi :
 *   - overlap_ratio : sur le RENDU, par appel de détection, seuil de
 *     l'archétype visé (patch P1) ;
 *   - taux_de_debordement : sur le BLOCKOUT, c'est-à-dire sur l'INTENTION du
 *     DA, en local et à zéro appel. Le mesurer sur le rendu demanderait des
 *     masques de segmentation que ce pipeline n'a pas ;
 *   - brief 5 (vulcain) : les deux sont NON APPLICABLES — pas de lettrage,
 *     donc pas de dénominateur. Seule la porte OCR « aucun texte » s'applique.
 */

import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  installBudgetGuard,
  setActiveCap,
  setBudgetLabel,
  spentEur,
  CAP_EUR,
  CALIBRATION_DIR,
} from './budget6'
import { BRIEFS_E3, briefE3, motAttendu, type BriefE3 } from './briefs-e3'
import { mesureComposition, type CompositionMesure } from './mesure-v6'
import { artDirectionForProject } from '../../src/lib/engine/mapping'
import {
  directLogoConceptsV6,
  buildDirectorSystemV6,
  ARCHETYPE_SANS_LETTRAGE,
  type LogoConceptV6,
} from '../../src/lib/engine/logo-director-v6'
import { renderBlockout } from '../../src/lib/engine/logo-blockout'
import { pickExemplarsParSlugs } from '../../src/lib/engine/exemplars'
import { generateWithOcrGate } from '../../src/lib/engine/ocr-gate'
import { ENGINE_MODELS, LOGO_THINKING_LEVEL } from '../../src/lib/engine/generation'
import { requireTraining } from '../../src/lib/engine/adn'

installBudgetGuard()

const args = process.argv.slice(2)
const phaseConcepts = args.includes('--concepts')
const phaseRender = args.includes('--render')
const freshConcepts = args.includes('--fresh-concepts')
const valeur = (nom: string): string | null => {
  const i = args.indexOf(nom)
  return i >= 0 ? (args[i + 1] ?? null) : null
}
const plafondPhase2 = Number(valeur('--plafond') ?? '1.20')
const resolution = (valeur('--resolution') ?? '2K') as '1K' | '2K'
const filtre = valeur('--briefs')
const briefs = filtre ? filtre.split(',').map((s) => briefE3(s.trim())) : BRIEFS_E3

const SORTIE = join(CALIBRATION_DIR, '_e3')
const CACHE_FORMAT = 'v6-e3'
const USER = 'calibration-run6-e3'

// ── Coûts UNITAIRES observés — relevés dans les grands livres, pas estimés ───
// budget-ledger-5.json : appel DA gemini-3.1-pro-preview 3395/1914 tk = 0,0274 €
//                        image 2K gemini-3-pro-image             = 0,1381 €
// budget-ledger-6.json : 215 appels flash (E1)                   = 0,158 €
//                        soit ~0,0007 € par appel de mesure/OCR
const COUT = { da: 0.03, image: 0.14, flash: 0.001 }

type ConceptCache = {
  format: string
  empreinte: string
  genere_le: string
  brief: string
  archetypeRendu: string
  conceptRendu: LogoConceptV6
  tousLesConcepts: LogoConceptV6[]
  coutEur: number
}

function cheminCache(id: string): string {
  return join(SORTIE, `concepts-${id}.json`)
}

/** L'empreinte du brief ET du système du DA : un cache né d'un autre gabarit
 *  est refusé net (piège n°9 du 5.9 — le cache jamais re-validé). */
function empreinte(b: BriefE3): string {
  const mot = motAttendu(b)
  return createHash('sha1')
    .update(JSON.stringify({ project: b.project, answers: b.answers }))
    .update(buildDirectorSystemV6(mot))
    .digest('hex')
    .slice(0, 12)
}

/*
 * La sélection du concept rendu — DÉTERMINISTE, écrite avant de voir les
 * sorties.
 *
 * PIVOT IDIOME (17/08) : c'était « CONTAINER d'abord, ENTWINED sinon », parce
 * que ce sont les deux seuls archétypes sur lesquels l'overlap sépare. Cette
 * règle choisissait le candidat qui se MESURE le mieux, pas celui qui
 * ressemble à la cible — et l'opérateur vient de trancher que la cible est le
 * monogramme. On rend donc HERO_MONOGRAM en premier, en sachant, et en
 * l'écrivant, que l'overlap ne dira rien sur lui : la porte est la planche.
 * Sans lettrage, il n'y a qu'un archétype possible : on prend le premier.
 */
export function choisirConcept(concepts: LogoConceptV6[]): LogoConceptV6 {
  /*
   * La FAMILLE passe avant l'archétype. Relevé sur le premier tir de nox : le
   * DA a rendu HERO_MONOGRAM / chrome_3d, CONTAINER / texture_fill et
   * ENTWINED / flat_vector_texture — un trio parfaitement conforme. Prendre le
   * HERO_MONOGRAM aurait rendu le SEUL concept chromé des trois, c'est-à-dire
   * exactement le registre que le pivot déclare minoritaire. Le chrome reste
   * autorisé (deux pièces gold le portent), il n'est simplement plus ce qu'on
   * rend par défaut.
   */
  // un cache antérieur peut ne contenir que du chrome : on ne se retrouve
  // jamais sans candidat
  const plats = concepts.filter((c) => c.famille_rendu !== 'chrome_3d')
  const pool = plats.length ? plats : concepts
  // WORDMARK_PUR passe juste après le monogramme : sur un nom de plus de trois
  // lettres, c'est lui qui porte l'idiome (correction opérateur du 17/08).
  for (const archetype of ['HERO_MONOGRAM', 'WORDMARK_PUR', 'ENTWINED', 'CONTAINER', 'CREST', 'SCENE', ARCHETYPE_SANS_LETTRAGE]) {
    const trouve = pool.find((c) => c.archetype === archetype)
    if (trouve) return trouve
  }
  return pool[0]!
}

// ── PHASE 0 — le plan, zéro appel ────────────────────────────────────────────

function afficherPlan() {
  const avecLettrage = briefs.filter((b) => motAttendu(b) !== null).length
  const coutConcepts = briefs.length * COUT.da
  const coutImages = briefs.length * COUT.image
  const coutOcr = avecLettrage * COUT.flash
  const coutMesure = avecLettrage * COUT.flash * 1.5 // jusqu'à 3 essais, 1,5 en moyenne

  console.log('\n═══ E3 — PLAN (aucun appel passé)\n')
  console.log('Phase 1 — CONCEPTS (texte seul) :')
  for (const b of briefs) {
    const mot = motAttendu(b)
    console.log(`  ${b.id.padEnd(11)} « ${b.project.name} »${mot ? ` → mot « ${mot} »` : ' → AUCUN lettrage'}`)
    console.log(`  ${''.padEnd(11)} ${b.stress}`)
  }
  console.log(`\n  ${briefs.length} appels DA v6 (${ENGINE_MODELS.logoDirector}, thinking ${LOGO_THINKING_LEVEL})`)
  console.log(`  coût attendu : ${coutConcepts.toFixed(3)} €  (0,0274 € relevé au 5.10 par appel)`)

  console.log('\nPhase 2 — RENDU (images) :')
  console.log(`  ${briefs.length} images ${resolution} ${ENGINE_MODELS.logoImage}, 1 par brief, AUCUNE régénération critique`)
  console.log(`  porte OCR sur ${avecLettrage} briefs (jusqu'à 2 reprises silencieuses chacun)`)
  console.log(`  coût attendu : ${(coutImages + coutOcr + coutMesure).toFixed(3)} €`)
  console.log(`  pire cas (chaque porte OCR épuisée) : ${(briefs.length * 3 * COUT.image).toFixed(3)} €`)
  console.log(`  plafond DUR posé sur la phase 2 : ${plafondPhase2.toFixed(2)} € — la garde refuse AVANT envoi`)

  console.log(`\n  TOTAL attendu : ${(coutConcepts + coutImages + coutOcr + coutMesure).toFixed(3)} €`)
  console.log(`  grand livre session 6 : ${spentEur().toFixed(4)} € / ${CAP_EUR.toFixed(2)} € (reste ${(CAP_EUR - spentEur()).toFixed(3)} €)`)
  console.log('\nPour lancer :')
  console.log('  phase 1  bun run scripts/calibration/e3-briefs.ts --concepts --fresh-concepts')
  console.log('  phase 2  bun run scripts/calibration/e3-briefs.ts --render\n')
}

// ── PHASE 1 — les concepts (texte) ───────────────────────────────────────────

async function phase1() {
  requireTraining()
  mkdirSync(SORTIE, { recursive: true })
  console.log(`\n═══ E3 phase 1 — CONCEPTS (${briefs.length} appels DA)\n`)

  for (const b of briefs) {
    const chemin = cheminCache(b.id)
    if (existsSync(chemin) && !freshConcepts) {
      console.error(
        `✗ ${b.id} : un cache existe déjà (${chemin}). Relance avec --fresh-concepts — un cache n'est JAMAIS réutilisé en silence.`
      )
      process.exitCode = 1
      return
    }
  }

  const depart = spentEur()
  for (const b of briefs) {
    const { da, energie, modernite } = artDirectionForProject(b.project)
    setBudgetLabel(`e3_da_${b.id}`)
    const avant = spentEur()
    const direction = await directLogoConceptsV6({
      project: b.project,
      da,
      answers: b.answers,
      energie,
      modernite,
      moteur: 'gemini',
      log: { userId: USER, projectId: null, assetId: null },
    })
    const concept = choisirConcept(direction.concepts)
    const cache: ConceptCache = {
      format: CACHE_FORMAT,
      empreinte: empreinte(b),
      genere_le: new Date().toISOString(),
      brief: b.id,
      archetypeRendu: concept.archetype,
      conceptRendu: concept,
      tousLesConcepts: direction.concepts,
      coutEur: Math.round((spentEur() - avant) * 10000) / 10000,
    }
    writeFileSync(cheminCache(b.id), JSON.stringify(cache, null, 2))

    // le blockout du concept retenu, dessiné localement (zéro appel) — la
    // trace visuelle de la construction demandée
    const mot = motAttendu(b)
    if (concept.blockout && mot) {
      writeFileSync(join(SORTIE, `blockout-${b.id}.png`), await renderBlockout(concept.blockout, mot))
    }

    console.log(`── ${b.id} · ${concept.archetype} · ${cache.coutEur.toFixed(4)} €`)
    console.log(`   refs   : ${concept.refs.map((r) => r.slug).join(', ')}`)
    console.log(`   déb.   : ${concept.debordement === null ? 'n/a' : concept.debordement.toFixed(3)}`)
    console.log(`   why    : ${concept.why}`)
    console.log(`   PROMPT : ${concept.prompt}\n`)
  }

  ecrisPrompts()
  console.log(`Phase 1 terminée — ${(spentEur() - depart).toFixed(4)} € dépensés, grand livre ${spentEur().toFixed(4)} € / ${CAP_EUR.toFixed(2)} €`)
  console.log(`Prompts : ${join(SORTIE, 'prompts-e3.md')}`)
}

function litCache(b: BriefE3): ConceptCache {
  const chemin = cheminCache(b.id)
  if (!existsSync(chemin)) {
    throw new Error(`${b.id} : aucun concept en cache (${chemin}) — joue d'abord la phase 1 (--concepts --fresh-concepts)`)
  }
  const cache = JSON.parse(readFileSync(chemin, 'utf-8')) as ConceptCache
  if (cache.format !== CACHE_FORMAT) {
    throw new Error(`${b.id} : cache au format « ${cache.format} », attendu « ${CACHE_FORMAT} » — relance la phase 1`)
  }
  if (cache.empreinte !== empreinte(b)) {
    throw new Error(
      `${b.id} : le brief ou le système du DA a changé depuis la génération des concepts (empreinte ${cache.empreinte} ≠ ${empreinte(b)}) — relance la phase 1`
    )
  }
  // Le concept rendu est RECALCULÉ, jamais lu tel quel : la règle de sélection
  // est du code, et faire évoluer du code ne doit pas coûter trois appels DA.
  const rendu = choisirConcept(cache.tousLesConcepts)
  return { ...cache, conceptRendu: rendu, archetypeRendu: rendu.archetype }
}

/** Le cache TEL QU'IL EST, même périmé — pour rendre compte sans mentir d'un
 *  rejeu partiel : les briefs non rejoués restent affichés, marqués comme
 *  venant d'une configuration de DA antérieure. */
function litCacheTolerant(b: BriefE3): { cache: ConceptCache; perime: boolean } | null {
  const chemin = cheminCache(b.id)
  if (!existsSync(chemin)) return null
  try {
    const cache = JSON.parse(readFileSync(chemin, 'utf-8')) as ConceptCache
    // même recalcul que litCache : le document des prompts doit montrer ce qui
    // sera RÉELLEMENT rendu, pas ce qui l'aurait été sous l'ancienne règle
    const rendu = choisirConcept(cache.tousLesConcepts)
    return {
      cache: { ...cache, conceptRendu: rendu, archetypeRendu: rendu.archetype },
      perime: cache.format !== CACHE_FORMAT || cache.empreinte !== empreinte(b),
    }
  } catch {
    return null
  }
}

function ecrisPrompts() {
  // TOUS les briefs qui ont un cache, pas seulement ceux du rejeu en cours :
  // un rejeu partiel ne doit pas amputer le document que lit l'opérateur.
  const avecCache = BRIEFS_E3.map((b) => ({ b, lu: litCacheTolerant(b) })).filter(
    (x): x is { b: BriefE3; lu: { cache: ConceptCache; perime: boolean } } => x.lu !== null
  )
  const lignes: string[] = [
    `# E3 — les ${avecCache.length} prompts du DA v6 (${new Date().toISOString().slice(0, 10)})`,
    '',
    'Un concept par brief. S1 et S3 sont écrites par le CODE, seule S2 vient du modèle.',
    'REFERENCE 1 est toujours une pièce FiveM/GTA du corpus : l\'idiome vient des images, pas du prompt.',
    '',
  ]
  for (const { b, lu } of avecCache) {
    const cache = lu.cache
    const c = cache.conceptRendu
    if (lu.perime) {
      lignes.push(`> ⚠ **${b.id}** : concepts issus d'une configuration de DA ANTÉRIEURE, non rejoués.`, '')
    }
    lignes.push(
      `## ${b.id} — ${b.project.name} · ${c.archetype} · ${c.famille_rendu}`,
      '',
      `- **Ce que ce brief casse** : ${b.stress}`,
      `- **Mot attendu** : ${motAttendu(b) ?? '— aucun lettrage —'}`,
      `- **Références** : ${c.refs.map((r) => `\`${r.slug}\``).join(' · ')}`,
      `- **Débordement du blockout** : ${c.debordement === null ? 'non applicable' : c.debordement.toFixed(3)}`,
      `- **Note DA** : ${c.why}`,
      '',
      '```',
      c.prompt,
      '```',
      '',
      `S2 seule (${c.s2.trim().split(/\s+/).length} mots) : *${c.s2}*`,
      '',
      '### Les 2 autres concepts du trio (non rendus)',
      '',
      ...cache.tousLesConcepts
        .filter((x) => x !== c && x.s2 !== c.s2)
        .map((x) => `- **${x.archetype}** · ${x.famille_rendu} — ${x.s2}`),
      ''
    )
  }
  writeFileSync(join(SORTIE, 'prompts-e3.md'), lignes.join('\n'))
}

// ── PHASE 2 — le rendu (images) ──────────────────────────────────────────────

type ResultatE3 = {
  brief: string
  nom: string
  stress: string
  archetype: string
  /** pivot idiome — la langue de rendu visée par le concept */
  famille_rendu: string
  mot: string | null
  prompt: string
  refs: string[]
  debordementBlockout: number | null
  composition: CompositionMesure | null
  ocrRejects: number
  ocrDetail: string
  coutEur: number
  fichier: string
}

async function phase2() {
  requireTraining()
  if (freshConcepts) {
    throw new Error(
      '--fresh-concepts est REFUSÉ en phase 2 : les prompts rendus doivent être EXACTEMENT ceux que l\'opérateur a validés. Rejoue la phase 1 si tu veux d\'autres concepts.'
    )
  }
  mkdirSync(SORTIE, { recursive: true })

  // plafond DUR de la phase : la garde refuse AVANT envoi au-delà.
  const plafond = Math.min(CAP_EUR, spentEur() + plafondPhase2)
  setActiveCap(plafond)
  console.log(`\n═══ E3 phase 2 — RENDU (${briefs.length} images ${resolution})`)
  console.log(`Plafond de phase : ${plafond.toFixed(3)} € (grand livre ${spentEur().toFixed(4)} €)\n`)

  const resultats: ResultatE3[] = []
  for (const b of briefs) {
    const cache = litCache(b)
    const concept = cache.conceptRendu
    const mot = motAttendu(b)
    const dossier = join(SORTIE, b.id)
    mkdirSync(dossier, { recursive: true })
    const avant = spentEur()

    setBudgetLabel(`e3_image_${b.id}`)
    const references = pickExemplarsParSlugs({ category: 'logo', choix: concept.refs })
    const generation = await generateWithOcrGate({
      model: ENGINE_MODELS.logoImage,
      prompt: concept.prompt,
      referenceImages: references.map((r) => ({ data: r.data, mimeType: r.mimeType })),
      referencesFirst: true,
      referenceLabels: references.map((r) => r.label),
      imageConfig: { aspectRatio: '1:1', imageSize: resolution },
      thinkingLevel: LOGO_THINKING_LEVEL,
      expectedTexts: mot ? [mot] : [],
      forbidAnyText: mot === null,
      // Toute image payée touche le disque avant qu'un appel de plus puisse
      // échouer : un rendu 2K perdu vaut 0,14 €, un fichier de travail vaut 0 €.
      onImagePayee: (dataUrl, essai) => {
        writeFileSync(
          join(dossier, `brut-essai${essai}.png`),
          Buffer.from(dataUrl.split(',').pop() ?? '', 'base64')
        )
      },
      log: { userId: USER, projectId: null, assetId: null, kind: `e3_${b.id}`, resolution },
    })

    const png = Buffer.from(generation.dataUrl.split(',').pop() ?? '', 'base64')
    const fichier = join(dossier, 'candidate.png')
    // Un rejeu ne se juge pas sans son avant : la version précédente est
    // archivée AVANT écriture, jamais écrasée. Le 17/08, ce décalage avait été
    // fait à la main pour azure et blackwood — d'où deux briefs comparables et
    // trois qui ne l'étaient pas.
    archivePrecedent(dossier)
    writeFileSync(fichier, png)
    writeFileSync(join(dossier, 'prompt.txt'), concept.prompt)

    // ── la mesure : overlap sur le RENDU, au seuil de l'archétype (P1)
    let composition: CompositionMesure | null = null
    if (concept.archetype !== ARCHETYPE_SANS_LETTRAGE) {
      composition = await mesureComposition({ png, label: `e3_overlap_${b.id}`, archetype: concept.archetype })
    }

    const resultat: ResultatE3 = {
      brief: b.id,
      nom: b.project.name,
      stress: b.stress,
      archetype: concept.archetype,
      famille_rendu: concept.famille_rendu,
      mot,
      prompt: concept.prompt,
      refs: concept.refs.map((r) => r.slug),
      debordementBlockout: concept.debordement,
      composition,
      ocrRejects: generation.ocrRejects,
      ocrDetail: generation.ocrDetail,
      coutEur: Math.round((spentEur() - avant) * 10000) / 10000,
      fichier,
    }
    resultats.push(resultat)
    writeFileSync(join(dossier, 'resultat.json'), JSON.stringify(resultat, null, 2))

    console.log(
      `── ${b.id.padEnd(11)} ${concept.archetype.padEnd(14)} overlap ${
        composition ? composition.overlapRatio.toFixed(3) : ' n/a '
      } ${composition ? `(${composition.verdict}, seuil ${composition.seuil ?? 'n/a'})` : '(sans lettrage)'} · OCR ${
        resultat.ocrRejects
      } rejet(s) · ${resultat.coutEur.toFixed(4)} €`
    )
  }

  ecrisRapport(resultats)
  console.log(`\nGrand livre session 6 : ${spentEur().toFixed(4)} € / ${CAP_EUR.toFixed(2)} €`)
  console.log(`Rapport : ${join(SORTIE, 'e3-rapport.md')}`)
  console.log('Planche comparative : bun run scripts/calibration/planche-e3.ts')
}

/**
 * Décale la version courante d'un brief en `*-vN` avant d'écrire la suivante.
 * N est le premier libre : on ne perd jamais un rendu déjà payé, et la planche
 * peut afficher AVANT / APRÈS sans intervention manuelle.
 */
export function archivePrecedent(dossier: string): number | null {
  const courant = join(dossier, 'candidate.png')
  if (!existsSync(courant)) return null
  let n = 1
  while (existsSync(join(dossier, `candidate-v${n}.png`))) n += 1
  for (const [nom, ext] of [
    ['candidate', 'png'],
    ['prompt', 'txt'],
    ['resultat', 'json'],
  ] as const) {
    const src = join(dossier, `${nom}.${ext}`)
    if (existsSync(src)) renameSync(src, join(dossier, `${nom}-v${n}.${ext}`))
  }
  return n
}

/** Un relevé est MESURÉ s'il porte un verdict d'instrument. Le champ
 *  `mesurable` date du 17/08 : un relevé antérieur ne l'a pas, et l'absence du
 *  champ ne doit pas transformer une mesure réussie en échec. */
function estMesuree(c: CompositionMesure): boolean {
  return c.mesurable ?? c.verdict !== 'non_mesure'
}

function ecrisRapport(nouveaux: ResultatE3[]) {
  // Un rejeu partiel (--briefs) ne doit pas effacer les briefs qu'il n'a pas
  // rejoués : le rapport FUSIONNE, et l'ordre reste celui de BRIEFS_E3.
  const chemin = join(SORTIE, 'e3-rapport.json')
  const anciens: ResultatE3[] = existsSync(chemin)
    ? ((JSON.parse(readFileSync(chemin, 'utf-8')) as { resultats?: ResultatE3[] }).resultats ?? [])
    : []
  const parBrief = new Map(anciens.map((r) => [r.brief, r]))
  for (const r of nouveaux) parBrief.set(r.brief, r)
  const resultats = BRIEFS_E3.map((b) => parBrief.get(b.id)).filter((r): r is ResultatE3 => Boolean(r))

  writeFileSync(
    chemin,
    JSON.stringify({ experience: 'E3 — 1 concept × 5 briefs', lance_le: new Date().toISOString(), resolution, rejoues: nouveaux.map((r) => r.brief), resultats, coutSessionEur: spentEur() }, null, 2)
  )
  // Un candidat NON MESURÉ ne compte ni au numérateur ni au dénominateur : il
  // n'est ni validé ni recalé, et le noyer dans le total mentirait deux fois.
  // `mesurable` n'existe que depuis la correction du 17/08 : un relevé plus
  // ancien est mesuré dès qu'il porte un verdict.
  // PIVOT IDIOME : un `non_applicable` (HERO_MONOGRAM et compagnie) sort AUSSI
  // du dénominateur. Il ne peut pas passer un seuil qui n'existe pas ; l'y
  // compter ferait chuter le ratio à chaque monogramme, c'est-à-dire à chaque
  // fois que le moteur vise juste.
  const mesures = resultats.filter(
    (r) => r.composition && estMesuree(r.composition) && r.composition.verdict !== 'non_applicable'
  )
  const nonMesures = resultats.filter((r) => r.composition && !estMesuree(r.composition))
  const nonApplicables = resultats.filter((r) => r.composition?.verdict === 'non_applicable')
  const passages = mesures.filter((r) => r.composition!.verdict === 'passage').length
  const md = [
    `# E3 — 1 concept × 5 briefs (${new Date().toISOString().slice(0, 10)})`,
    '',
    'Overlap mesuré sur le RENDU, au seuil de son archétype (patch P1).',
    'Débordement mesuré sur le BLOCKOUT, donc sur l\'INTENTION du DA — pas sur le rendu.',
    '',
    '⚠ PIVOT IDIOME (17/08) : sur HERO_MONOGRAM, devenu l\'archétype par défaut, l\'overlap',
    'est `non_applicable` — la lettre EST l\'emblème, il n\'y a rien à recouvrir. Une colonne',
    'vide sur cette ligne n\'est donc PAS un échec, et un chiffre n\'y serait pas une note.',
    '',
    '| brief | archétype | famille de rendu | overlap | seuil | verdict | débordement (blockout) | OCR | coût |',
    '|---|---|---|---|---|---|---|---|---|',
    ...resultats.map(
      (r) =>
        `| ${r.brief} | ${r.archetype} | ${r.famille_rendu ?? '—'} | ${
          r.composition && estMesuree(r.composition) ? r.composition.overlapRatio.toFixed(3) : '—'
        } | ${r.composition?.seuil ?? 'n/a'} | ${r.composition?.verdict ?? 'non applicable'} | ${
          r.debordementBlockout === null ? 'n/a' : r.debordementBlockout.toFixed(3)
        } | ${r.ocrRejects} | ${r.coutEur.toFixed(4)} € |`
    ),
    '',
    `**${passages}/${mesures.length}** candidats mesurés passent le seuil de leur archétype.`,
    ...(nonApplicables.length
      ? [
          '',
          `${nonApplicables.length} candidat(s) hors barème d'overlap (${nonApplicables
            .map((r) => `${r.brief} · ${r.archetype}`)
            .join(', ')}) : archétype sans emblème séparé du lettrage. Rien à mesurer, rien à conclure — la planche décide.`,
        ]
      : []),
    ...(nonMesures.length
      ? [
          '',
          `⚠ **${nonMesures.length} candidat(s) NON MESURÉ(S)** (${nonMesures
            .map((r) => r.brief)
            .join(', ')}) : l'instrument n'a rien pu lire après 3 essais. Ni validés ni recalés — à remesurer (\`--remesure\`).`,
        ]
      : []),
    '',
    '## Ce que chaque brief cassait',
    '',
    ...resultats.map((r) => `- **${r.brief}** (${r.nom}) — ${r.stress}`),
    '',
    '> La porte de livraison reste l\'opérateur, sur planche. L\'overlap retire une famille',
    '> d\'échecs ; il n\'annonce pas un bon logo.',
    '',
    `Coût session 6 : ${spentEur().toFixed(4)} € / ${CAP_EUR.toFixed(2)} €`,
  ].join('\n')
  writeFileSync(join(SORTIE, 'e3-rapport.md'), md)
}

// ── REMESURE — rejouer l'instrument sur une image DÉJÀ payée ────────────────
// Un échec de mesure ne justifie pas de repayer une image : le candidat est sur
// le disque. ~0,001 € par sujet.

async function remesure() {
  console.log(`\n═══ E3 — REMESURE (${briefs.length} candidat(s), aucune image générée)\n`)
  const resultats: ResultatE3[] = []
  for (const b of briefs) {
    const dossier = join(SORTIE, b.id)
    const fichier = join(dossier, 'candidate.png')
    const chemin = join(dossier, 'resultat.json')
    if (!existsSync(fichier) || !existsSync(chemin)) {
      console.log(`  ${b.id.padEnd(11)} aucun rendu sur le disque — ignoré`)
      continue
    }
    const precedent = JSON.parse(readFileSync(chemin, 'utf-8')) as ResultatE3
    if (precedent.archetype === ARCHETYPE_SANS_LETTRAGE) {
      console.log(`  ${b.id.padEnd(11)} sans lettrage — rien à mesurer`)
      continue
    }
    const avant = spentEur()
    const composition = await mesureComposition({
      png: readFileSync(fichier),
      label: `e3_remesure_${b.id}`,
      archetype: precedent.archetype,
    })
    const resultat: ResultatE3 = {
      ...precedent,
      composition,
      coutEur: Math.round((precedent.coutEur + (spentEur() - avant)) * 10000) / 10000,
    }
    writeFileSync(chemin, JSON.stringify(resultat, null, 2))
    resultats.push(resultat)
    console.log(
      `  ${b.id.padEnd(11)} overlap ${composition.mesurable ? composition.overlapRatio.toFixed(3) : '  —  '} ${
        composition.verdict
      } [${composition.essais} essai(s)] ${composition.note.slice(0, 90)}`
    )
  }
  if (resultats.length) ecrisRapport(resultats)
  console.log(`\nGrand livre session 6 : ${spentEur().toFixed(4)} € / ${CAP_EUR.toFixed(2)} €`)
}

/** Reconstruit rapport et prompts depuis le disque — zéro appel. Utile après
 *  une correction de présentation : les mesures sont déjà payées. */
function rapportSeul() {
  const resultats: ResultatE3[] = []
  for (const b of BRIEFS_E3) {
    const chemin = join(SORTIE, b.id, 'resultat.json')
    if (existsSync(chemin)) resultats.push(JSON.parse(readFileSync(chemin, 'utf-8')) as ResultatE3)
  }
  if (!resultats.length) throw new Error('aucun resultat.json sur le disque')
  ecrisRapport(resultats)
  ecrisPrompts()
  console.log(`Rapport reconstruit depuis ${resultats.length} relevé(s) : ${join(SORTIE, 'e3-rapport.md')}`)
}

// ── entrée ───────────────────────────────────────────────────────────────────

async function main() {
  if (phaseConcepts && phaseRender) throw new Error('--concepts et --render se jouent séparément : l\'opérateur lit les prompts entre les deux')
  if (phaseConcepts) return phase1()
  if (phaseRender) return phase2()
  if (args.includes('--remesure')) return remesure()
  if (args.includes('--rapport')) return rapportSeul()
  afficherPlan()
}

main().catch((err) => {
  console.error('\nE3 interrompu :', (err as Error).message)
  process.exit(1)
})
