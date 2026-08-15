/*
 * Pipeline d'entraînement FiveM — one-shot (run 5, LOT 2).
 *
 * Scanne le dossier d'entraînement du client, sélectionne ≤ 12 images
 * représentatives par catégorie (diversité ratio × luminosité), les analyse
 * par lots de 4 via l'API vision, puis synthétise UN guide de style compact
 * (JSON ≤ 800 tokens) par catégorie dans src/engine/styles/fivem/.
 * Les guides sont versionnés : l'entraînement ne se repaie jamais.
 *
 * Usage :  bun run scripts/train-fivem.ts [--dry] [--only=<categorie>]
 *   --dry : inventaire + sélection seulement, zéro appel API, coût 0.
 *
 * Coût : chaque appel est compté (usageMetadata) et le total en € est
 * écrit dans src/engine/styles/fivem/_training-report.json.
 */

import { readdirSync, mkdirSync, writeFileSync } from 'fs'
import { join, resolve, extname } from 'path'
import sharp from 'sharp'
import { geminiMultimodal, type GeminiPart, type GeminiUsage } from '../src/lib/ai/gemini'
import { estimateCostEur } from '../src/lib/engine/pricing'

const SOURCE_DIR = resolve(import.meta.dir, '../../entrainement IA fivem')
const OUT_DIR = resolve(import.meta.dir, '../src/engine/styles/fivem')
const MODEL = 'gemini-3.5-flash'
const MAX_PER_CATEGORY = 12
const CHUNK_SIZE = 4
const GUIDE_TOKEN_BUDGET = 800

// Dossier client → catégorie moteur. `focus` oriente l'analyse.
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

type CategoryUsage = { calls: number; tokensIn: number; tokensOut: number }

const args = new Set(process.argv.slice(2))
const DRY = args.has('--dry')
const only = [...args].find((a) => a.startsWith('--only='))?.slice(7)

