/*
 * Run 5.5 — l'accès au corpus de référence pour le jury.
 * Les images viennent des exemplars v4 (768 px, JPEG q82) : le candidat est
 * réencodé au MÊME format avant de rejoindre un trio du test à l'aveugle,
 * pour que l'intrus ne soit pas trahi par son encodage.
 */

import { readdirSync, readFileSync, statSync } from 'fs'
import { join, resolve } from 'path'
import sharp from 'sharp'

const LOGO_EXEMPLARS_DIR = resolve(import.meta.dir, '../../src/engine/exemplars/fivem/logo')

export type CorpusImage = { slug: string; jpeg: Buffer }

// PRNG seedable (mulberry32) : itérations libres = graine horloge,
// calibration-check = graine fixe pour un tirage rejouable.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function listCorpusSlugs(): string[] {
  return readdirSync(LOGO_EXEMPLARS_DIR)
    .filter((f) => f.endsWith('.jpg'))
    .map((f) => f.replace(/\.jpg$/, ''))
    .sort()
}

// Sous-famille PREMIUM du corpus — critère MÉCANIQUE depuis les scores du
// manifest v4 : relief_3d >= 5 OU glow >= 7. C'est le pool des trios de
// l'aveugle v2 : le corpus est hétérogène (des pièces faibles y cohabitent),
// et un candidat premium tiré contre 3 pièces faibles se faisait « repérer »
// pour excès de qualité — l'inverse du but du test.
type ManifestEntry = { slug: string; scores?: { relief_3d?: number; glow?: number } }

// Planches de branding multi-cases présentes dans le dossier logo : ce sont
// des feuilles de marque, pas des logos seuls — catégorie visuelle différente,
// elles aspirent le choix « intrus » de l'aveugle. Exclues du pool (v2.1).
const GRID_BOARDS = new Set(['branding', 'group-1'])

let premiumCache: string[] | null = null
export function listPremiumSlugs(): string[] {
  if (premiumCache) return premiumCache
  const manifest = JSON.parse(readFileSync(join(LOGO_EXEMPLARS_DIR, '_manifest.json'), 'utf-8')) as {
    exemplaires: ManifestEntry[]
  }
  // v3.1 : les vignettes minuscules sortent aussi du pool — 29 exemplars sont
  // des icônes Discord < 8 Ko (floues à l'échelle du jury), elles aimantaient
  // le choix « intrus » à la place du candidat. Coupure mesurée : >= 10 Ko.
  premiumCache = manifest.exemplaires
    .filter((e) => !GRID_BOARDS.has(e.slug))
    .filter((e) => (e.scores?.relief_3d ?? 0) >= 5 || (e.scores?.glow ?? 0) >= 7)
    .filter((e) => {
      try {
        return statSync(join(LOGO_EXEMPLARS_DIR, `${e.slug}.jpg`)).size >= 10_000
      } catch {
        return false
      }
    })
    .map((e) => e.slug)
    .sort()
  return premiumCache
}

export function samplePremium(count: number, rand: () => number, exclude: string[] = []): CorpusImage[] {
  const pool = listPremiumSlugs().filter((s) => !exclude.includes(s))
  const picked: string[] = []
  while (picked.length < Math.min(count, pool.length)) {
    const idx = Math.floor(rand() * pool.length)
    const slug = pool[idx]!
    if (!picked.includes(slug)) picked.push(slug)
  }
  return picked.map(loadCorpusImage)
}

// v3.2 — trio STRATIFIÉ : la famille contient deux langues de rendu
// (dimensionnelle ~7 pièces, plate-glow ~8 pièces). Un trio homogène fait
// détonner N'IMPORTE QUEL candidat de l'autre langue (vu final-azure-1 :
// 3/3 « illustrative vs flat vector » sur trios plats). Chaque trio contient
// désormais >= 1 pièce dimensionnelle (relief >= 5) et >= 1 plate-glow —
// l'intrus se juge contre la DIVERSITÉ réelle de la famille.
function scoresFor(): Map<string, { relief: number; glow: number }> {
  const manifest = JSON.parse(readFileSync(join(LOGO_EXEMPLARS_DIR, '_manifest.json'), 'utf-8')) as {
    exemplaires: ManifestEntry[]
  }
  return new Map(manifest.exemplaires.map((e) => [e.slug, { relief: e.scores?.relief_3d ?? 0, glow: e.scores?.glow ?? 0 }]))
}

