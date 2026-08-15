import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import type { ArtDirection } from './mapping'

// ── Sélection des exemplaires d'entraînement (run 5.2, LOT 1) ────────────────
// Le compilateur est few-shot : chaque génération embarque 1-2 reverse-prompts
// exemplaires de sa catégorie comme gabarits de structure, et 2-3 images de
// référence JOINTES à l'appel. La sélection se fait ici, par recouvrement des
// tags de cluster du mapping puis proximité énergie/modernité.
// Les fichiers viennent de scripts/train-fivem-v2.ts (lancé par le client) ;
// tant qu'il n'a pas tourné, tout retourne vide et le compilateur dégrade
// proprement (prompt sans few-shot, appel sans référence).

const EXEMPLARS_DIR = resolve(import.meta.dir, '../../engine/exemplars/fivem')

export type ExemplarEntry = {
  slug: string
  tags: string[]
  energie: number
  modernite: number
  couleurs: string[]
}

type Manifest = { exemplaires: ExemplarEntry[] }

type CategoryCache = {
  entries: ExemplarEntry[]
  prompts: Map<string, string>
  images: Map<string, { data: string; mimeType: string }>
}

const cache = new Map<string, CategoryCache>()

function loadCategory(category: string): CategoryCache {
  const cached = cache.get(category)
  if (cached) return cached

  const dir = join(EXEMPLARS_DIR, category)
  const manifestPath = join(dir, '_manifest.json')
  const result: CategoryCache = { entries: [], prompts: new Map(), images: new Map() }

  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest
      for (const entry of manifest.exemplaires ?? []) {
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
      console.warn(`[exemplars] manifest illisible (${category}) :`, (error as Error).message)
    }
  }

  cache.set(category, result)
  return result
}

export function invalidateExemplarsCache() {
  cache.clear()
}

function scoreEntry(entry: ExemplarEntry, da: ArtDirection, energie: number, modernite: number): number {
  const tagOverlap = entry.tags.filter((t) => da.clusterTags.includes(t)).length
  // le recouvrement de cluster domine ; l'écart énergie/modernité départage
  const distance = Math.abs(entry.energie - energie) + Math.abs(entry.modernite - modernite)
  return tagOverlap * 1000 - distance
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
  if (!entries.length) return { reversePrompts: [], references: [], slugs: [] }

  const ranked = [...entries].sort(
    (a, b) => scoreEntry(b, da, energie, modernite) - scoreEntry(a, da, energie, modernite)
  )

  const slugs: string[] = []
  const reversePrompts: string[] = []
  const references: Array<{ data: string; mimeType: string }> = []

  for (const entry of ranked) {
    if (references.length >= maxReferences && reversePrompts.length >= maxPrompts) break
    const prompt = prompts.get(entry.slug)
    if (reversePrompts.length < maxPrompts && prompt) reversePrompts.push(prompt)
    const image = images.get(entry.slug)
    if (references.length < maxReferences && image) references.push(image)
    slugs.push(entry.slug)
  }

  return { reversePrompts, references, slugs: slugs.slice(0, Math.max(maxPrompts, maxReferences)) }
}
