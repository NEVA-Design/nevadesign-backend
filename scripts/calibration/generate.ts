/*
 * Run 5.6 — génération d'UN candidat de calibration.
 *
 * Le runner reproduit fidèlement l'étape A de production (director → compile
 * → OCR gate → critique). Les variables d'expérience du run 5.5 (présentation
 * corpus, langue vector, bloc références) ont été PERSISTÉES au compilateur —
 * elles ne sont plus des options ici. Les variables du run 5.6 :
 *   - famille: choisir le concept d'une famille de rendu précise du trio DA
 *     (plat_premium | semi_flat_biseau | dimensionnelle) — le gabarit 5.6
 *     impose 3 familles distinctes par trio ;
 *   - fondImpose: imposer la famille de FOND (motif | scene | texture) à la
 *     section 2bis des concepts (variable H1 et suivantes) ;
 *   - extra: un bloc additif nommé et VERSIONNÉ du registre EXTRA_BLOCKS —
 *     une hypothèse = un bloc, persisté dans ce fichier, jamais un texte
 *     libre passé en CLI.
 *
 * Les concepts du DA sont mis en cache par brief + fond imposé
 * (concepts-<brief>[-<fond>].json) : les itérations qui testent une variable
 * en aval réutilisent LE MÊME concept — une seule variable change.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { artDirectionForProject } from '../../src/lib/engine/mapping'
import { directLogoConcepts, MAX_PROMPT_INTEGRAL_MOTS, type LogoConcept, type LogoFamilleRendu } from '../../src/lib/engine/logo-director'
import { pickExemplars, pickExemplarsEtiquetes, styleQueryForMatiere } from '../../src/lib/engine/exemplars'
import { generateLogoProposition } from '../../src/lib/engine/logo-pipeline'
import { generateLogoIntegral } from '../../src/lib/engine/logo-integral'
import { type ConceptVerdict } from '../../src/lib/engine/logo-critic'
import { requireTraining } from '../../src/lib/engine/adn'
import { CALIBRATION_DIR, setBudgetLabel } from './budget5'
import type { CalibrationBrief } from './briefs'

const CALIBRATION_USER = 'calibration-run5.10'

// Marqueur de format du cache de concepts INTÉGRAL — le piège du 5.9 (« cache
// concepts jamais re-validé ») ne doit pas revenir : un cache d'un autre
// gabarit est refusé net, jamais exécuté en silence.
const CONCEPTS_FORMAT_INTEGRAL = 'integral-510'

// ── Le registre des blocs d'hypothèse — une variable = un bloc versionné ─────
export const EXTRA_BLOCKS: Record<string, { version: string; text: string }> = {
  // H2 (run 5.6) : l'exécution PLAT PREMIUM — les deux candidats H1 sortaient
  // en « sticker mascotte » (fills plats mono-dégradé, font arrondie stock,
  // contour autocollant unique autour du lockup entier, dauphin perché).
  // La famille plate du corpus (Fruitz, S palm, hublife, welllogo) : lettres
  // custom à coupes franches, fills satin étagés, contour qui épouse CHAQUE
  // silhouette, emblème fusionné.
  'plat-premium-v1': {
    version: 'plat-premium-v1 (2026-08-16)',
    text:
      'FLAT PREMIUM EXECUTION — THIS IS NOT A STICKER: the letterforms are CUSTOM-CUT (deliberate chamfers, sharp cuts, italic tension — never a stock rounded cartoon font). Fills are SATIN AND LAYERED: 2-3 close tonal steps per shape with a subtle inner shading pass and a light grain — premium flatness, never one plain gradient. The thick outline HUGS EACH ELEMENT\'S own silhouette (letters, emblem) separately — never one fat sticker border around the whole lockup. The emblem stays FUSED with the lettering (replacing or crossing a letter), never perched above it like a mascot badge.',
  },
  // H6 (run 5.6) : iter10 fruitz dimensionnelle — « uniform high-gloss candy
  // coating » : le candy gloss revient dans SA cellule d'origine (fruit/été +
  // dimensionnelle). Exécution dimensionnelle SATIN : faces biseautées mates,
  // accents métalliques d'arête, UN specular max — jamais un vernis.
  'dim-satin-v1': {
    version: 'dim-satin-v1 (2026-08-16)',
    text:
      'DIMENSIONAL EXECUTION — SATIN, NEVER CANDY: the bevels and extrusions read as SATIN/MATTE surfaces (soft velvet falloff on every face), with the metal reserved for thin EDGE accents (chamfer lines, kickers). At most ONE controlled specular highlight per element, placed on an edge — never a wet candy/gel/glass coat over the letter faces, never a horizontal gloss sweep across the whole wordmark. Depth comes from shading and edge light, not from shine.',
  },
  // H3 (run 5.6) : iter5 azure — dernier défaut nommé « uniform glossy vector
  // gradient with harsh white highlight streaks » : le brillant plein-lettre
  // revient sur le sujet océan. v2 = v1 + extinction des streaks.
  'plat-premium-v2': {
    version: 'plat-premium-v2 (2026-08-16, gloss kill sur les aplats)',
    text:
      'FLAT PREMIUM EXECUTION — THIS IS NOT A STICKER: the letterforms are CUSTOM-CUT (deliberate chamfers, sharp cuts, italic tension — never a stock rounded cartoon font). Fills are SATIN AND LAYERED: 2-3 close tonal steps per shape with a subtle inner shading pass and a light grain — premium flatness, never one plain gradient. GLOSS KILL ON FLATS: no white glare streaks, no glossy sweeps, no wet highlights across letterforms — light lives in the tonal steps themselves, with at most ONE thin satin edge accent per letter. The thick outline HUGS EACH ELEMENT\'S own silhouette (letters, emblem) separately — never one fat sticker border around the whole lockup. The emblem stays FUSED with the lettering (replacing or crossing a letter), never perched above it like a mascot badge.',
  },
}

export type FondImpose = 'motif' | 'scene' | 'texture'

export type RunOptions = {
  brief: CalibrationBrief
  label: string
  resolution: '1K' | '2K'
  famille?: LogoFamilleRendu
  fondImpose?: FondImpose
  extra?: string
  criticRegen: boolean
  /** run 5.10 : true (défaut) = rendu INTÉGRAL (1 appel image, prompt minimal
   *  du DA + réfs étiquetées) ; false = pipeline calques 5.9 (comparaison) */
  integral?: boolean
  /** run 5.9 : false = lockup libre 5.8 (variante de comparaison) */
  lockupBase?: boolean
  conceptIndex?: number
  freshConcepts?: boolean
}

