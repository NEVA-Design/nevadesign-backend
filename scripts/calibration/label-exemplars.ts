/*
 * Run 5.9, chantier 1 — étiquetage automatique du corpus, TOUTE SA LARGEUR.
 * On ne trie pas, on n'exclut rien : le corpus couvre volontairement tous les
 * styles (exigence produit). Cette passe vision en raisonnement haut écrit
 * dans le manifest, pour chacun des 59 exemplaires :
 *   - famille de rendu (plat_premium | semi_flat_biseau | dimensionnelle)
 *   - traitement du lettrage (chrome | or | neon | script | extrusion_3d |
 *     flat_outline | autre | aucun)
 *   - matière dominante, présence/type d'emblème, ambiance, fond sombre
 * pickExemplars s'en sert ensuite : même famille obligatoire + meilleur
 * recouvrement matière/traitement, fichiers haute résolution privilégiés.
 * Rejouable après tout ré-entraînement. Débit : budget-ledger-4.
 */

import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { geminiMultimodal } from '../../src/lib/ai/gemini'
import type { GeminiPart } from '../../src/lib/ai/gemini'
import { installBudgetGuard, setBudgetLabel, spentEur } from './budget4'

installBudgetGuard()
setBudgetLabel('chantier1_etiquetage')

const EXEMPLARS_DIR = join(import.meta.dir, '..', '..', 'src', 'engine', 'exemplars', 'fivem', 'logo')
const MODEL = 'gemini-3.1-pro-preview'

export type ExemplarStyle = {
  famille: 'plat_premium' | 'semi_flat_biseau' | 'dimensionnelle'
  traitement_lettrage: 'chrome' | 'or' | 'neon' | 'script' | 'extrusion_3d' | 'flat_outline' | 'autre' | 'aucun'
  matiere: string
  embleme: { present: boolean; type: string | null }
  ambiance: string
  fond_sombre: boolean
}

const manifestPath = join(EXEMPLARS_DIR, '_manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
  exemplaires: Array<{ slug: string; famille?: string; style?: ExemplarStyle; resolution_native?: number }>
}

const PROMPT_HEAD = `You are auditing a corpus of professional FiveM/GTA RP server logos. For EACH numbered image below, return one JSON entry describing what the image ACTUALLY SHOWS (not what it should show). Fields:
- "slug": copied from the image label
- "famille": "plat_premium" (flat premium silhouette/lettering, color is the shape) | "semi_flat_biseau" (semi-flat, matte bevels, contour glow) | "dimensionnelle" (deep 3D extrusion/bevel, dramatic lighting)
- "traitement_lettrage": dominant lettering treatment — "chrome" | "or" (gold) | "neon" | "script" (cursive/script lettering, any material) | "extrusion_3d" | "flat_outline" | "autre" | "aucun" (no lettering)
- "matiere": dominant material in 2-4 English words (e.g. "brushed chrome", "glossy plastic", "satin vinyl", "matte flat")
- "embleme": { "present": true|false, "type": short English noun or null (e.g. "citrus slice", "dolphin", "palm tree", "star") }
- "ambiance": one of "summer" | "urban" | "esport" | "luxury" | "dark" | "retro" | "festive" | "tropical" | "other"
- "fond_sombre": true if the background is dark (value < mid-grey), false otherwise
Answer ONLY with JSON: {"entries": [{...}, ...]} — exactly one entry per image, same order.`

const CHUNK = Number(process.argv[2] ?? 6)
// Persistance incrémentale : le JSON tronqué (thinking qui mange la sortie —
// piège connu du run 5.5) ne doit pas re-payer les chunks déjà réussis.
const PARTIAL_PATH = join(import.meta.dir, '..', '..', '..', 'captures', 'calibration', '_audit-run59', 'labels-partial.json')
const results = new Map<string, ExemplarStyle>(
  (() => {
    try {
      return Object.entries(JSON.parse(readFileSync(PARTIAL_PATH, 'utf-8')) as Record<string, ExemplarStyle>)
    } catch {
      return []
    }
  })()
)

const entries = manifest.exemplaires.filter((e) => !results.has(e.slug))
console.log(`${results.size} déjà étiquetés (reprise) — ${entries.length} restants`)

for (let i = 0; i < entries.length; i += CHUNK) {
  const chunk = entries.slice(i, i + CHUNK)
  const parts: GeminiPart[] = [{ text: PROMPT_HEAD }]
  for (const e of chunk) {
    parts.push({ text: `IMAGE — slug "${e.slug}":` })
    parts.push({
      inlineData: { mimeType: 'image/jpeg', data: readFileSync(join(EXEMPLARS_DIR, `${e.slug}.jpg`)).toString('base64') },
    })
  }
  console.log(`chunk ${i / CHUNK + 1}/${Math.ceil(entries.length / CHUNK)} (${chunk.map((e) => e.slug).join(', ')})`)
  let parsed: { entries: Array<ExemplarStyle & { slug: string }> } | null = null
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    if (attempt > 0) console.error(`  ✗ JSON illisible, chunk relancé une fois`)
    const raw = await geminiMultimodal({
      model: MODEL,
      parts,
      temperature: 0,
      maxOutputTokens: 12000,
      json: true,
      thinkingLevel: 'high',
    })
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
  }
  if (!parsed) {
    console.error(`  ✗✗ chunk abandonné après 2 tentatives — slugs : ${chunk.map((e) => e.slug).join(', ')}`)
    continue
  }
  for (const item of parsed.entries ?? []) {
    const { slug, ...style } = item
    results.set(slug, style as ExemplarStyle)
  }
  writeFileSync(PARTIAL_PATH, JSON.stringify(Object.fromEntries(results), null, 1))
  console.log(`  ✓ ${results.size} étiquetés — cumul ${spentEur().toFixed(4)} €`)
}

let divergences = 0
for (const e of manifest.exemplaires) {
  const style = results.get(e.slug)
  if (!style) {
    console.warn(`  ! pas d'étiquette pour ${e.slug}`)
    continue
  }
  if (e.famille && e.famille !== style.famille) {
    console.log(`  divergence famille ${e.slug} : ${e.famille} → ${style.famille} (vision HQ fait foi)`)
    divergences++
  }
  e.famille = style.famille
  e.style = style
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 1))
console.log(`\nManifest écrit — ${results.size}/${manifest.exemplaires.length} étiquetés, ${divergences} familles corrigées, dépense ${spentEur().toFixed(4)} €`)
