/*
 * Entraînement v2 — reverse-prompting (run 5.2, LOT 1).
 *
 * Le constat du run 5.1 : décrire des styles en adjectifs ne produit rien.
 * Les références du client sont elles-mêmes générées par IA — on leur fait
 * donc cracher leur recette. Pour chaque catégorie, sur 8-12 images
 * représentatives (768 px), le modèle vision produit DEUX choses par image :
 *   1. l'analyse structurée (composition, TYPOGRAPHIE GÉNÉRÉE, lumière,
 *      étalonnage, effets, logo) + tags de cluster (cartel, été, luxe…)
 *   2. le REVERSE-PROMPT : le prompt de génération exact, en anglais,
 *      80-150 mots, structure imposée sujet · décor · lumière · typographie ·
 *      étalonnage · effets, qui reproduirait cette image.
 *
 * Livrables versionnés (l'entraînement ne se repaie jamais) :
 *   src/engine/styles/fivem/<cat>.json          — guide v2 (synthèse)
 *   src/engine/exemplars/fivem/<cat>/<slug>.txt — reverse-prompt exemplaire
 *   src/engine/exemplars/fivem/<cat>/<slug>.jpg — référence 768 px (jointe
 *                                                 aux appels de génération)
 *   src/engine/exemplars/fivem/<cat>/_manifest.json — tags/énergie/couleurs
 *   src/engine/styles/fivem/_training-report-v2.json — coût réel du one-shot
 *
 * Usage :  bun run scripts/train-fivem-v2.ts [--dry] [--only=<categorie>]
 *   --dry : inventaire + sélection seulement, zéro appel API, coût 0.
 *
 * Ce script est préparé par l'atelier et LANCÉ PAR LE CLIENT — jamais
 * exécuté par l'assistant.
 */

import { readdirSync, mkdirSync, writeFileSync } from 'fs'
import { join, resolve, extname } from 'path'
import sharp from 'sharp'
import { geminiMultimodal, type GeminiPart, type GeminiUsage } from '../src/lib/ai/gemini'
import { estimateCostEur } from '../src/lib/engine/pricing'

const SOURCE_DIR = resolve(import.meta.dir, '../../entrainement IA fivem')
const STYLES_DIR = resolve(import.meta.dir, '../src/engine/styles/fivem')
const EXEMPLARS_DIR = resolve(import.meta.dir, '../src/engine/exemplars/fivem')
const MODEL = 'gemini-3.5-flash'
const MAX_PER_CATEGORY = 12
const CHUNK_SIZE = 3 // reverse-prompts longs → petits lots pour tenir maxOutputTokens
const GUIDE_TOKEN_BUDGET = 800

// Clusters d'univers reconnus par le mapping (src/lib/engine/mapping.ts) —
// le modèle vision tagge chaque image avec 1 à 3 de ces valeurs.
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
  { folder: 'charcter design for prompt exemple', id: 'personnage', focus: 'FiveM/GTA V character renders — how premium character art is lit, framed and graded' },
  { folder: 'exemple DA complete fivem', id: 'da_complete', focus: 'full brand identity sets — how one server keeps visual coherence across assets' },
  { folder: 'icon', id: 'icon', focus: 'small square icons/avatars for Discord and launchers' },
  { folder: 'logo serveur fivem gtarp', id: 'logo', focus: 'FiveM server logos (emblems, lettermarks, mascots)' },
]

const VALID_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])

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

const args = new Set(process.argv.slice(2))
const DRY = args.has('--dry')
const only = [...args].find((a) => a.startsWith('--only='))?.slice(7)

function log(msg: string) {
  console.log(msg)
}

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