export type CandidateResult = {
  png: Buffer
  /** run 5.10 : NULL en mode intégral — l'alpha est dérivé à la sélection
   *  (isolation + détourage décontaminé), plus jamais par calques */
  alphaPng: Buffer | null
  fondPng: Buffer | null
  lockupPng: Buffer | null
  emblemePng: Buffer | null
  prompt: string
  concept: LogoConcept
  conceptIndex: number
  conceptSource: 'cache' | 'fresh'
  /** run 5.10 : 'integral' | 'fallback_calques' | 'calques' (mode --calques) */
  mode: 'integral' | 'fallback_calques' | 'calques'
  promptIntegral: string | null
  promptRegen: string | null
  ocrRejects: number
  critic: ConceptVerdict
  regenere: boolean
  calqueRegenere: 'fond' | 'lockup' | 'embleme' | null
  modeLockup: boolean
  lockupBaseUtilisee: boolean
  fallbackLettrageLocal: boolean
  promptsCalques: Partial<Record<string, string>>
  referencesSlugs: string[]
  extraVersion: string | null
}

function conceptsCachePath(briefId: string, fondImpose: FondImpose | undefined, integral: boolean): string {
  return join(CALIBRATION_DIR, `concepts-${briefId}${integral ? '-integral' : ''}${fondImpose ? `-${fondImpose}` : ''}.json`)
}

function dataUrlToPng(dataUrl: string): Buffer {
  return Buffer.from(dataUrl.split(',').pop() ?? '', 'base64')
}

