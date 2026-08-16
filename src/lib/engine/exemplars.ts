import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { TrainingRequiredError } from './adn'
import type { ArtDirection } from './mapping'

// ── Sélection des exemplaires d'entraînement (run 5.2 → 5.4) ─────────────────
// Le compilateur est few-shot : chaque génération embarque 1-2 reverse-prompts
// exemplaires de sa catégorie comme gabarits de structure, et 2-3 images de
// référence JOINTES à l'appel. La sélection se fait ici, par recouvrement des
// tags de cluster du mapping puis proximité énergie/modernité.
// Les fichiers viennent de scripts/train-fivem-v4.ts (lancé par le client).
// Run 5.4, LOT 0 : le mode dégradé est SUPPRIMÉ — une catégorie sans
// exemplaires installés JETTE TrainingRequiredError, aucun chemin ne compile
// un prompt sans few-shot ni référence.

const EXEMPLARS_DIR = resolve(import.meta.dir, '../../engine/exemplars/fivem')

// Les 3 familles de rendu mesurées — dupliquées ici en type local pour ne pas
// créer de cycle d'import avec logo-director.ts (qui importe ce module).
export type ExemplarFamille = 'plat_premium' | 'semi_flat_biseau' | 'dimensionnelle'

export type ExemplarEntry = {
  slug: string
  tags: string[]
  energie: number
  modernite: number
  couleurs: string[]
  // run 5.3 : 'humaine' = recette écrite par le client (fichiers .txt du
  // dossier d'entraînement) — passe TOUJOURS avant les reverse-prompts
  priorite?: 'humaine' | 'reverse'
  // description de la typographie générée (manifest v2/v3) — sert aux notes
  // de référence transmises au directeur artistique logo
  typographie_generee?: string
  // run 5.8 : famille de rendu (scripts/classify-familles-exemplars.ts) —
  // le filtre garantit que les références jointes montrent la MÊME famille
  // que le concept, sinon le transfert de style est faible.
  famille?: ExemplarFamille
  // run 5.8 : l'exemplaire montre un lettrage travaillé — privilégié pour le
  // lockup fusionné (c'est le traitement typographique qu'on transfère)
  lettrage_riche?: boolean
  // run 5.9 : côté long de l'IMAGE SOURCE (recompile-exemplars-hq.ts).
  // L'audit du chantier 0 a montré que 25 exemplaires sont des vignettes
  // Discord 96-128 px : jointes en référence, le modèle imitait des pâtés de
  // pixels (candy gloss, sticker, fond délavé). En dessous de ce plancher,
  // l'exemplaire reste dans le corpus (reverse-prompts, notes, ADN) mais son
  // IMAGE n'est plus jamais jointe à une génération.
  resolution_native?: number
  // run 5.9 : étiquettes de style écrites par label-exemplars.ts (vision
  // raisonnement haut sur les images recompilées HQ)
  style?: {
    famille?: ExemplarFamille
    traitement_lettrage?: string
    matiere?: string
    embleme?: { present: boolean; type: string | null }
    ambiance?: string
    fond_sombre?: boolean
  }
}

// Plancher de résolution pour qu'une image serve de référence de rendu.
export const MIN_REFERENCE_NATIVE_PX = 512

// Run 5.9 : matière du brief wizard → étiquettes de style recherchées dans le
// corpus (label-exemplars.ts). La sélection montre au modèle des exemplaires
// qui exécutent EXACTEMENT le traitement demandé.
export function styleQueryForMatiere(matiere: string | null | undefined): { traitements: string[]; matiereMotsCles: string[] } {
  switch (matiere) {
    case 'neon':
      return { traitements: ['neon'], matiereMotsCles: ['neon', 'glow'] }
    case 'chrome':
      return { traitements: ['chrome', 'extrusion_3d'], matiereMotsCles: ['chrome', 'metal', 'steel', 'silver', 'brushed'] }
    case 'or':
      return { traitements: ['or', 'extrusion_3d'], matiereMotsCles: ['gold', 'golden'] }
    case 'verre':
      return { traitements: ['extrusion_3d', 'chrome'], matiereMotsCles: ['glass', 'frosted', 'crystal'] }
    default:
      return { traitements: [], matiereMotsCles: [] }
  }
}

