/*
 * Entraînement v3 — couverture prouvée du dossier client (run 5.3, LOT 3).
 * Remplace train-fivem-v2.ts (jamais lancé) — c'est LE script d'entraînement.
 *
 * Trois étages :
 *   A. INVENTAIRE RÉCURSIF COMPLET (gratuit, toujours) — CHAQUE fichier du
 *      dossier « entrainement IA fivem » est listé : type, taille, catégorie
 *      assignée, utilisé ou non, et POURQUOI quand non. Aucun fichier absent.
 *      → src/engine/styles/fivem/_inventaire-v3.json
 *   B. RECETTES HUMAINES (gratuit, toujours) — les .txt du dossier (dont
 *      « prompt for IA desgin.txt ») sont parsés en recettes prioritaires :
 *      elles passent AVANT les reverse-prompts dans la sélection few-shot.
 *      → src/engine/exemplars/fivem/_recettes-humaines/
 *   C. ANALYSE VISION (API, LANCÉE PAR LE CLIENT, jamais par l'assistant) —
 *      reverse-prompting par catégorie (v2) + ANALYSE DÉDIÉE LOGOS (grammaire
 *      de construction : lettrage épousant une silhouette, emblème dans la
 *      lettre, fond dégradé + doodles, glow de contour, contour blanc épais,
 *      matières) versée dans logo.json v3, + cohérence personnages versée aux
 *      guides bannière.
 *
 * Usage :  bun run scripts/train-fivem-v3.ts [--dry] [--only=<categorie>]
 *   --dry : étages A + B seulement — zéro appel API, coût 0.
 *   Mode Batch : volume one-shot ≈ centimes ; le Batch (−50 %) reste
 *   documenté dans le rapport (prix théorique), pas câblé.
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
const MAX_PER_CATEGORY = 12
// Analyse dédiée logos (LOT 3.3) : couverture élargie — la grammaire de
// construction se lit sur ALYA, Fruitz, le R doré fracturé, FLASH MOOD…
const MAX_LOGOS = 20
const CHUNK_SIZE = 3
const GUIDE_TOKEN_BUDGET = 900

const CLUSTER_TAGS = [
  'urbain', 'cartel', 'luxe', 'ete', 'sombre', 'chill',
  'esport', 'militaire', 'retro', 'noel', 'neutre',
] as const

const CATEGORIES: Array<{ folder: string; id: string; focus: string }> = [
  { folder: 'affiche serveur fivem gtarp', id: 'affiche', focus: 'promotional posters (announcements, events, rules) for FiveM servers' },
  { folder: 'background pour logo ect', id: 'background_logo', focus: 'abstract/scenic backgrounds designed to host a logo on top' },
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

// ═══ ÉTAGE A — INVENTAIRE RÉCURSIF COMPLET ═══════════════════════════════════

type FileRecord = {
  chemin: string // relatif à SOURCE_DIR, séparateurs /
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
            ? `candidate à l’analyse (catégorie ${category.id}, sélection représentative)`
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

// ═══ ÉTAGE B — RECETTES HUMAINES (gratuit) ═══════════════════════════════════

// Tags heuristiques — pas d'appel API : mots-clés du texte de la recette.
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
  // catégories héro où la recette est éligible au few-shot
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
        // recettes lifestyle posées — pôle élégant, facture moderne
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

// ═══ ÉTAGE C — ANALYSE VISION (API, lancée par le client) ════════════════════

type ImageInfo = {
  path: string
  name: string
  width: number
  height: number
  ratio: number
  luminance: number
}

type ExemplarAnalysis = {
  composition: string
  typographie_generee: string
  construction: string
  lumiere: string
  etalonnage: string
  effets: string
  logo: string
  ratio: string
  tags: string[]
  energie: number
  modernite: number
  couleurs: string[]
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
      const stats = await sharp(path).resize(64, 64, { fit: 'fill' }).stats()
      const [r, g, b] = stats.channels
      const luminance = 0.299 * (r?.mean ?? 0) + 0.587 * (g?.mean ?? 0) + 0.114 * (b?.mean ?? 0)
      infos.push({ path, name: record.chemin.split('/').pop() ?? record.chemin, width: meta.width, height: meta.height, ratio: meta.width / meta.height, luminance })
    } catch {
      log(`  ! illisible : ${record.chemin}`)
    }
  }
  return infos
}

// Diversité : buckets (ratio arrondi au quart × tertile de luminance),
// round-robin entre buckets jusqu'au plafond de la catégorie.
function pickRepresentative(images: ImageInfo[], max: number): ImageInfo[] {
  if (images.length <= max) return images
  const sortedLum = [...images].sort((a, b) => a.luminance - b.luminance)
  const tertileOf = (img: ImageInfo) => Math.floor((sortedLum.indexOf(img) / images.length) * 3)
  const buckets = new Map<string, ImageInfo[]>()
  for (const img of images) {
    const key = `${Math.round(img.ratio * 4) / 4}|${tertileOf(img)}`
    const list = buckets.get(key) ?? []
    list.push(img)
    buckets.set(key, list)
  }
  const picked: ImageInfo[] = []
  const bucketLists = [...buckets.values()]
  let i = 0
  while (picked.length < max) {
    const list = bucketLists[i % bucketLists.length]
    const next = list?.shift()
    if (next) picked.push(next)
    i += 1
    if (bucketLists.every((l) => l.length === 0)) break
  }
  return picked
}

async function toReferenceJpeg(img: ImageInfo): Promise<Buffer> {
  return sharp(img.path)
    .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer()
}

const ANALYSIS_SYSTEM = `You are a senior art director reverse-engineering premium FiveM/GTA RP visuals that were themselves AI-GENERATED. Your mission: extract the exact generation recipe of each image.

For EACH image provided (in order), return one JSON object. Answer with a JSON array, one object per image, nothing else.

Each object:
{
  "composition": "framing, focal point, subject placement, depth layers — with rough proportions",
  "typographie_generee": "how the GENERATED typography works IF text exists: treatment (chrome/3D/graffiti/neon/engraved...), scale vs frame, and HOW it interleaves with the subjects. 'none' if no text",
  "construction": "for logos/marks: the CONSTRUCTION LANGUAGE — lettering hugging/fusing a silhouette, emblem integrated INTO a letter, gradient background + thematic doodle motifs, thick white contour, outline glow, materials (soft chrome, fractured gold, glass, candy vinyl...). For non-logo images: 'n/a'",
  "lumiere": "light sources, direction, temperature, rim/practicals",
  "etalonnage": "color grading: dominant hues as hex, contrast character, saturation strategy",
  "effets": "recurring finishing effects: grain, glow, particles, smoke, halftone, textures",
  "logo": "logo presence, placement and integration. 'none' if absent",
  "ratio": "aspect ratio as W:H",
  "tags": [1 to 3 values among: ${CLUSTER_TAGS.join(', ')}],
  "energie": 0-100 (0 = elegant/calm, 100 = aggressive/loud),
  "modernite": 0-100 (0 = classic/heritage, 100 = modern/futuristic),
  "couleurs": ["#RRGGBB dominant", "#RRGGBB accent", "#RRGGBB accent"],
  "reverse_prompt": "THE GENERATION PROMPT, in English, 80-150 words, that would reproduce this image. MANDATORY structure, in this order: subject · setting/background · construction (for logos) · lighting · typography · color grading · effects. Concrete and directive — a prompt, not a description. No preamble."
}
Be terse and concrete everywhere except reverse_prompt. No prose outside JSON.`

function synthesisPrompt(categoryId: string, focus: string, observations: string): string {
  const grammaireKey =
    categoryId === 'logo'
      ? `\n  "grammaire": ["4-7 rules capturing the CONSTRUCTION GRAMMAR seen in the observations: lettering hugging/fusing silhouettes, emblem-in-letter, gradient+doodle backgrounds, contour glow, thick white outline, material families (soft chrome, fractured gold, glass...) — each rule concrete enough to feed a generation prompt"],`
      : categoryId === 'personnage'
        ? `\n  "coherence_personnages": ["3-5 rules on how premium FiveM character art stays coherent: poses, outfits, finish quality, framing — written to be injected into banner/poster generation prompts"],`
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

function isExemplarAnalysis(value: unknown): value is ExemplarAnalysis {
  const v = value as ExemplarAnalysis | null
  return Boolean(v && typeof v.reverse_prompt === 'string' && v.reverse_prompt.length > 40)
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
  log(`\n═ INVENTAIRE — ${records.length} fichiers, aucun exclu de la liste ═`)
  for (const folder of summary) {
    log(`  ${folder.dossier} : ${folder.fichiers} fichiers (${folder.images} images, ${folder.txt} txt, ${folder.autres} autres) → catégorie ${folder.categorie ?? '—'}, ${folder.utilises} utilisés`)
    for (const skip of folder.non_utilises) log(`      · non utilisé : ${skip.fichier} — ${skip.raison}`)
  }

  // ── B. Recettes humaines (gratuit) ───────────────────────────────────────
  const recettes = parseRecettesHumaines(records)
  log(`\n═ RECETTES HUMAINES — ${recettes.length} recettes prioritaires écrites (${RECETTES_DIR}) ═`)

  writeFileSync(
    join(STYLES_DIR, '_inventaire-v3.json'),
    JSON.stringify({
      genere_le: new Date().toISOString(),
      source: SOURCE_DIR,
      fichiers_totaux: records.length,
      recettes_humaines: recettes.length,
      dossiers: summary,
      fichiers: records,
    }, null, 2)
  )
  log(`Inventaire → ${join(STYLES_DIR, '_inventaire-v3.json')}`)

  if (DRY) {
    log('\n--dry : étages A + B terminés, zéro appel API, coût 0 €.')
    log('Étape suivante (client) : relancer SANS --dry pour l’analyse vision.')
    return
  }

  // ── C. Analyse vision par catégorie ──────────────────────────────────────
  const report: Record<string, unknown>[] = []
  const totals: CategoryUsage = { calls: 0, tokensIn: 0, tokensOut: 0 }
  let personnageCoherence: string[] | null = null
  const guidesEcrits = new Map<string, Record<string, unknown>>()

  for (const category of CATEGORIES) {
    if (only && category.id !== only) continue
    log(`\n── ${category.id} (${category.folder})`)

    const all = await imageInfos(records, category.id)
    const max = category.id === 'logo' ? MAX_LOGOS : MAX_PER_CATEGORY
    const picked = pickRepresentative(all, max)
    log(`  ${all.length} images valides → ${picked.length} sélectionnées (plafond ${max})`)

    const usage: CategoryUsage = { calls: 0, tokensIn: 0, tokensOut: 0 }
    const track = (u: GeminiUsage) => {
      usage.calls += 1
      usage.tokensIn += u.tokensIn
      usage.tokensOut += u.tokensOut
    }

    const catDir = join(EXEMPLARS_DIR, category.id)
    mkdirSync(catDir, { recursive: true })

    const analyses: Array<{ img: ImageInfo; jpeg: Buffer; analysis: ExemplarAnalysis }> = []
    for (let i = 0; i < picked.length; i += CHUNK_SIZE) {
      const chunk = picked.slice(i, i + CHUNK_SIZE)
      const jpegs = await Promise.all(chunk.map(toReferenceJpeg))
      const parts: GeminiPart[] = [
        { text: `Reverse-engineer these ${chunk.length} images. Context: ${category.focus}.` },
        ...jpegs.map((buffer) => ({ inlineData: { mimeType: 'image/jpeg', data: buffer.toString('base64') } })),
      ]
      const text = await geminiMultimodal({
        model: MODEL,
        parts,
        systemInstruction: ANALYSIS_SYSTEM,
        json: true,
        temperature: 0.15,
        maxOutputTokens: 3800,
        thinkingBudget: 0,
        onUsage: track,
      })
      try {
        const parsed = JSON.parse(text)
        const items = (Array.isArray(parsed) ? parsed : [parsed]).filter(isExemplarAnalysis)
        items.forEach((analysis, j) => {
          const img = chunk[j]
          const jpeg = jpegs[j]
          if (img && jpeg) analyses.push({ img, jpeg, analysis })
        })
        log(`  lot ${i / CHUNK_SIZE + 1} : ${items.length}/${chunk.length} reverse-prompts extraits`)
      } catch {
        log(`  ! lot ${i / CHUNK_SIZE + 1} : JSON invalide, ignoré`)
      }
    }

    if (!analyses.length) {
      log(`  ✗ ÉCHEC ${category.id} : aucun reverse-prompt exploitable`)
      continue
    }

    // Exemplars : .txt (reverse-prompt) + .jpg (768px, jointe aux appels)
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
        ...(category.id === 'logo' ? { construction: analysis.construction ?? 'n/a' } : {}),
      })
    })
    writeFileSync(join(catDir, '_manifest.json'), JSON.stringify({ categorie: category.id, genere_le: new Date().toISOString(), exemplaires: manifest }, null, 2))
    log(`  ✓ ${manifest.length} exemplaires écrits (${category.id})`)

    // Synthèse → guide v3
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
      log(`  ✗ ÉCHEC synthèse guide ${category.id} — exemplaires conservés`)
    } else {
      if (category.id === 'personnage' && Array.isArray(guideJson.coherence_personnages)) {
        personnageCoherence = (guideJson.coherence_personnages as unknown[]).filter((v): v is string => typeof v === 'string')
      }
      const output = {
        categorie: category.id,
        version: 3,
        source: category.folder,
        images_totales: all.length,
        images_analysees: picked.length,
        exemplaires: manifest.length,
        genere_le: new Date().toISOString(),
        modele: MODEL,
        guide: guideJson,
      }
      writeFileSync(join(STYLES_DIR, `${category.id}.json`), JSON.stringify(output, null, 2))
      guidesEcrits.set(category.id, output)
      log(`  ✓ guide v3 écrit (${JSON.stringify(guideJson).length} chars)`)
    }

    const costEur = estimateCostEur({ model: MODEL, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut })
    totals.calls += usage.calls
    totals.tokensIn += usage.tokensIn
    totals.tokensOut += usage.tokensOut
    report.push({
      categorie: category.id,
      images_totales: all.length,
      analysees: picked.length,
      exemplaires: manifest.length,
      appels: usage.calls,
      tokens_in: usage.tokensIn,
      tokens_out: usage.tokensOut,
      cout_eur: costEur,
    })
    log(`  ${usage.calls} appels, ${usage.tokensIn} tk in, ${usage.tokensOut} tk out, ${costEur.toFixed(4)} €`)
  }

  // La cohérence personnages est VERSÉE aux guides bannière/affiche (LOT 3.4)
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
  const finalReport = {
    execute_le: new Date().toISOString(),
    version: 3,
    modele: MODEL,
    mode: `sync (lots de ${CHUNK_SIZE} images/appel)`,
    note_batch: "Volume one-shot ≈ centimes : le mode Batch asynchrone (−50 %) n'apporte que ~la moitié d'un café. Prix batch théorique = cout_total_eur × 0,5.",
    inventaire: { fichiers_totaux: records.length, recettes_humaines: recettes.length },
    categories: report,
    total: {
      appels: totals.calls,
      tokens_in: totals.tokensIn,
      tokens_out: totals.tokensOut,
      cout_total_eur: totalCost,
      cout_batch_theorique_eur: Math.round(totalCost * 0.5 * 10000) / 10000,
    },
  }
  writeFileSync(join(STYLES_DIR, '_training-report-v3.json'), JSON.stringify(finalReport, null, 2))
  log(`\nRapport : ${join(STYLES_DIR, '_training-report-v3.json')}`)
  log(`COÛT TOTAL : ${totalCost.toFixed(4)} € (${totals.calls} appels, ${totals.tokensIn + totals.tokensOut} tokens)`)
}

await run()