function log(msg: string) {
  console.log(msg)
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

async function toInlinePart(img: ImageInfo): Promise<GeminiPart> {
  const buffer = await sharp(img.path)
    .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer()
  return { inlineData: { mimeType: 'image/jpeg', data: buffer.toString('base64') } }
}

const ANALYSIS_SYSTEM = `You are a senior art director reverse-engineering premium FiveM/GTA RP visuals.
For EACH image provided (in order), return a compact JSON object. Answer with a JSON array, one object per image, nothing else.
Each object:
{
  "composition": "framing, focal point, subject placement, depth layers — with rough proportions (e.g. 'subject occupies left 40%')",
  "typo": "typography treatment IF text exists: hierarchy, weight, case, placement, how the title interacts with the subject (e.g. 'giant title behind/through subject'), effects on the lettering. 'none' if no text",
  "lumiere": "light sources, direction, temperature, rim/practicals",
  "etalonnage": "color grading: dominant hues (hex-ish), contrast character, saturation strategy",
  "effets": "recurring effects: grain, glow, particles, smoke, halftone, topographic lines, textures",
  "logo": "logo presence and placement. 'none' if absent",
  "ratio": "aspect ratio as W:H",
  "premium": "1 thing that makes it feel professional",
  "amateur": "1 weakness or amateur marker, or 'none'"
}
Be terse and concrete. No prose outside JSON.`

function synthesisPrompt(categoryId: string, focus: string, observations: string): string {
  return `You are distilling training observations into ONE compact style guide for generating new ${focus}.

OBSERVATIONS (per-image analyses):
${observations}

Produce a single JSON object — the style guide — with EXACTLY these keys:
{
  "categorie": "${categoryId}",
  "composition": ["3-5 concrete rules with numbers/proportions"],
  "typographie": ["2-4 rules describing how REAL text layers should be placed and styled over these visuals (hierarchy, scale vs frame, interaction with subject). These rules guide a compositor placing text AFTER generation"],
  "lumiere": ["2-4 lighting rules"],
  "etalonnage": ["2-4 color grading rules, name dominant hue families"],
  "effets": ["2-4 recurring finishing effects worth reproducing"],
  "logo": ["1-2 rules for logo placement"],
  "interdits": ["3-5 amateur markers to avoid, from the observations"],
  "ratios": ["dominant aspect ratios seen"]
}

HARD CONSTRAINTS:
- The ENTIRE JSON must stay under ${GUIDE_TOKEN_BUDGET} tokens (~${GUIDE_TOKEN_BUDGET * 4} characters). Be dense, drop redundancy.
- Rules must be specific and actionable (numbers, positions, proportions), never generic advice.
- English, telegraphic style. JSON only.`
}

async function run() {
  log(`Source : ${SOURCE_DIR}`)
  log(`Sortie : ${OUT_DIR}`)
  mkdirSync(OUT_DIR, { recursive: true })

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

    // Analyse par lots de CHUNK_SIZE images
    const observations: unknown[] = []
    for (let i = 0; i < picked.length; i += CHUNK_SIZE) {
      const chunk = picked.slice(i, i + CHUNK_SIZE)
      const parts: GeminiPart[] = [
        { text: `Analyze these ${chunk.length} images. Context: ${category.focus}.` },
        ...(await Promise.all(chunk.map(toInlinePart))),
      ]
      const text = await geminiMultimodal({
        model: MODEL,
        parts,
        systemInstruction: ANALYSIS_SYSTEM,
        json: true,
        temperature: 0.15,
        maxOutputTokens: 2400,
        thinkingBudget: 0,
        onUsage: track,
      })
      try {
        const parsed = JSON.parse(text)
        observations.push(...(Array.isArray(parsed) ? parsed : [parsed]))
        log(`  lot ${i / CHUNK_SIZE + 1} : ${chunk.length} images analysées`)
      } catch {
        log(`  ! lot ${i / CHUNK_SIZE + 1} : JSON invalide, ignoré`)
      }
    }

    // Synthèse → guide compact
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
      log(`  ✗ ÉCHEC synthèse ${category.id}`)
      continue
    }

    const guideChars = JSON.stringify(guideJson).length
    const costEur = estimateCostEur({ model: MODEL, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut })
    const output = {
      categorie: category.id,
      source: category.folder,
      images_totales: all.length,
      images_analysees: picked.length,
      genere_le: new Date().toISOString(),
      modele: MODEL,
      guide: guideJson,
    }
    writeFileSync(join(OUT_DIR, `${category.id}.json`), JSON.stringify(output, null, 2))
    log(`  ✓ guide écrit (${guideChars} chars ≈ ${Math.round(guideChars / 4)} tokens) — ${usage.calls} appels, ${usage.tokensIn} tk in, ${usage.tokensOut} tk out, ${costEur.toFixed(4)} €`)

    totals.calls += usage.calls
    totals.tokensIn += usage.tokensIn
    totals.tokensOut += usage.tokensOut
    report.push({
      categorie: category.id,
      images_totales: all.length,
      analysees: picked.length,
      appels: usage.calls,
      tokens_in: usage.tokensIn,
      tokens_out: usage.tokensOut,
      cout_eur: costEur,
      guide_tokens_approx: Math.round(guideChars / 4),
    })
  }

  const totalCost = estimateCostEur({ model: MODEL, tokensIn: totals.tokensIn, tokensOut: totals.tokensOut })
  const finalReport = {
    execute_le: new Date().toISOString(),
    modele: MODEL,
    mode: DRY ? 'dry-run' : 'sync (lots de 4 images/appel)',
    note_batch: "Volume one-shot ≈ centimes : le mode Batch asynchrone (−50 %) n'apporte que ~la moitié d'un café. Chiffré ci-dessous en sync, prix batch théorique = cout_total_eur × 0,5.",
    categories: report,
    total: DRY ? null : {
      appels: totals.calls,
      tokens_in: totals.tokensIn,
      tokens_out: totals.tokensOut,
      cout_total_eur: totalCost,
      cout_batch_theorique_eur: Math.round(totalCost * 0.5 * 10000) / 10000,
    },
  }
  writeFileSync(join(OUT_DIR, '_training-report.json'), JSON.stringify(finalReport, null, 2))
  log(`\nRapport : ${join(OUT_DIR, '_training-report.json')}`)
  if (!DRY) log(`COÛT TOTAL : ${totalCost.toFixed(4)} € (${totals.calls} appels, ${totals.tokensIn + totals.tokensOut} tokens)`)
}

await run()