type Manifest = { exemplaires: Array<ExemplarEntry & { categories?: string[] }> }

type CategoryCache = {
  entries: ExemplarEntry[]
  prompts: Map<string, string>
  images: Map<string, { data: string; mimeType: string }>
}

const cache = new Map<string, CategoryCache>()

// Pool partagé des recettes humaines (run 5.3, LOT 3) : les .txt du dossier
// d'entraînement, parsés par train-fivem-v3.ts. Chaque recette liste les
// catégories héro où elle est éligible — elle y passe AVANT les
// reverse-prompts (boost dans scoreEntry).
const RECETTES_HUMAINES_DIR = '_recettes-humaines'

function loadManifestInto(result: CategoryCache, dir: string, filterCategory?: string) {
  const manifestPath = join(dir, '_manifest.json')
  if (!existsSync(manifestPath)) return
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest
    for (const entry of manifest.exemplaires ?? []) {
      if (filterCategory && !(entry.categories ?? []).includes(filterCategory)) continue
      const promptPath = join(dir, `${entry.slug}.txt`)
      if (!existsSync(promptPath)) continue
      result.entries.push(entry)
      result.prompts.set(entry.slug, readFileSync(promptPath, 'utf-8').trim())
      const imagePath = join(dir, `${entry.slug}.jpg`)
      if (existsSync(imagePath)) {
        result.images.set(entry.slug, {
          data: readFileSync(imagePath).toString('base64'),
          mimeType: 'image/jpeg',
        })
      }
    }
  } catch (error) {
    console.warn(`[exemplars] manifest illisible (${dir}) :`, (error as Error).message)
  }
}

function loadCategory(category: string): CategoryCache {
  const cached = cache.get(category)
  if (cached) return cached

  const result: CategoryCache = { entries: [], prompts: new Map(), images: new Map() }
  loadManifestInto(result, join(EXEMPLARS_DIR, category))
  // recettes humaines éligibles à cette catégorie — prompts sans images
  loadManifestInto(result, join(EXEMPLARS_DIR, RECETTES_HUMAINES_DIR), category)

  cache.set(category, result)
  return result
}

export function invalidateExemplarsCache() {
  cache.clear()
}

function scoreEntry(entry: ExemplarEntry, da: ArtDirection, energie: number, modernite: number): number {
  const tagOverlap = entry.tags.filter((t) => da.clusterTags.includes(t)).length
  // le recouvrement de cluster domine ; l'écart énergie/modernité départage.
  // Run 5.3 : les recettes humaines (validées par le client) passent AVANT
  // tout reverse-prompt, à recouvrement de cluster égal ou non.
  const distance = Math.abs(entry.energie - energie) + Math.abs(entry.modernite - modernite)
  const humanBoost = entry.priorite === 'humaine' ? 1_000_000 : 0
  return humanBoost + tagOverlap * 1000 - distance
}

export type ExemplarSelection = {
  // reverse-prompts gabarits, du plus pertinent au moins pertinent
  reversePrompts: string[]
  // images de référence à joindre à l'appel de génération
  references: Array<{ data: string; mimeType: string }>
  // slugs retenus — cités dans compiled_prompts pour la traçabilité
  slugs: string[]
}

