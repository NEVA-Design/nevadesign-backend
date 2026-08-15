/*
 * Entraînement v4 — l'ANALYSE TOTALE du corpus (run 5.4, LOT 1).
 * Remplace train-fivem-v3.ts. Ce qui change :
 *   - 100 % des images de l'inventaire analysées (209 attendues — les 59
 *     logos inclus, fonds, personnages, bannières, affiches, icons, DA
 *     complètes). AUCUN échantillonnage : un chunk qui échoue est rejoué,
 *     puis repris image par image ; tout échec résiduel est listé au rapport.
 *   - Analyse ENRICHIE par image : construction, matériaux, éclairage, fond
 *     (avec taxonomie), effets, texture, mood, palette hex, et SCORES 0-10
 *     (relief_3d, glow, saturation, sombre_clair, complexite). Logos :
 *     lettrage (type, intégration de l'emblème, traitement du contour).
 *   - Le reverse-prompt (100-180 mots) est écrit dans l'ANATOMIE DU GABARIT
 *     MAÎTRE (LOT 2) pour les logos, et dans une structure dédiée pour la
 *     bibliothèque de fonds — exemplars et sorties du DA parlent la même langue.
 *   - Synthèse ADN CHIFFRÉE par catégorie : la clé `adn` de chaque guide v4
 *     est calculée EN CODE à partir des scores de TOUTES les images
 *     (fréquences mesurées, jamais des adjectifs).
 *   - Le dossier « background pour logo ect » devient la bibliothèque de
 *     fonds de l'étape B : taxonomie + reverse-prompts dédiés.
 *
 * Usage :  bun run scripts/train-fivem-v4.ts [--dry] [--only=<categorie>]
 *   --dry : inventaire + recettes humaines + COÛT ESTIMÉ — zéro appel API.
 *   Batch (−50 %) : documenté au rapport (prix théorique), pas câblé — le
 *   volume one-shot reste de l'ordre de ~0,5-2 €.
 */

import { readdirSync, mkdirSync, writeFileSync, statSync, readFileSync } from 'fs'
import { join, resolve, extname, relative } from 'path'
import sharp from 'sharp'
import { geminiMultimodal, type GeminiPart, type GeminiUsage } from '../src/lib/ai/gemini'
import { estimateCostEur } from '../src/lib/engine/pricing'

const SOURCE_DIR = resolve(import.meta.dir, '../../entrainement IA fivem')
const STYLES_DIR = resolve(import.meta.dir, '../src/engine/styles/fivem')
const EXEMPLARS_DIR = resolve(import.meta.dir, '../src/engine/exemplars/fivem')
const RECETTES_DIR = join(EXEMPLARS_DIR, '_recettes-humaines')
const MODEL = 'gemini-3.5-flash'
const CHUNK_SIZE = 3
const GUIDE_TOKEN_BUDGET = 900

const CLUSTER_TAGS = [
  'urbain', 'cartel', 'luxe', 'ete', 'sombre', 'chill',
  'esport', 'militaire', 'retro', 'noel', 'neutre',
] as const

const FOND_TYPES = ['degrade_doodles', 'atmospherique_sombre', 'halftone', 'scene', 'uni', 'autre'] as const

const CATEGORIES: Array<{ folder: string; id: string; focus: string }> = [
  { folder: 'affiche serveur fivem gtarp', id: 'affiche', focus: 'promotional posters (announcements, events, rules) for FiveM servers' },
  { folder: 'background pour logo ect', id: 'background_logo', focus: 'abstract/scenic backgrounds designed to host a logo on top — the step-B background library' },
  { folder: 'banniere discord serveur fivem gtarp', id: 'banniere_discord', focus: 'Discord server banners (wide header images)' },
  { folder: 'banniere fivem serveur fivem gtarp', id: 'banniere_fivem', focus: 'FiveM server-list banners (very wide strips)' },
  { folder: 'banniere menu F5 serveur fivem gtarp', id: 'banniere_f5', focus: 'in-game F5/pause-menu backgrounds' },
  { folder: 'charcter design for prompt exemple', id: 'personnage', focus: 'FiveM/GTA V character renders — how premium character art is posed, dressed, lit and finished' },
  { folder: 'exemple DA complete fivem', id: 'da_complete', focus: 'full brand identity sets — how one server keeps visual coherence across assets' },
  { folder: 'icon', id: 'icon', focus: 'small square icons/avatars for Discord and launchers' },
  { folder: 'logo serveur fivem gtarp', id: 'logo', focus: 'FiveM server logos (emblems, lettermarks, mascots)' },
]

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const TEXT_EXT = new Set(['.txt'])

const args = new Set(process.argv.slice(2))
const DRY = args.has('--dry')
const only = [...args].find((a) => a.startsWith('--only='))?.slice(7)

function log(msg: string) {
  console.log(msg)
}

// ═══ ÉTAGE A — INVENTAIRE RÉCURSIF COMPLET (identique v3, sortie v4) ═════════