export async function generateCandidate(opts: RunOptions): Promise<CandidateResult> {
  requireTraining()
  mkdirSync(CALIBRATION_DIR, { recursive: true })
  setBudgetLabel(opts.label)

  const { brief } = opts
  const { da, energie, modernite } = artDirectionForProject(brief.project)
  const log = { userId: CALIBRATION_USER, projectId: null, assetId: null }

  // Le bloc extra se valide AVANT tout appel payant — une typo de registre ne
  // doit pas coûter une génération de concepts.
  const extra = opts.extra ? EXTRA_BLOCKS[opts.extra] : undefined
  if (opts.extra && !extra) throw new Error(`bloc extra inconnu : ${opts.extra} (registre : ${Object.keys(EXTRA_BLOCKS).join(', ') || 'vide'})`)

  // ── Concepts du DA : cache par brief+fond pour isoler les variables aval ──
  // Run 5.10 : le cache intégral vit dans SON fichier (concepts-…-integral)
  // avec un marqueur de format — un cache d'un autre gabarit est refusé net.
  const integral = opts.integral ?? true
  let concepts: LogoConcept[]
  let conceptSource: 'cache' | 'fresh'
  const cachePath = conceptsCachePath(brief.id, opts.fondImpose, integral)
  if (!opts.freshConcepts && existsSync(cachePath)) {
    const cacheRaw = JSON.parse(readFileSync(cachePath, 'utf-8')) as { format?: string; concepts: LogoConcept[] }
    concepts = cacheRaw.concepts
    conceptSource = 'cache'
    if (integral) {
      if (cacheRaw.format !== CONCEPTS_FORMAT_INTEGRAL) {
        throw new Error(`cache ${cachePath} sans marqueur ${CONCEPTS_FORMAT_INTEGRAL} — relance avec --fresh-concepts (pivot 5.10)`)
      }
      const trop = concepts.find((c) => c.prompt.trim().split(/\s+/).length > MAX_PROMPT_INTEGRAL_MOTS)
      if (trop) {
        throw new Error(`cache ${cachePath} : le concept « ${trop.nom} » dépasse ${MAX_PROMPT_INTEGRAL_MOTS} mots — cache d'avant le plafond dur, relance avec --fresh-concepts`)
      }
    }
    // Un cache au format 5.5 (concepts sans famille) partirait en génération
    // payante condamnée d'avance. On refuse QUEL QUE SOIT le mode.
    if (concepts.some((c) => !c.famille)) {
      throw new Error(`cache ${cachePath} au format 5.5 (concepts sans famille) — relance avec --fresh-concepts`)
    }
    // Run 5.7 : un cache sans recette de calques est inutilisable (fallback).
    if (concepts.some((c) => !c.calques)) {
      throw new Error(`cache ${cachePath} au format 5.6 (concepts sans recette calques) — relance avec --fresh-concepts`)
    }
    // Run 5.8 : un brief avec lettrage exige la recette lockup fusionné.
    if (brief.answers.type !== 'embleme' && concepts.some((c) => !c.calques.lockup)) {
      throw new Error(`cache ${cachePath} au format 5.7 (concepts sans calques.lockup) — relance avec --fresh-concepts`)
    }
  } else {
    const direction = await directLogoConcepts({
      project: brief.project,
      da,
      answers: brief.answers,
      energie,
      modernite,
      fondImpose: opts.fondImpose,
      log,
    })
    concepts = direction.concepts
    conceptSource = 'fresh'
    writeFileSync(
      cachePath,
      JSON.stringify(
        { format: integral ? CONCEPTS_FORMAT_INTEGRAL : undefined, genere_le: new Date().toISOString(), brief: brief.id, fondImpose: opts.fondImpose ?? null, concepts },
        null,
        2
      )
    )
  }

  // Sélection du concept : par FAMILLE de rendu (5.6) > index explicite > 1er.
  let conceptIndex: number
  if (opts.famille) {
    conceptIndex = concepts.findIndex((c) => c.famille === opts.famille)
    if (conceptIndex < 0) {
      throw new Error(
        `aucun concept de famille "${opts.famille}" dans ${cachePath} (familles présentes : ${concepts.map((c) => c.famille ?? '?').join(', ')}) — relance avec --fresh-concepts (gabarit 5.6)`
      )
    }
  } else {
    conceptIndex = opts.conceptIndex ?? 0
  }
  const concept = concepts[conceptIndex]
  if (!concept) throw new Error(`concept ${conceptIndex} introuvable (${concepts.length} en cache)`)

  // Références jointes — sélection déterministe de production (run 5.8) :
  // fond = 2 images cluster ; marque = 3 images de la MÊME famille de rendu
  // que le concept, lettrage travaillé privilégié.
  const exemplarsFond = pickExemplars({ category: 'logo', da, energie, modernite, maxPrompts: 0, maxReferences: 2 })
  // Run 5.9 (chantier 1) : la matière du brief pilote la sélection de style.
  const styleQuery = styleQueryForMatiere(brief.answers.matiere)
  const exemplarsMarque = pickExemplars({
    category: 'logo',
    da,
    energie,
    modernite,
    maxPrompts: 0,
    maxReferences: 3,
    famille: concept.famille,
    prefereLettrage: true,
    traitements: styleQuery.traitements,
    matiereMotsCles: styleQuery.matiereMotsCles,
  })

  // ── Run 5.10 : le candidat sort du chemin de PRODUCTION ────────────────────
  // intégral (défaut) : UN appel image — prompt minimal du DA + 3 réfs HQ
  // étiquetées, porte OCR glyphe, critique éliminatoire, une régénération
  // intégrale max, fallback calques si l'orthographe casse.
  if (integral) {
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
    const proposition = await generateLogoIntegral({
      projectName: brief.project.name,
      answers: brief.answers,
      concept,
      references: etiquetees,
      fallbackReferences: { fond: exemplarsFond.references, marque: exemplarsMarque.references },
      resolution: opts.resolution,
      extraBlock: extra?.text,
      criticRegen: opts.criticRegen,
      log: { ...log, kind: `calibration_${opts.label}` },
    })
    const fb = proposition.fallback
    return {
      png: dataUrlToPng(proposition.dataUrl),
      alphaPng: fb ? dataUrlToPng(fb.layers.alphaDataUrl) : null,
      fondPng: fb?.layers.fondDataUrl ? dataUrlToPng(fb.layers.fondDataUrl) : null,
      lockupPng: fb?.layers.lockupDataUrl ? dataUrlToPng(fb.layers.lockupDataUrl) : null,
      emblemePng: fb?.layers.emblemeDataUrl ? dataUrlToPng(fb.layers.emblemeDataUrl) : null,
      prompt: concept.prompt,
      concept,
      conceptIndex,
      conceptSource,
      mode: proposition.mode,
      promptIntegral: proposition.promptIntegral,
      promptRegen: proposition.promptRegen,
      ocrRejects: proposition.ocrRejects,
      critic: proposition.verdict,
      regenere: proposition.regenere,
      calqueRegenere: fb?.calqueRegenere ?? null,
      modeLockup: fb?.modeLockup ?? false,
      lockupBaseUtilisee: fb?.lockupBaseUtilisee ?? false,
      fallbackLettrageLocal: fb?.fallbackLettrageLocal ?? false,
      promptsCalques: fb?.promptsCalques ?? {},
      referencesSlugs: proposition.referencesEtiquetees,
      extraVersion: extra?.version ?? null,
    }
  }

  // --calques : le pipeline superposé 5.9, gardé comme variante de comparaison.
  const proposition = await generateLogoProposition({
    projectName: brief.project.name,
    answers: brief.answers,
    concept,
    references: { fond: exemplarsFond.references, marque: exemplarsMarque.references },
    resolution: opts.resolution,
    extraBlock: extra?.text,
    criticRegen: opts.criticRegen,
    lockupBase: opts.lockupBase,
    log: { ...log, kind: `calibration_${opts.label}` },
  })

  return {
    png: dataUrlToPng(proposition.dataUrl),
    alphaPng: dataUrlToPng(proposition.layers.alphaDataUrl),
    fondPng: proposition.layers.fondDataUrl ? dataUrlToPng(proposition.layers.fondDataUrl) : null,
    lockupPng: proposition.layers.lockupDataUrl ? dataUrlToPng(proposition.layers.lockupDataUrl) : null,
    emblemePng: proposition.layers.emblemeDataUrl ? dataUrlToPng(proposition.layers.emblemeDataUrl) : null,
    prompt: concept.prompt,
    concept,
    conceptIndex,
    conceptSource,
    mode: 'calques',
    promptIntegral: null,
    promptRegen: null,
    ocrRejects: proposition.ocrRejects,
    critic: proposition.verdict,
    regenere: proposition.regenere,
    calqueRegenere: proposition.calqueRegenere,
    modeLockup: proposition.modeLockup,
    lockupBaseUtilisee: proposition.lockupBaseUtilisee,
    fallbackLettrageLocal: proposition.fallbackLettrageLocal,
    promptsCalques: proposition.promptsCalques,
    referencesSlugs: [...exemplarsMarque.slugs, ...exemplarsFond.slugs.filter((s) => !exemplarsMarque.slugs.includes(s))],
    extraVersion: extra?.version ?? null,
  }
}

// ── Dérivation de la version alpha — run 5.7 : GRATUITE et locale ────────────
// L'ancienne « seconde passe » (reproduction API sur #F2F2F2, 5.5) est
// supprimée : la pile fournit déjà lettrage+emblème sans le fond.
export const DERIVE_ALPHA_VERSION = 'derive-alpha-v2 (2026-08-16, locale par calques — zéro appel)'