export function pickExemplars(opts: {
  category: string
  da: ArtDirection
  energie?: number
  modernite?: number
  maxPrompts?: number
  maxReferences?: number
  /** run 5.8 : ne joindre que des références de CETTE famille de rendu
   *  (complétées par les autres familles seulement si la sienne s'épuise) */
  famille?: ExemplarFamille
  /** run 5.8 (lockup) : privilégier les références au lettrage travaillé */
  prefereLettrage?: boolean
  /** run 5.9 : recouvrement de style demandé par le concept — traitements de
   *  lettrage acceptés (ex. ['chrome','extrusion_3d']) et mots-clés matière.
   *  La famille reste le filtre DUR ; le style départage dedans. */
  traitements?: string[]
  matiereMotsCles?: string[]
}): ExemplarSelection {
  const { category, da } = opts
  const energie = opts.energie ?? 50
  const modernite = opts.modernite ?? 50
  const maxPrompts = opts.maxPrompts ?? 2
  const maxReferences = opts.maxReferences ?? 3

  const { entries, prompts, images } = loadCategory(category)
  if (!entries.length) throw new TrainingRequiredError(`exemplaires ${category} absents`)

  let ranked = [...entries].sort(
    (a, b) => scoreEntry(b, da, energie, modernite) - scoreEntry(a, da, energie, modernite)
  )
  // Le filtre famille est DUR en tête de liste ; à l'intérieur d'une famille,
  // le recouvrement de style (traitement du lettrage, matière) passe avant le
  // lettrage riche, qui reste un départage.
  if (opts.famille || opts.prefereLettrage || opts.traitements?.length || opts.matiereMotsCles?.length) {
    const styleScore = (e: ExemplarEntry): number => {
      let s = 0
      if (opts.traitements?.length && e.style?.traitement_lettrage && opts.traitements.includes(e.style.traitement_lettrage)) s += 2
      if (opts.matiereMotsCles?.length && e.style?.matiere) {
        const matiere = e.style.matiere.toLowerCase()
        if (opts.matiereMotsCles.some((m) => matiere.includes(m.toLowerCase()))) s += 1
      }
      return s
    }
    const group = (e: ExemplarEntry) =>
      (opts.famille && e.famille === opts.famille ? 0 : 100) +
      (10 - Math.min(10, styleScore(e) * 3)) +
      (opts.prefereLettrage && e.lettrage_riche ? 0 : 1)
    ranked = ranked
      .map((e, i) => ({ e, i }))
      .sort((a, b) => group(a.e) - group(b.e) || a.i - b.i)
      .map((x) => x.e)
  }

  const slugs: string[] = []
  const reversePrompts: string[] = []
  const references: Array<{ data: string; mimeType: string }> = []

  // La meilleure recette humaine ouvre le few-shot (boost de score) ; on en
  // limite UNE par sélection pour que les reverse-prompts spécifiques à la
  // catégorie (format, construction) gardent leur place.
  let humanPicked = 0
  for (const entry of ranked) {
    if (references.length >= maxReferences && reversePrompts.length >= maxPrompts) break
    if (entry.priorite === 'humaine' && humanPicked >= 1) continue
    const prompt = prompts.get(entry.slug)
    let used = false
    if (reversePrompts.length < maxPrompts && prompt) {
      reversePrompts.push(prompt)
      if (entry.priorite === 'humaine') humanPicked += 1
      used = true
    }
    // Run 5.9 : une vignette (< 512 px natif) n'est JAMAIS jointe en image —
    // l'audit du chantier 0 a prouvé qu'elle tire le rendu vers le pâté de
    // pixels. Elle garde sa place de reverse-prompt/note.
    const image = images.get(entry.slug)
    const hautRes = (entry.resolution_native ?? 0) >= MIN_REFERENCE_NATIVE_PX
    if (references.length < maxReferences && image && hautRes) {
      references.push(image)
      used = true
    }
    if (used) slugs.push(entry.slug)
  }

  return { reversePrompts, references, slugs }
}

// ── Run 5.10 (pivot rendu intégral) : références ÉTIQUETÉES ──────────────────
// Le test plafond du 5.9 (_plafond-run59/) a prouvé le format de transfert
// gagnant : références HQ jointes AVANT le texte, chacune décrite par une
// étiquette (« REFERENCE 1 — the real "fruitz" wordmark: chrome script fused
// inside a citrus slice »), prompt court. Cette sélection produit les 3-4
// références du rendu intégral avec leur étiquette construite depuis les
// étiquettes de style du manifest (label-exemplars.ts, vision sur les images
// recompilées HQ). Le plancher 512 px reste DUR : jamais de vignette jointe.

const TRAITEMENT_EN: Record<string, string> = {
  flat_outline: 'flat outlined lettering',
  extrusion_3d: '3D extruded lettering',
  chrome: 'chrome lettering',
  or: 'gold lettering',
  neon: 'neon lettering',
  script: 'script lettering',
}

const FAMILLE_EN: Record<ExemplarFamille, string> = {
  plat_premium: 'flat premium',
  semi_flat_biseau: 'semi-flat beveled',
  dimensionnelle: 'dimensional',
}