async function inventory(folder: string): Promise<ImageInfo[]> {
  const dir = join(SOURCE_DIR, folder)
  const files = readdirSync(dir).filter((f) => VALID_EXT.has(extname(f).toLowerCase()))
  const infos: ImageInfo[] = []
  for (const name of files) {
    try {
      const path = join(dir, name)
      const meta = await sharp(path).metadata()
      if (!meta.width || !meta.height) continue
      const stats = await sharp(path).resize(64, 64, { fit: 'fill' }).stats()
      const [r, g, b] = stats.channels
      const luminance = 0.299 * (r?.mean ?? 0) + 0.587 * (g?.mean ?? 0) + 0.114 * (b?.mean ?? 0)
      infos.push({ path, name, width: meta.width, height: meta.height, ratio: meta.width / meta.height, luminance })
    } catch {
      log(`  ! illisible : ${name}`)
    }
  }
  return infos
}

// Diversité : buckets (ratio arrondi au quart × tertile de luminance),
// round-robin entre buckets jusqu'à MAX_PER_CATEGORY.
function pickRepresentative(images: ImageInfo[]): ImageInfo[] {
  if (images.length <= MAX_PER_CATEGORY) return images
  const sortedLum = [...images].sort((a, b) => a.luminance - b.luminance)
  const tertileOf = (img: ImageInfo) => {
    const idx = sortedLum.indexOf(img)
    return Math.floor((idx / images.length) * 3)
  }
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
  while (picked.length < MAX_PER_CATEGORY) {
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
  "typographie_generee": "how the GENERATED typography works IF text exists: treatment (chrome/3D/graffiti/neon/engraved...), scale vs frame, and HOW it interleaves with the subjects (letters behind subjects, strokes crossing in front, integrated reflections). 'none' if no text",
  "lumiere": "light sources, direction, temperature, rim/practicals",
  "etalonnage": "color grading: dominant hues as hex, contrast character, saturation strategy",
  "effets": "recurring finishing effects: grain, glow, particles, smoke, halftone, topo lines, textures",
  "logo": "logo presence, placement and integration. 'none' if absent",
  "ratio": "aspect ratio as W:H",
  "tags": [1 to 3 values among: ${CLUSTER_TAGS.join(', ')}],
  "energie": 0-100 (0 = elegant/calm, 100 = aggressive/loud),
  "modernite": 0-100 (0 = classic/heritage, 100 = modern/futuristic),
  "couleurs": ["#RRGGBB dominant", "#RRGGBB accent", "#RRGGBB accent"],
  "reverse_prompt": "THE GENERATION PROMPT, in English, 80-150 words, that would reproduce this image. MANDATORY structure, in this order: subject · setting · lighting · typography (exact treatment and subject interleaving; omit only if the image has no text) · color grading · effects. Concrete and directive — a prompt, not a description. No preamble."
}
Be terse and concrete everywhere except reverse_prompt. No prose outside JSON.`

function synthesisPrompt(categoryId: string, focus: string, observations: string): string {
  return `You are distilling reverse-engineering observations into ONE compact style guide for generating new ${focus}.

OBSERVATIONS (per-image analyses of AI-generated reference material):
${observations}

Produce a single JSON object — the style guide — with EXACTLY these keys:
{
  "categorie": "${categoryId}",
  "composition": ["3-5 concrete rules with numbers/proportions"],
  "typographie": ["2-4 rules describing how the GENERATED title/lettering behaves INSIDE these images: treatment families, scale vs frame, depth interleaving with subjects, integrated lighting. These rules feed the image generation prompt itself"],
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

async function run() {
  log(`Source : ${SOURCE_DIR}`)
  log(`Guides : ${STYLES_DIR}`)
  log(`Exemplars : ${EXEMPLARS_DIR}`)
  mkdirSync(STYLES_DIR, { recursive: true })

  const report: Record<string, unknown>[] = []
  const totals: CategoryUsage = { calls: 0, tokensIn: 0, tokensOut: 0 }

  for (const category of CATEGORIES) {
    if (only && category.id !== only) continue
    log(`\n── ${category.id} (${category.folder})`)

    const all = await inventory(category.folder)
    const picked = pickRepresentative(all)
    log(`  ${all.length} images valides → ${picked.length} sélectionnées`)
    for (const img of picked) log(`    · ${img.name} (${img.width}×${img.height}, lum ${Math.round(img.luminance)})`)

    if (DRY) {
      report.push({ categorie: category.id, images_totales: all.length, analysees: picked.length, cout_eur: 0 })
      continue
    }

    const usage: CategoryUsage = { calls: 0, tokensIn: 0, tokensOut: 0 }
    const track = (u: GeminiUsage) => {
      usage.calls += 1
      usage.tokensIn += u.tokensIn
      usage.tokensOut += u.tokensOut
    }

    const catDir = join(EXEMPLARS_DIR, category.id)
    mkdirSync(catDir, { recursive: true })

    // Analyse + reverse-prompt par lots de CHUNK_SIZE images
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
        maxOutputTokens: 3600,
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

    // Écriture des exemplars : .txt (reverse-prompt) + .jpg (référence 768px)
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
        tags: (analysis.tags ?? []).filter((t) => (CLUSTER_TAGS as readonly string[]).includes(t)),
        energie: Math.max(0, Math.min(100, Math.round(analysis.energie ?? 50))),
        modernite: Math.max(0, Math.min(100, Math.round(analysis.modernite ?? 50))),
        couleurs: (analysis.couleurs ?? []).filter((c) => /^#[0-9a-fA-F]{6}$/.test(c)).slice(0, 3),
        ratio: analysis.ratio ?? '',
        typographie_generee: analysis.typographie_generee ?? 'none',
      })
    })
    writeFileSync(join(catDir, '_manifest.json'), JSON.stringify({ categorie: category.id, genere_le: new Date().toISOString(), exemplaires: manifest }, null, 2))
    log(`  ✓ ${manifest.length} exemplaires écrits (${category.id})`)

    // Synthèse → guide v2 compact
    const observations = analyses.map(({ analysis }) => {
      const { reverse_prompt: _omit, ...rest } = analysis
      return rest
    })
    let guideJson: unknown = null
    for (let attempt = 0; attempt < 2 && !guideJson; attempt += 1) {
      const text = await geminiMultimodal({
        model: MODEL,
        parts: [{ text: synthesisPrompt(category.id, category.focus, JSON.stringify(observations)) }],
        json: true,
        temperature: 0.2,
        maxOutputTokens: 1400,
        thinkingBudget: 0,
        onUsage: track,
      })
      try {
        const parsed = JSON.parse(text)
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
      const output = {
        categorie: category.id,
        version: 2,
        source: category.folder,
        images_totales: all.length,
        images_analysees: picked.length,
        exemplaires: manifest.length,
        genere_le: new Date().toISOString(),
        modele: MODEL,
        guide: guideJson,
      }
      writeFileSync(join(STYLES_DIR, `${category.id}.json`), JSON.stringify(output, null, 2))
      log(`  ✓ guide v2 écrit (${JSON.stringify(guideJson).length} chars)`)
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

  const totalCost = estimateCostEur({ model: MODEL, tokensIn: totals.tokensIn, tokensOut: totals.tokensOut })
  const finalReport = {
    execute_le: new Date().toISOString(),
    version: 2,
    modele: MODEL,
    mode: DRY ? 'dry-run' : `sync (lots de ${CHUNK_SIZE} images/appel)`,
    note_batch: "Volume one-shot ≈ centimes : le mode Batch asynchrone (−50 %) n'apporte que ~la moitié d'un café. Prix batch théorique = cout_total_eur × 0,5.",
    categories: report,
    total: DRY ? null : {
      appels: totals.calls,
      tokens_in: totals.tokensIn,
      tokens_out: totals.tokensOut,
      cout_total_eur: totalCost,
      cout_batch_theorique_eur: Math.round(totalCost * 0.5 * 10000) / 10000,
    },
  }
  writeFileSync(join(STYLES_DIR, '_training-report-v2.json'), JSON.stringify(finalReport, null, 2))
  log(`\nRapport : ${join(STYLES_DIR, '_training-report-v2.json')}`)
  if (!DRY) log(`COÛT TOTAL : ${totalCost.toFixed(4)} € (${totals.calls} appels, ${totals.tokensIn + totals.tokensOut} tokens)`)
}

await run()
