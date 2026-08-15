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
}): ExemplarSelection {
  const { category, da } = opts
  const energie = opts.energie ?? 50
  const modernite = opts.modernite ?? 50
  const maxPrompts = opts.maxPrompts ?? 2
  const maxReferences = opts.maxReferences ?? 3

  const { entries, prompts, images } = loadCategory(category)
  if (!entries.length) throw new TrainingRequiredError(`exemplaires ${category} absents`)

  const ranked = [...entries].sort(
    (a, b) => scoreEntry(b, da, energie, modernite) - scoreEntry(a, da, energie, modernite)
  )

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
    if (reversePrompts.length < maxPrompts && prompt) {
      reversePrompts.push(prompt)
      if (entry.priorite === 'humaine') humanPicked += 1
    }
    const image = images.get(entry.slug)
    if (references.length < maxReferences && image) references.push(image)
    slugs.push(entry.slug)
  }

  return { reversePrompts, references, slugs: slugs.slice(0, Math.max(maxPrompts, maxReferences)) }
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