function etiquetteFor(entry: ExemplarEntry, index: number): string {
  const s = entry.style
  const morceaux: string[] = []
  const traitement = s?.traitement_lettrage ? TRAITEMENT_EN[s.traitement_lettrage] : undefined
  if (traitement) morceaux.push(traitement)
  if (s?.matiere) morceaux.push(s.matiere)
  if (s?.embleme?.present && s.embleme.type) morceaux.push(`${s.embleme.type} emblem fused with the lettering`)
  if (s?.ambiance) morceaux.push(`${s.ambiance} mood`)
  const famille = entry.famille ? `${FAMILLE_EN[entry.famille]} family` : 'target family'
  const detail = morceaux.length ? `: ${morceaux.join(', ')}` : ''
  return `REFERENCE ${index + 1} — a real logo of the ${famille}${detail} — match its production quality and finish, never its shapes or words:`
}

export type ExemplarEtiquete = { slug: string; data: string; mimeType: string; label: string }

/** Les 3-4 références HQ du rendu intégral, au plus près du concept par les
 *  étiquettes de style (famille = filtre dur, traitement/matière départagent),
 *  chacune avec son étiquette. */
export function pickExemplarsEtiquetes(opts: {
  category: string
  da: ArtDirection
  energie?: number
  modernite?: number
  famille?: ExemplarFamille
  prefereLettrage?: boolean
  traitements?: string[]
  matiereMotsCles?: string[]
  max?: number
}): ExemplarEtiquete[] {
  const energie = opts.energie ?? 50
  const modernite = opts.modernite ?? 50
  const max = Math.min(4, Math.max(1, opts.max ?? 3))
  const { entries, images } = loadCategory(opts.category)
  if (!entries.length) throw new TrainingRequiredError(`exemplaires ${opts.category} absents`)

  const styleScore = (e: ExemplarEntry): number => {
    let s = 0
    if (opts.traitements?.length && e.style?.traitement_lettrage && opts.traitements.includes(e.style.traitement_lettrage)) s += 2
    if (opts.matiereMotsCles?.length && e.style?.matiere) {
      const matiere = e.style.matiere.toLowerCase()
      if (opts.matiereMotsCles.some((m) => matiere.includes(m.toLowerCase()))) s += 1
    }
    return s
  }
  const group = (e: ExemplarEntry) =>
    (opts.famille && e.famille === opts.famille ? 0 : 100) +
    (10 - Math.min(10, styleScore(e) * 3)) +
    ((opts.prefereLettrage ?? true) && e.lettrage_riche ? 0 : 1)

  const ranked = [...entries]
    .filter((e) => (e.resolution_native ?? 0) >= MIN_REFERENCE_NATIVE_PX && images.has(e.slug))
    .map((e, i) => ({ e, score: scoreEntry(e, opts.da, energie, modernite), i }))
    .sort((a, b) => group(a.e) - group(b.e) || b.score - a.score || a.i - b.i)
    .map((x) => x.e)

  return ranked.slice(0, max).map((entry, i) => {
    const image = images.get(entry.slug)!
    return { slug: entry.slug, data: image.data, mimeType: image.mimeType, label: etiquetteFor(entry, i) }
  })
}

// Notes descriptives des meilleures références du cluster — transmises au
// directeur artistique logo (étage 1) pour qu'il sache À QUOI ressemblent
// les références qui seront jointes à la génération. Zéro image ici : que
// les métadonnées du manifest (typo générée, couleurs, tags).
export function pickExemplarNotes(opts: {
  category: string
  da: ArtDirection
  energie?: number
  modernite?: number
  max?: number
}): string[] {
  const { entries } = loadCategory(opts.category)
  if (!entries.length) throw new TrainingRequiredError(`exemplaires ${opts.category} absents`)
  const energie = opts.energie ?? 50
  const modernite = opts.modernite ?? 50
  return [...entries]
    .sort((a, b) => scoreEntry(b, opts.da, energie, modernite) - scoreEntry(a, opts.da, energie, modernite))
    .slice(0, opts.max ?? 4)
    .map((e) => {
      const typo = e.typographie_generee && e.typographie_generee !== 'none' ? ` — lettering: ${e.typographie_generee}` : ''
      const couleurs = e.couleurs.length ? ` — colors ${e.couleurs.join(', ')}` : ''
      return `${e.slug} [${e.tags.join(', ')}]${typo}${couleurs}`
    })
}
