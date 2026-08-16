/**
 * Run 5.7 — LOT 1.5 : synthèse des recettes de calques.
 *
 * Croise `_vision-summary.json` (rôles par calque, ordre z) et `_inventory.json`
 * (distributions d'effets, calques texte) pour écrire la clé versionnée
 * `recettes_calques` dans src/engine/styles/fivem/logo.json :
 *   - l'ordre de pile canonique (position z médiane de chaque rôle sur les 13 PSD)
 *   - les piles compressées par PSD (preuve)
 *   - les paramètres chiffrés par effet (médianes/quartiles de la distribution PSD —
 *     plus jamais de valeurs inventées)
 *   - les fréquences de rôles et le premier chiffrage de l'arbitrage lettrage
 *
 * Zéro appel API. Usage : bun scripts/psd-recettes.ts [--dry]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type Json = Record<string, unknown>

const ROOT = join(import.meta.dir, '..', 'src', 'engine', 'psd-knowledge')
const LOGO_JSON = join(import.meta.dir, '..', 'src', 'engine', 'styles', 'fivem', 'logo.json')
const DRY = process.argv.includes('--dry')

const vision = JSON.parse(readFileSync(join(ROOT, '_vision-summary.json'), 'utf8')) as {
  modele: string
  psds: { psd: string; dir: string; pile: (Json & { id: number; kind: string; role?: string; lettrage_nature?: string })[] }[]
}
const inventory = JSON.parse(readFileSync(join(ROOT, '_inventory.json'), 'utf8')) as Json

// ── 1. ordre canonique : position z relative médiane de chaque rôle ──────────
// (dans les manifests, l'index 0 est le BAS de la pile Photoshop)
const positions = new Map<string, number[]>()
const roleCounts = new Map<string, number>()
for (const p of vision.psds) {
  const pile = p.pile.filter((c) => c.role && c.role !== 'autre' && c.kind !== 'group')
  pile.forEach((c, i) => {
    const rel = pile.length > 1 ? i / (pile.length - 1) : 0.5
    positions.set(c.role!, [...(positions.get(c.role!) ?? []), rel])
    roleCounts.set(c.role!, (roleCounts.get(c.role!) ?? 0) + 1)
  })
}
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!
const ordreCanonique = [...positions.entries()]
  .map(([role, rels]) => ({ role, z_median: Math.round(median(rels) * 100) / 100, n: rels.length }))
  .sort((a, b) => a.z_median - b.z_median)

// ── 2. piles compressées par PSD (séquences de rôles bas → haut) ─────────────
const piles = vision.psds.map((p) => {
  const seq: string[] = []
  for (const c of p.pile) {
    if (!c.role || c.role === 'autre' || c.kind === 'group') continue
    const last = seq[seq.length - 1]
    const tag = c.role + (c.kind === 'text' ? '(texte)' : '')
    if (last === tag) {
      const m = last.match(/^(.*?)(?:×(\d+))?$/)
      seq[seq.length - 1] = `${tag}×${m?.[2] ? Number(m[2]) + 1 : 2}`
    } else seq.push(tag)
  }
  return { psd: p.psd, pile_bas_vers_haut: seq }
})

// ── 3. paramètres chiffrés par effet (distribution PSD, pas d'invention) ─────
const fx = (inventory.effects ?? {}) as Json
function pick(type: string): Json | undefined {
  const st = fx[type] as Json | undefined
  if (!st) return undefined
  const out: Json = { occurrences: st.enabledCount, psds: (st.psds as string[]).length }
  for (const k of ['size', 'distance', 'choke', 'opacity']) {
    const d = st[k] as Json | undefined
    if (d) out[k] = { median: d.median, p25: d.p25, p75: d.p75, min: d.min, max: d.max }
  }
  if (st.colors) out.couleurs = st.colors
  if (st.positions) out.positions = st.positions
  if (type === 'gradientOverlay') {
    out.exemples_stops = ((st.samples as Json[]) ?? [])
      .filter((s) => s.gradientStops)
      .slice(0, 8)
      .map((s) => ({ psd: s.psd, angle: s.angle, stops: s.gradientStops }))
  }
  return out
}
const parametres: Json = {}
for (const t of ['stroke', 'gradientOverlay', 'dropShadow', 'outerGlow', 'innerGlow', 'innerShadow', 'bevel', 'solidFill']) {
  const v = pick(t)
  if (v) parametres[t] = v
}

// ── 4. fréquences de rôles + arbitrage lettrage ──────────────────────────────
const totalRoles = [...roleCounts.values()].reduce((a, b) => a + b, 0)
const frequences_roles = Object.fromEntries(
  [...roleCounts.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => [r, { n, pct: Math.round((n / totalRoles) * 100) }])
)

let lettrageTexte = 0, lettrageTypographieRaster = 0, lettrageCustom = 0
for (const p of vision.psds) {
  for (const c of p.pile) {
    const isLettrage = c.role === 'lettrage' || c.role === 'ui_texte_secondaire'
    if (!isLettrage) continue
    if (c.kind === 'text') lettrageTexte++
    else if (c.lettrage_nature === 'typographie') lettrageTypographieRaster++
    else if (c.lettrage_nature === 'custom_dessine') lettrageCustom++
  }
}

const recettes = {
  version: 1,
  source: `PackPsd — 13 PSD professionnels décomposés (ag-psd), vision ${vision.modele} sur calques isolés`,
  genere_le: new Date().toISOString(),
  ordre_pile_canonique: ordreCanonique,
  ordre_type_resume:
    'fond → textures (papier/roche, opacités 10-30 %) → effets lumière (glows larges) → emblème/mascotte → lettrage (texte + styles) → accents/ui — réglages colorimétriques au sommet',
  piles_par_psd: piles,
  parametres_effets: parametres,
  frequences_roles,
  arbitrage_lettrage: {
    calques_texte_photoshop: lettrageTexte,
    lettrage_typographie_rasterise: lettrageTypographieRaster,
    lettrage_custom_dessine: lettrageCustom,
    note: 'LOT 2 : (a) texte+styles / (b) custom importé / (c) généré — verdict au rapport',
  },
}

console.log(JSON.stringify({ ordre: ordreCanonique, frequences_roles, arbitrage: recettes.arbitrage_lettrage }, null, 1))
if (!DRY) {
  const logo = JSON.parse(readFileSync(LOGO_JSON, 'utf8')) as Json
  logo.recettes_calques = recettes
  writeFileSync(LOGO_JSON, JSON.stringify(logo, null, 2))
  console.log(`recettes_calques v${recettes.version} écrite dans ${LOGO_JSON}`)
}