type FileRecord = {
  chemin: string
  dossier: string
  type: 'image' | 'texte' | 'autre'
  extension: string
  octets: number
  dimensions?: string
  categorie: string | null
  utilise: boolean
  raison: string
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

async function buildInventory(): Promise<FileRecord[]> {
  const files = walk(SOURCE_DIR)
  const records: FileRecord[] = []
  for (const full of files) {
    const rel = relative(SOURCE_DIR, full).replaceAll('\\', '/')
    const dossier = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '(racine)'
    const ext = extname(full).toLowerCase()
    const octets = statSync(full).size
    const category = CATEGORIES.find((c) => c.folder === dossier)

    let record: FileRecord
    if (IMAGE_EXT.has(ext)) {
      let dimensions: string | undefined
      let lisible = true
      try {
        const meta = await sharp(full).metadata()
        if (meta.width && meta.height) dimensions = `${meta.width}×${meta.height}`
        else lisible = false
      } catch {
        lisible = false
      }
      record = {
        chemin: rel, dossier, type: 'image', extension: ext, octets, dimensions,
        categorie: category?.id ?? null,
        utilise: Boolean(category) && lisible,
        raison: !category
          ? 'dossier sans catégorie d’entraînement assignée'
          : lisible
            ? `analysée intégralement (catégorie ${category.id} — v4 : 100 % du corpus, zéro échantillonnage)`
            : 'image illisible par sharp — écartée',
      }
    } else if (TEXT_EXT.has(ext)) {
      record = {
        chemin: rel, dossier, type: 'texte', extension: ext, octets,
        categorie: 'recettes_humaines',
        utilise: true,
        raison: 'recette humaine — parsée en few-shot PRIORITAIRE (avant les reverse-prompts) + templates de scène (run 5)',
      }
    } else {
      const raison =
        ext === '.ini'
          ? 'fichier système Windows (desktop.ini) — aucun contenu d’entraînement'
          : ext === '.gif'
            ? 'format animé hors extensions retenues (png/jpg/webp) — la 1re frame n’apporte rien de plus que les autres logos du dossier'
            : `extension ${ext || '(aucune)'} hors périmètre d’analyse`
      record = {
        chemin: rel, dossier, type: 'autre', extension: ext, octets,
        categorie: category?.id ?? null,
        utilise: false,
        raison,
      }
    }
    records.push(record)
  }
  return records
}

function inventorySummary(records: FileRecord[]) {
  const byFolder = new Map<string, FileRecord[]>()
  for (const r of records) {
    const list = byFolder.get(r.dossier) ?? []
    list.push(r)
    byFolder.set(r.dossier, list)
  }
  return [...byFolder.entries()].map(([dossier, list]) => ({
    dossier,
    fichiers: list.length,
    images: list.filter((r) => r.type === 'image').length,
    txt: list.filter((r) => r.type === 'texte').length,
    autres: list.filter((r) => r.type === 'autre').length,
    categorie: list.find((r) => r.categorie)?.categorie ?? null,
    utilises: list.filter((r) => r.utilise).length,
    non_utilises: list.filter((r) => !r.utilise).map((r) => ({ fichier: r.chemin, raison: r.raison })),
  }))
}

// ═══ ÉTAGE B — RECETTES HUMAINES (gratuit, identique v3) ═════════════════════

function inferTags(text: string): string[] {
  const t = text.toLowerCase()
  const tags = new Set<string>()
  if (/pool|beach|swim|summer|cabana|float|sunbath|tropical/.test(t)) { tags.add('ete'); tags.add('chill') }
  if (/motorcycle|café-racer|gt-r|ferrari|mclaren|bmw|nissan|jeep|gas station|parking/.test(t)) tags.add('urbain')
  if (/luxur|penthouse|editorial|resort|villa|exclusive/.test(t)) tags.add('luxe')
  if (!tags.size) tags.add('neutre')
  return [...tags].slice(0, 3)
}

type RecetteEntry = {
  slug: string
  source: string
  tags: string[]
  energie: number
  modernite: number
  couleurs: string[]
  priorite: 'humaine'
  categories: string[]
}

function parseRecettesHumaines(records: FileRecord[]): RecetteEntry[] {
  mkdirSync(RECETTES_DIR, { recursive: true })
  const entries: RecetteEntry[] = []
  const txtFiles = records.filter((r) => r.type === 'texte')
  let index = 0
  for (const file of txtFiles) {
    const raw = readFileSync(join(SOURCE_DIR, file.chemin), 'utf-8')
    const blocks = raw.split(/^-{20,}\s*$/m).map((p) => p.trim()).filter((p) => p.length > 200)
    for (const block of blocks) {
      index += 1
      const slug = `recette-humaine-${String(index).padStart(2, '0')}`
      writeFileSync(join(RECETTES_DIR, `${slug}.txt`), block + '\n')
      entries.push({
        slug,
        source: file.chemin,
        tags: inferTags(block),
        energie: 30,
        modernite: 70,
        couleurs: [],
        priorite: 'humaine',
        categories: ['affiche', 'banniere_discord', 'banniere_f5', 'personnage'],
      })
    }
  }
  writeFileSync(
    join(RECETTES_DIR, '_manifest.json'),
    JSON.stringify({ categorie: '_recettes-humaines', genere_le: new Date().toISOString(), exemplaires: entries }, null, 2)
  )
  return entries
}

// ═══ ÉTAGE C — ANALYSE VISION TOTALE (API, lancée par le client) ═════════════

type ImageInfo = {
  path: string
  name: string
  chemin: string
  width: number
  height: number
}

type Scores = {
  relief_3d: number
  glow: number
  saturation: number
  sombre_clair: number
  complexite: number
}

type AnalysisV4 = {
  construction: string
  materiaux: string[]
  eclairage: string
  fond: { description: string; type: string }
  effets: string
  texture: string
  mood: string
  couleurs: string[]
  scores: Scores
  contour: { present: boolean; epais: boolean }
  lettrage: { type: string; integration_embleme: string; traitement_contour: string } | null
  typographie_generee: string
  tags: string[]
  energie: number
  modernite: number
  ratio: string
  reverse_prompt: string
}

type CategoryUsage = { calls: number; tokensIn: number; tokensOut: number }

function slugify(name: string, index: number): string {
  const base = name
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return base || `exemplaire-${index + 1}`
}

async function imageInfos(records: FileRecord[], categoryId: string): Promise<ImageInfo[]> {
  const infos: ImageInfo[] = []
  for (const record of records) {
    if (record.type !== 'image' || record.categorie !== categoryId || !record.utilise) continue
    const path = join(SOURCE_DIR, record.chemin)
    try {
      const meta = await sharp(path).metadata()
      if (!meta.width || !meta.height) continue
      infos.push({ path, name: record.chemin.split('/').pop() ?? record.chemin, chemin: record.chemin, width: meta.width, height: meta.height })
    } catch {
      log(`  ! illisible : ${record.chemin}`)
    }
  }
  return infos
}

async function toReferenceJpeg(img: ImageInfo): Promise<Buffer> {
  return sharp(img.path)
    .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer()
}

// Le reverse-prompt logo sort dans l'ANATOMIE DU GABARIT MAÎTRE (LOT 2) —
// mêmes sections numérotées que les concepts du DA.
const LOGO_REVERSE_ANATOMY = `MANDATORY reverse_prompt anatomy for LOGOS (100-180 words total, numbered sections, English):
0. CONTEXT — one line: FiveM server logo family + render family (dimensional/flat).
1. SHAPE — the subject and lettering decomposed with NUMBERS (element counts, proportions, tilt angles), named negative space.
2. RENDER — the render style with its materials, bevel/extrusion, glow, lighting direction, and its explicit forbids.
3. COLORS — the exact dominant hex codes and gradient direction.
4. FORMAT — square composition, subject occupation as % of width, background treatment.
5. KEYWORDS — one final line of technical English keywords matching the render.`

const BACKGROUND_REVERSE_ANATOMY = `MANDATORY reverse_prompt anatomy for BACKGROUNDS (100-180 words, English):
TYPE — one of: gradient+doodle motifs / dark atmospheric / halftone / scene. Then: construction (planes, motif density, focal emptiness reserved for a logo), lighting, exact hex palette + gradient direction, finishing effects, and one final line of technical keywords. The center must stay calm enough to host a logo — say how.`

const HERO_REVERSE_ANATOMY = `MANDATORY reverse_prompt structure (100-180 words, in this order): subject · setting/background · construction · lighting · typography · color grading · effects. Concrete and directive.`

function analysisSystem(categoryId: string): string {
  const anatomy =
    categoryId === 'logo' ? LOGO_REVERSE_ANATOMY
    : categoryId === 'background_logo' ? BACKGROUND_REVERSE_ANATOMY
    : HERO_REVERSE_ANATOMY
  const lettrageRule =
    categoryId === 'logo' || categoryId === 'icon'
      ? `"lettrage": {"type": "lettering family (custom italic wordmark / monogram / script / slab...) or 'none'", "integration_embleme": "HOW the emblem integrates with the letters (fused in silhouette, inside a letter, above, none...)", "traitement_contour": "contour treatment (thick white outline, dark keyline, glow edge, none...)"},`
      : `"lettrage": null,`
  return `You are a senior art director reverse-engineering premium FiveM/GTA RP visuals that were themselves AI-GENERATED. Extract the exact generation recipe AND measurable style scores of each image.

For EACH image provided (in order), return one JSON object. Answer with a JSON array, one object per image, nothing else.

Each object:
{
  "construction": "the construction language — geometry, element counts, how parts assemble (concrete, with numbers where possible)",
  "materiaux": ["1-4 material keywords among: chrome, gold, glass, neon, metal, stone, plastic, vinyl, paper, fabric, water, fire, ice, wood, carbon, holographic, none"],
  "eclairage": "light sources, direction, temperature, rim/practicals",
  "fond": {"description": "background construction in one line", "type": "one of: ${FOND_TYPES.join(' | ')}"},
  "effets": "recurring finishing effects: grain, glow, particles, stars, smoke, halftone, sparkles, textures",
  "texture": "surface texture character (clean vector / painterly / grain / photographic...)",
  "mood": "mood in 3-6 words",
  "couleurs": ["#RRGGBB dominant", "#RRGGBB accent", "#RRGGBB accent"],
  "scores": {"relief_3d": 0-10 (0 = perfectly flat, 10 = deep 3D extrusion/bevel), "glow": 0-10 (0 = no glow, 10 = dominant rim/contour glow), "saturation": 0-10, "sombre_clair": 0-10 (0 = very dark image, 10 = very bright), "complexite": 0-10 (0 = one simple shape, 10 = dense multi-element)},
  "contour": {"present": true/false (a visible outline around the mark/subject), "epais": true/false (thick, typically white)},
  ${lettrageRule}
  "typographie_generee": "how the GENERATED typography works IF text exists. 'none' if no text",
  "tags": [1 to 3 values among: ${CLUSTER_TAGS.join(', ')}],
  "energie": 0-100, "modernite": 0-100,
  "ratio": "W:H",
  "reverse_prompt": "the generation prompt that would reproduce this image. ${anatomy}"
}
Be terse and concrete everywhere except reverse_prompt. Scores are MEASUREMENTS — judge what you see, not what is fashionable. No prose outside JSON.`
}

function isAnalysisV4(value: unknown): value is AnalysisV4 {
  const v = value as AnalysisV4 | null
  return Boolean(v && typeof v.reverse_prompt === 'string' && v.reverse_prompt.length > 40 && v.scores)
}

function clampScore(n: unknown): number {
  const v = Number(n)
  return Number.isFinite(v) ? Math.max(0, Math.min(10, Math.round(v * 10) / 10)) : 5
}

// ── Analyse d'un lot d'images, avec repli image par image ────────────────────
async function analyzeChunk(
  category: { id: string; focus: string },
  chunk: ImageInfo[],
  jpegs: Buffer[],
  track: (u: GeminiUsage) => void
): Promise<Array<AnalysisV4 | null>> {
  const parts: GeminiPart[] = [
    { text: `Reverse-engineer these ${chunk.length} images. Context: ${category.focus}.` },
    ...jpegs.map((buffer) => ({ inlineData: { mimeType: 'image/jpeg', data: buffer.toString('base64') } })),
  ]
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const text = await geminiMultimodal({
        model: MODEL,
        parts,
        systemInstruction: analysisSystem(category.id),
        json: true,
        temperature: 0.15,
        maxOutputTokens: 6500,
        thinkingBudget: 0,
        onUsage: track,
      })
      const parsed = JSON.parse(text)
      const items = (Array.isArray(parsed) ? parsed : [parsed]) as unknown[]
      if (items.length === chunk.length && items.every(isAnalysisV4)) {
        return items as AnalysisV4[]
      }
      // compte inattendu ou objets invalides : nouvelle tentative du lot
    } catch {
      // JSON invalide : nouvelle tentative du lot
    }
  }
  // Repli 100 % couverture : chaque image du lot repart SEULE
  const results: Array<AnalysisV4 | null> = []
  for (let i = 0; i < chunk.length; i += 1) {
    try {
      const text = await geminiMultimodal({
        model: MODEL,
        parts: [
          { text: `Reverse-engineer this single image. Context: ${category.focus}.` },
          { inlineData: { mimeType: 'image/jpeg', data: jpegs[i]!.toString('base64') } },
        ],
        systemInstruction: analysisSystem(category.id),
        json: true,
        temperature: 0.15,
        maxOutputTokens: 2600,
        thinkingBudget: 0,
        onUsage: track,
      })
      const parsed = JSON.parse(text)
      const item = Array.isArray(parsed) ? parsed[0] : parsed
      results.push(isAnalysisV4(item) ? (item as AnalysisV4) : null)
    } catch {
      results.push(null)
    }
  }
  return results
}

