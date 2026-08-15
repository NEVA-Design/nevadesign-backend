/*
 * LOT 7 — Agrégation des coûts réels du run.
 * Sources : generation_logs (dev-store), rapports one-shot (entraînement,
 * templates, vignettes), démos, banc de refus. Produit le tableau de coût
 * par type d'asset comparé au modèle économique.
 *
 * Usage : bun run scripts/cost-report.ts
 * Sortie : ../rapports/run5-couts.json + tableau console
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const ROOT = resolve(import.meta.dir, '..')
const RAPPORTS = resolve(ROOT, '../rapports')

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return null
  }
}

type LogRow = {
  kind: string
  model: string
  resolution: string | null
  images_out: number
  tokens_in: number | null
  tokens_out: number | null
  cost_eur: number | string | null
  refused: boolean
  retried: boolean
  duration_ms?: number | null
}

const store = readJson<{ generation_logs?: LogRow[] }>(resolve(ROOT, 'data/dev-store.json'))
const logs = store?.generation_logs ?? []

// Coût par kind depuis les journaux
const byKind = new Map<string, { appels: number; images: number; tokens: number; eur: number; refus: number; retries: number; dureeMoy: number }>()
for (const row of logs) {
  const entry = byKind.get(row.kind) ?? { appels: 0, images: 0, tokens: 0, eur: 0, refus: 0, retries: 0, dureeMoy: 0 }
  entry.appels += 1
  entry.images += row.images_out ?? 0
  entry.tokens += (row.tokens_in ?? 0) + (row.tokens_out ?? 0)
  entry.eur += Number(row.cost_eur ?? 0)
  entry.refus += row.refused ? 1 : 0
  entry.retries += row.retried ? 1 : 0
  entry.dureeMoy += row.duration_ms ?? 0
  byKind.set(row.kind, entry)
}
for (const entry of byKind.values()) entry.dureeMoy = Math.round(entry.dureeMoy / Math.max(1, entry.appels))

// Coût par PARCOURS type (mesuré sur les générations réelles du run)
const kindEur = (kind: string) => byKind.get(kind)?.eur ?? 0
const kindImages = (kind: string) => byKind.get(kind)?.images ?? 0
const perImage = (kind: string) => (kindImages(kind) ? kindEur(kind) / kindImages(kind) : 0)

const parcours = {
  logo_complet: {
    detail: '3 propositions 1K (flash-image) + 1 master 4K (pro-image) + détourage local',
    eur: 3 * perImage('logo_proposal') + perImage('logo_master'),
  },
  banniere_1k_editee: {
    detail: '1 scène 1K (pro-image) + calques texte/logo/effets locaux',
    eur: perImage('scene_banniere_discord'),
  },
  export_hd: {
    detail: 'compositing serveur seul (≤ 1400 px) — zéro appel API',
    eur: 0,
  },
  export_2k_4k: {
    detail: 'compositing + re-rendu scène à la résolution du plan',
    eur: perImage('export_scene_banniere_discord'),
  },
  retouche: {
    detail: '1 re-génération de scène 1K',
    eur: perImage('scene_banniere_discord'),
  },
}

const oneShots = {
  entrainement: readJson<{ total?: { cout_total_eur: number } }>(resolve(ROOT, 'src/engine/styles/fivem/_training-report.json'))?.total?.cout_total_eur ?? null,
  templates_scenes: readJson<{ cout?: { eur: number } }>(resolve(ROOT, 'src/engine/templates/fivem/scenes.json'))?.cout?.eur ?? null,
  demos: readJson<{ cout_total_eur: number }>(resolve(RAPPORTS, 'demos/demos-report.json'))?.cout_total_eur ?? null,
  banc_refus: readJson<{ cout_test_eur: number }>(resolve(RAPPORTS, 'run5-refus.json'))?.cout_test_eur ?? null,
}

const totalLogs = [...byKind.values()].reduce((sum, entry) => sum + entry.eur, 0)

const output = {
  genere_le: new Date().toISOString(),
  note: 'Coûts en € estimés depuis usageMetadata + grille pricing.ts (à recaler sur la première facture Google Cloud réelle).',
  par_kind: Object.fromEntries([...byKind.entries()].map(([kind, entry]) => [kind, {
    appels: entry.appels,
    images: entry.images,
    tokens: entry.tokens,
    eur: Math.round(entry.eur * 1000) / 1000,
    refus: entry.refus,
    reformulations: entry.retries,
    duree_moyenne_ms: entry.dureeMoy,
  }])),
  cout_par_parcours_type: Object.fromEntries(Object.entries(parcours).map(([key, value]) => [key, { ...value, eur: Math.round(value.eur * 1000) / 1000 }])),
  modele_eco: {
    hypothese: 'création ≈ 0,50-1,40 € de coût API selon plan (prix de vente 2,00-2,90 €/création)',
    verdict_logo: `${(3 * perImage('logo_proposal') + perImage('logo_master')).toFixed(2)} € par logo complet`,
    verdict_banniere: `${(perImage('scene_banniere_discord') + perImage('export_scene_banniere_discord')).toFixed(2)} € par bannière avec export 2K (hors retouches)`,
  },
  one_shots_non_recurrents: oneShots,
  total_generation_logs_eur: Math.round(totalLogs * 1000) / 1000,
}

writeFileSync(resolve(RAPPORTS, 'run5-couts.json'), JSON.stringify(output, null, 2))
console.log(JSON.stringify(output, null, 2))
console.log(`\n→ ${resolve(RAPPORTS, 'run5-couts.json')}`)
if (!existsSync(resolve(RAPPORTS, 'demos/demos-report.json'))) console.log('(demos-report.json absent — relancer après les démos)')