export function samplePremiumStratified(rand: () => number, exclude: string[] = []): CorpusImage[] {
  const scores = scoresFor()
  const pool = listPremiumSlugs().filter((s) => !exclude.includes(s))
  const dimensionnels = pool.filter((s) => (scores.get(s)?.relief ?? 0) >= 5)
  const flats = pool.filter((s) => (scores.get(s)?.relief ?? 0) < 5)
  const pickFrom = (list: string[], taken: string[]): string | null => {
    const avail = list.filter((s) => !taken.includes(s))
    return avail.length ? avail[Math.floor(rand() * avail.length)]! : null
  }
  const picked: string[] = []
  const dim = pickFrom(dimensionnels, picked)
  if (dim) picked.push(dim)
  const flat = pickFrom(flats, picked)
  if (flat) picked.push(flat)
  const libre = pickFrom(pool, picked)
  if (libre) picked.push(libre)
  // pool épuisé par les exclusions inter-manches : on complète depuis le pool
  // ENTIER (une répétition inter-manches vaut mieux qu'un trio incomplet)
  while (picked.length < 3) {
    const filler = pickFrom(listPremiumSlugs(), picked)
    if (!filler) break
    picked.push(filler)
  }
  return picked.map(loadCorpusImage)
}

export function loadCorpusImage(slug: string): CorpusImage {
  return { slug, jpeg: readFileSync(join(LOGO_EXEMPLARS_DIR, `${slug}.jpg`)) }
}

// ── Run 5.9 (chantier 2) : LE GOLD SET — la barre de notation ────────────────
// _gold-set.json : 5-8 pépites du corpus au niveau cible absolu, identifiées
// par vision sur les exemplaires recompilés HQ. Le jury note CONTRE CES
// PIÈCES, plus jamais contre la moyenne du corpus (le panel « médian » du 5.8
// donnait 9/10 à un sticker). Les trios de l'aveugle y puisent aussi.
// Le gold set n'exclut rien : les 59 restent des références de GÉNÉRATION.
type GoldSet = { pepites: Array<{ slug: string; famille?: string }> }

let goldCache: GoldSet | null = null
function goldSet(): GoldSet {
  if (!goldCache) {
    goldCache = JSON.parse(readFileSync(join(LOGO_EXEMPLARS_DIR, '_gold-set.json'), 'utf-8')) as GoldSet
  }
  return goldCache
}

export function goldSetImages(opts?: { max?: number; excludeGridBoards?: boolean }): CorpusImage[] {
  const pepites = goldSet().pepites.filter((p) => !opts?.excludeGridBoards || !GRID_BOARDS.has(p.slug))
  return pepites.slice(0, opts?.max ?? pepites.length).map((p) => loadCorpusImage(p.slug))
}

// Trio d'aveugle tiré du GOLD SET, stratifié par famille déclarée (>= 1
// dimensionnelle + >= 1 plate/semi). Le gold est petit (7 pièces hors
// planches) : la répétition inter-manches est acceptée quand le pool s'épuise.
export function sampleGoldStratified(rand: () => number, exclude: string[] = []): CorpusImage[] {
  const pepites = goldSet().pepites.filter((p) => !GRID_BOARDS.has(p.slug))
  const pool = pepites.filter((p) => !exclude.includes(p.slug))
  const dimensionnels = pool.filter((p) => p.famille === 'dimensionnelle')
  const autres = pool.filter((p) => p.famille !== 'dimensionnelle')
  const pickFrom = (list: Array<{ slug: string }>, taken: string[]): string | null => {
    const avail = list.filter((p) => !taken.includes(p.slug))
    return avail.length ? avail[Math.floor(rand() * avail.length)]!.slug : null
  }
  const picked: string[] = []
  const dim = pickFrom(dimensionnels, picked)
  if (dim) picked.push(dim)
  const autre = pickFrom(autres, picked)
  if (autre) picked.push(autre)
  const libre = pickFrom(pool, picked)
  if (libre) picked.push(libre)
  while (picked.length < 3) {
    const filler = pickFrom(pepites, picked)
    if (!filler) break
    picked.push(filler)
  }
  return picked.map(loadCorpusImage)
}

export function sampleCorpus(count: number, rand: () => number, exclude: string[] = []): CorpusImage[] {
  const pool = listCorpusSlugs().filter((s) => !exclude.includes(s))
  const picked: string[] = []
  while (picked.length < Math.min(count, pool.length)) {
    const idx = Math.floor(rand() * pool.length)
    const slug = pool[idx]!
    if (!picked.includes(slug)) picked.push(slug)
  }
  return picked.map(loadCorpusImage)
}

// Le candidat réencodé exactement comme un exemplar recompilé HQ (run 5.9 :
// 1024 px, JPEG q92 — recompile-exemplars-hq.ts). L'ancien 768/q82 trahirait
// l'intrus par son encodage face aux références recompilées.
export async function toCorpusEncoding(png: Buffer): Promise<Buffer> {
  return sharp(png)
    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer()
}