// ── Synthèse ADN CHIFFRÉE — calculée en code, pas par le modèle ──────────────
function pct(count: number, total: number): number {
  return total ? Math.round((count / total) * 100) : 0
}

function topCounts(values: string[], max: number): Array<{ key: string; pct: number }> {
  const counts = new Map<string, number>()
  for (const v of values) {
    const key = v.trim().toLowerCase()
    if (!key || key === 'none' || key === 'n/a') continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const total = values.length || 1
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([key, count]) => ({ key, pct: pct(count, total) }))
}

function buildAdn(categoryId: string, analyses: AnalysisV4[]) {
  const n = analyses.length
  const mean = (pick: (a: AnalysisV4) => number) =>
    Math.round((analyses.reduce((s, a) => s + pick(a), 0) / Math.max(1, n)) * 10) / 10

  const scores_moyens = {
    relief_3d: mean((a) => clampScore(a.scores.relief_3d)),
    glow: mean((a) => clampScore(a.scores.glow)),
    saturation: mean((a) => clampScore(a.scores.saturation)),
    sombre_clair: mean((a) => clampScore(a.scores.sombre_clair)),
    complexite: mean((a) => clampScore(a.scores.complexite)),
  }

  const frequences: Record<string, number> = {
    relief_3d_pct: pct(analyses.filter((a) => clampScore(a.scores.relief_3d) >= 6).length, n),
    glow_pct: pct(analyses.filter((a) => clampScore(a.scores.glow) >= 5).length, n),
    fond_sombre_pct: pct(analyses.filter((a) => clampScore(a.scores.sombre_clair) <= 4).length, n),
    fond_degrade_ou_atmospherique_pct: pct(
      analyses.filter((a) => ['degrade_doodles', 'atmospherique_sombre'].includes(a.fond?.type ?? '')).length,
      n
    ),
    contour_pct: pct(analyses.filter((a) => a.contour?.present).length, n),
    contour_epais_pct: pct(analyses.filter((a) => a.contour?.present && a.contour?.epais).length, n),
    particules_pct: pct(
      analyses.filter((a) => /particle|sparkle|star|dust|ember|bokeh|étoile/i.test(a.effets ?? '')).length,
      n
    ),
  }

  const matieres = topCounts(analyses.flatMap((a) => a.materiaux ?? []), 6).map((m) => ({ matiere: m.key, pct: m.pct }))
  const lettrages =
    categoryId === 'logo' || categoryId === 'icon'
      ? topCounts(analyses.map((a) => a.lettrage?.type ?? ''), 5).map((l) => ({ type: l.key, pct: l.pct }))
      : undefined
  const taxonomie =
    categoryId === 'background_logo'
      ? topCounts(analyses.map((a) => a.fond?.type ?? ''), 6).map((t) => ({ type: t.key, pct: t.pct }))
      : undefined
  const palette_dominante = topCounts(
    analyses.flatMap((a) => (a.couleurs ?? []).filter((c) => /^#[0-9a-fA-F]{6}$/.test(c))),
    6
  ).map((c) => c.key.toUpperCase())

  const traits: Array<{ trait: string; frequence_pct: number; source: string }> = [
    { trait: 'contour/rim glow', frequence_pct: frequences.glow_pct!, source: 'score glow >= 5' },
    { trait: 'dark or gradient atmospheric background', frequence_pct: Math.max(frequences.fond_sombre_pct!, frequences.fond_degrade_ou_atmospherique_pct!), source: 'sombre_clair <= 4 ou fond degrade/atmospherique' },
    { trait: '3D relief / bevel / extrusion', frequence_pct: frequences.relief_3d_pct!, source: 'score relief_3d >= 6' },
    { trait: 'visible contour/outline', frequence_pct: frequences.contour_pct!, source: 'contour.present' },
    { trait: 'particles / sparkles / stars', frequence_pct: frequences.particules_pct!, source: 'effets' },
  ].sort((a, b) => b.frequence_pct - a.frequence_pct)

  // Le paragraphe anglais injecté en section 0 du gabarit — que des mesures.
  const matiereLine = matieres.slice(0, 4).map((m) => `${m.matiere} ${m.pct}%`).join(', ')
  const lettrageLine = lettrages?.length ? ` Dominant lettering families: ${lettrages.slice(0, 3).map((l) => `${l.type} ${l.pct}%`).join(', ')}.` : ''
  const taxonomieLine = taxonomie?.length ? ` Background taxonomy: ${taxonomie.map((t) => `${t.type} ${t.pct}%`).join(', ')}.` : ''
  const resume_en =
    `${frequences.relief_3d_pct}% show 3D relief/bevel (mean relief ${scores_moyens.relief_3d}/10), ` +
    `${frequences.glow_pct}% carry contour/rim glow (mean glow ${scores_moyens.glow}/10), ` +
    `${frequences.fond_sombre_pct}% sit on a dark background and ${frequences.fond_degrade_ou_atmospherique_pct}% on a gradient/atmospheric one, ` +
    `${frequences.contour_epais_pct}% of outlined marks use a thick (usually white) contour, ` +
    `${frequences.particules_pct}% add particles/sparkles. ` +
    `Mean saturation ${scores_moyens.saturation}/10, mean brightness ${scores_moyens.sombre_clair}/10, mean complexity ${scores_moyens.complexite}/10. ` +
    `Dominant materials: ${matiereLine || 'none measured'}.${lettrageLine}${taxonomieLine} ` +
    `Dominant palette: ${palette_dominante.slice(0, 5).join(', ')}.`

  return { images: n, traits, scores_moyens, frequences, matieres, ...(lettrages ? { lettrages } : {}), ...(taxonomie ? { taxonomie } : {}), palette_dominante, resume_en }
}

// ── Synthèse qualitative du guide (comme v3) ─────────────────────────────────
function synthesisPrompt(categoryId: string, focus: string, observations: string): string {
  const grammaireKey =
    categoryId === 'logo'
      ? `\n  "grammaire": ["4-7 rules capturing the CONSTRUCTION GRAMMAR seen in the observations: lettering hugging/fusing silhouettes, emblem-in-letter, gradient+doodle backgrounds, contour glow, thick white outline, material families (soft chrome, fractured gold, glass...) — each rule concrete enough to feed a generation prompt"],`
      : categoryId === 'personnage'
        ? `\n  "coherence_personnages": ["3-5 rules on how premium FiveM character art stays coherent: poses, outfits, finish quality, framing — written to be injected into banner/poster generation prompts"],`
        : categoryId === 'background_logo'
          ? `\n  "taxonomie_fonds": ["one rule per background type observed (gradient+doodles, dark atmospheric, halftone, scene): construction, motif density, where the calm logo zone sits"],`
          : ''
  return `You are distilling reverse-engineering observations into ONE compact style guide for generating new ${focus}.

OBSERVATIONS (per-image analyses of AI-generated reference material):
${observations}

Produce a single JSON object — the style guide — with EXACTLY these keys:
{
  "categorie": "${categoryId}",
  "composition": ["3-5 concrete rules with numbers/proportions"],
  "typographie": ["2-4 rules describing how the GENERATED title/lettering behaves INSIDE these images"],${grammaireKey}
  "lumiere": ["2-4 lighting rules"],
  "etalonnage": ["2-4 color grading rules, name dominant hue families with hex"],
  "effets": ["2-4 recurring finishing effects worth reproducing"],
  "logo": ["1-2 rules for logo integration"],
  "interdits": ["3-5 amateur markers to avoid, from the observations"],
  "ratios": ["dominant aspect ratios seen"]
}

HARD CONSTRAINTS:
- The ENTIRE JSON must stay under ${GUIDE_TOKEN_BUDGET} tokens (~${GUIDE_TOKEN_BUDGET * 4} characters). Be dense, drop redundancy.
- Rules must be specific and actionable (numbers, positions, proportions), never generic advice.
- English, telegraphic style. JSON only.`
}

// ── Coût estimé (--dry) — recalé sur la grille pricing.ts ────────────────────
function estimateDryCost(imagesParCategorie: Array<{ id: string; images: number }>) {
  // Mesures d'ordre de grandeur : ~950 tk in/image (768 px + part de prompt),
  // ~550 tk out/image (analyse enrichie), + 2 appels de synthèse/catégorie.
  const IN_PER_IMAGE = 950
  const OUT_PER_IMAGE = 550
  const SYNTH_IN = 9000
  const SYNTH_OUT = 1400
  let tokensIn = 0
  let tokensOut = 0
  const parCategorie = imagesParCategorie.map(({ id, images }) => {
    const tIn = images * IN_PER_IMAGE + SYNTH_IN
    const tOut = images * OUT_PER_IMAGE + SYNTH_OUT
    tokensIn += tIn
    tokensOut += tOut
    return { categorie: id, images, cout_estime_eur: estimateCostEur({ model: MODEL, tokensIn: tIn, tokensOut: tOut }) }
  })
  const total = estimateCostEur({ model: MODEL, tokensIn, tokensOut })
  return { parCategorie, tokensIn, tokensOut, total, batchTheorique: Math.round(total * 0.5 * 10000) / 10000 }
}

// ═══ MAIN ════════════════════════════════════════════════════════════════════

async function run() {
  log(`Source : ${SOURCE_DIR}`)
  log(`Guides : ${STYLES_DIR}`)
  log(`Exemplars : ${EXEMPLARS_DIR}`)
  mkdirSync(STYLES_DIR, { recursive: true })

  // ── A. Inventaire complet ────────────────────────────────────────────────
  const records = await buildInventory()
  const summary = inventorySummary(records)
  const totalImages = records.filter((r) => r.type === 'image' && r.utilise).length
  log(`\n═ INVENTAIRE — ${records.length} fichiers, ${totalImages} images à analyser (100 %, zéro échantillonnage) ═`)
  for (const folder of summary) {
    log(`  ${folder.dossier} : ${folder.fichiers} fichiers (${folder.images} images, ${folder.txt} txt, ${folder.autres} autres) → catégorie ${folder.categorie ?? '—'}, ${folder.utilises} utilisés`)
    for (const skip of folder.non_utilises) log(`      · non utilisé : ${skip.fichier} — ${skip.raison}`)
  }

  // ── B. Recettes humaines (gratuit) ───────────────────────────────────────
  const recettes = parseRecettesHumaines(records)
  log(`\n═ RECETTES HUMAINES — ${recettes.length} recettes prioritaires écrites (${RECETTES_DIR}) ═`)

  writeFileSync(
    join(STYLES_DIR, '_inventaire-v4.json'),
    JSON.stringify({
      genere_le: new Date().toISOString(),
      version: 4,
      source: SOURCE_DIR,
      fichiers_totaux: records.length,
      images_a_analyser: totalImages,
      recettes_humaines: recettes.length,
      dossiers: summary,
      fichiers: records,
    }, null, 2)
  )
  log(`Inventaire → ${join(STYLES_DIR, '_inventaire-v4.json')}`)

  if (DRY) {
    const parCat = await Promise.all(
      CATEGORIES.map(async (c) => ({ id: c.id, images: (await imageInfos(records, c.id)).length }))
    )
    const cost = estimateDryCost(parCat)
    log(`\n═ COÛT ESTIMÉ (analyse totale, ${MODEL}) ═`)
    for (const c of cost.parCategorie) log(`  ${c.categorie} : ${c.images} images → ~${c.cout_estime_eur.toFixed(4)} €`)
    log(`  TOTAL ESTIMÉ : ~${cost.total.toFixed(4)} € (${cost.tokensIn + cost.tokensOut} tokens) · Batch −50 % théorique : ~${cost.batchTheorique.toFixed(4)} €`)
    log('\n--dry : étages A + B terminés, zéro appel API, coût 0 €.')
    log('Étape suivante (client) : relancer SANS --dry pour l’analyse vision totale.')
    return
  }

  // ── C. Analyse vision TOTALE par catégorie ───────────────────────────────
  const report: Record<string, unknown>[] = []
  const totals: CategoryUsage = { calls: 0, tokensIn: 0, tokensOut: 0 }
  const echecs: Array<{ categorie: string; fichier: string }> = []
  let personnageCoherence: string[] | null = null
  const guidesEcrits = new Map<string, Record<string, unknown>>()

  for (const category of CATEGORIES) {
    if (only && category.id !== only) continue
    log(`\n── ${category.id} (${category.folder})`)

    const all = await imageInfos(records, category.id)
    log(`  ${all.length} images valides → ${all.length} analysées (100 %)`)

    const usage: CategoryUsage = { calls: 0, tokensIn: 0, tokensOut: 0 }
    const track = (u: GeminiUsage) => {
      usage.calls += 1
      usage.tokensIn += u.tokensIn
      usage.tokensOut += u.tokensOut
    }

    const catDir = join(EXEMPLARS_DIR, category.id)
    mkdirSync(catDir, { recursive: true })

    const analyses: Array<{ img: ImageInfo; jpeg: Buffer; analysis: AnalysisV4 }> = []
    for (let i = 0; i < all.length; i += CHUNK_SIZE) {
      const chunk = all.slice(i, i + CHUNK_SIZE)
      const jpegs = await Promise.all(chunk.map(toReferenceJpeg))
      const items = await analyzeChunk(category, chunk, jpegs, track)
      items.forEach((analysis, j) => {
        const img = chunk[j]
        const jpeg = jpegs[j]
        if (!img || !jpeg) return
        if (analysis) analyses.push({ img, jpeg, analysis })
        else {
          echecs.push({ categorie: category.id, fichier: img.chemin })
          log(`  ✗ échec résiduel : ${img.chemin}`)
        }
      })
      log(`  lot ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(all.length / CHUNK_SIZE)} : ${items.filter(Boolean).length}/${chunk.length} analyses`)
    }

    if (!analyses.length) {
      log(`  ✗ ÉCHEC ${category.id} : aucune analyse exploitable`)
      continue
    }

    // Exemplars : .txt (reverse-prompt au format gabarit) + .jpg (768px)
    const manifest: Array<Record<string, unknown>> = []
    const usedSlugs = new Set<string>()
    analyses.forEach(({ img, jpeg, analysis }, index) => {
      let slug = slugify(img.name, index)
      while (usedSlugs.has(slug)) slug = `${slug}-${index}`
      usedSlugs.add(slug)
      writeFileSync(join(catDir, `${slug}.txt`), analysis.reverse_prompt.trim() + '\n')
      writeFileSync(join(catDir, `${slug}.jpg`), jpeg)
      manifest.push({
        slug,
        source: img.name,
        priorite: 'reverse',
        tags: (analysis.tags ?? []).filter((t) => (CLUSTER_TAGS as readonly string[]).includes(t)),
        energie: Math.max(0, Math.min(100, Math.round(analysis.energie ?? 50))),
        modernite: Math.max(0, Math.min(100, Math.round(analysis.modernite ?? 50))),
        couleurs: (analysis.couleurs ?? []).filter((c) => /^#[0-9a-fA-F]{6}$/.test(c)).slice(0, 3),
        ratio: analysis.ratio ?? '',
        typographie_generee: analysis.typographie_generee ?? 'none',
        scores: {
          relief_3d: clampScore(analysis.scores.relief_3d),
          glow: clampScore(analysis.scores.glow),
          saturation: clampScore(analysis.scores.saturation),
          sombre_clair: clampScore(analysis.scores.sombre_clair),
          complexite: clampScore(analysis.scores.complexite),
        },
        ...(category.id === 'logo' || category.id === 'icon'
          ? { construction: analysis.construction ?? 'n/a', lettrage: analysis.lettrage ?? null }
          : {}),
        ...(category.id === 'background_logo' ? { fond_type: analysis.fond?.type ?? 'autre' } : {}),
      })
    })
    writeFileSync(join(catDir, '_manifest.json'), JSON.stringify({ categorie: category.id, genere_le: new Date().toISOString(), exemplaires: manifest }, null, 2))
    log(`  ✓ ${manifest.length} exemplaires écrits (${category.id})`)

    // ADN chiffré — calcul en code sur TOUTES les analyses de la catégorie
    const adn = buildAdn(category.id, analyses.map((a) => a.analysis))

    // Synthèse qualitative → guide v4
    const observations = analyses.map(({ analysis }) => {
      const { reverse_prompt: _omit, ...rest } = analysis
      return rest
    })
    let guideJson: Record<string, unknown> | null = null
    for (let attempt = 0; attempt < 2 && !guideJson; attempt += 1) {
      const text = await geminiMultimodal({
        model: MODEL,
        parts: [{ text: synthesisPrompt(category.id, category.focus, JSON.stringify(observations)) }],
        json: true,
        temperature: 0.2,
        maxOutputTokens: 1600,
        thinkingBudget: 0,
        onUsage: track,
      })
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>
        const chars = JSON.stringify(parsed).length
        if (chars > GUIDE_TOKEN_BUDGET * 4 && attempt === 0) {
          log(`  guide trop long (${chars} chars) — passe de compression`)
          continue
        }
        guideJson = parsed
      } catch {
        log('  ! synthèse JSON invalide, nouvelle tentative')
      }
    }

    if (!guideJson) {
      log(`  ✗ ÉCHEC synthèse guide ${category.id} — exemplaires + ADN conservés, guide minimal`)
      guideJson = { categorie: category.id }
    }
    if (category.id === 'personnage' && Array.isArray(guideJson.coherence_personnages)) {
      personnageCoherence = (guideJson.coherence_personnages as unknown[]).filter((v): v is string => typeof v === 'string')
    }
    const output = {
      categorie: category.id,
      version: 4,
      source: category.folder,
      images_totales: all.length,
      images_analysees: analyses.length,
      exemplaires: manifest.length,
      genere_le: new Date().toISOString(),
      modele: MODEL,
      adn,
      guide: guideJson,
    }
    writeFileSync(join(STYLES_DIR, `${category.id}.json`), JSON.stringify(output, null, 2))
    guidesEcrits.set(category.id, output)
    log(`  ✓ guide v4 écrit — ADN : ${adn.resume_en.slice(0, 140)}…`)

    const costEur = estimateCostEur({ model: MODEL, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut })
    totals.calls += usage.calls
    totals.tokensIn += usage.tokensIn
    totals.tokensOut += usage.tokensOut
    report.push({
      categorie: category.id,
      images_totales: all.length,
      analysees: analyses.length,
      exemplaires: manifest.length,
      appels: usage.calls,
      tokens_in: usage.tokensIn,
      tokens_out: usage.tokensOut,
      cout_eur: costEur,
    })
    log(`  ${usage.calls} appels, ${usage.tokensIn} tk in, ${usage.tokensOut} tk out, ${costEur.toFixed(4)} €`)
  }

  // La cohérence personnages reste VERSÉE aux guides bannière/affiche
  if (personnageCoherence?.length) {
    for (const id of ['banniere_discord', 'banniere_f5', 'affiche']) {
      const output = guidesEcrits.get(id)
      if (!output) continue
      const guide = output.guide as Record<string, unknown>
      guide.personnages = personnageCoherence
      writeFileSync(join(STYLES_DIR, `${id}.json`), JSON.stringify(output, null, 2))
      log(`  ✓ cohérence personnages versée dans ${id}.json (${personnageCoherence.length} règles)`)
    }
  }

  const totalCost = estimateCostEur({ model: MODEL, tokensIn: totals.tokensIn, tokensOut: totals.tokensOut })
  const couverture = report.map((r) => ({
    categorie: r.categorie,
    analysees: `${r.analysees}/${r.images_totales}`,
  }))
  const finalReport = {
    execute_le: new Date().toISOString(),
    version: 4,
    modele: MODEL,
    mode: `sync (lots de ${CHUNK_SIZE} images/appel, repli image par image sur échec)`,
    note_batch: 'Le mode Batch asynchrone (−50 %) reste documenté, pas câblé : prix batch théorique = cout_total_eur × 0,5.',
    inventaire: { fichiers_totaux: records.length, images_a_analyser: totalImages, recettes_humaines: recettes.length },
    couverture,
    echecs_residuels: echecs,
    categories: report,
    total: {
      appels: totals.calls,
      tokens_in: totals.tokensIn,
      tokens_out: totals.tokensOut,
      cout_total_eur: totalCost,
      cout_batch_theorique_eur: Math.round(totalCost * 0.5 * 10000) / 10000,
    },
  }
  writeFileSync(join(STYLES_DIR, '_training-report-v4.json'), JSON.stringify(finalReport, null, 2))
  log(`\nRapport : ${join(STYLES_DIR, '_training-report-v4.json')}`)
  const analysees = report.reduce((s, r) => s + Number(r.analysees ?? 0), 0)
  log(`COUVERTURE : ${analysees}/${totalImages} images analysées${echecs.length ? ` — ${echecs.length} échec(s) résiduel(s) listé(s) au rapport` : ' (100 %)'}`)
  log(`COÛT TOTAL : ${totalCost.toFixed(4)} € (${totals.calls} appels, ${totals.tokensIn + totals.tokensOut} tokens)`)
}

await run()
