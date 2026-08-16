/*
 * Run 5.7 (session 3) — LA GARDE BUDGET DURE de la session de calibration.
 *
 * Le plafond n'est pas une promesse : c'est un intercepteur installé sur
 * globalThis.fetch. TOUT appel à l'API Gemini (director, génération image,
 * OCR, critique, jury, analyse de fonds) passe par lui :
 *   1. AVANT l'envoi : si dépense + réserve conservatrice de l'appel > CAP_EUR,
 *      l'appel est REFUSÉ (BudgetExceededError) — il ne part jamais.
 *   2. APRÈS la réponse : le coût réel est calculé depuis usageMetadata
 *      (tokens) + le nombre d'images retournées, via la grille pricing.ts,
 *      puis persisté dans le grand livre (captures/calibration/budget-ledger-3.json).
 * Le grand livre survit aux redémarrages : le plafond vaut pour LA SESSION
 * DE CALIBRATION entière, pas pour un lancement de script.
 * Les grands livres des runs 5.5 (budget-ledger.json, 5,195 € / 10 €) et
 * 5.6 (budget-ledger-2.json, 4,32 € / 6 €) restent intacts pour l'historique —
 * le run 5.7 démarre sur une ENVELOPPE NEUVE de 6,00 € (clone test + calibration ;
 * la passe vision sur calques PSD y est aussi débitée, par prudence).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { estimateCostEur } from '../../src/lib/engine/pricing'

// ── LES SEUILS — codés ici, nulle part ailleurs ──────────────────────────────
export const CAP_EUR = 6.0 // plafond DUR : aucun appel au-delà
export const CHECKPOINT_EUR = 3.0 // bilan intermédiaire obligatoire au journal
export const STOP_SANS_CONVERGENCE_EUR = 4.5 // STOP volontaire si pas de convergence

export const CALIBRATION_DIR = resolve(import.meta.dir, '../../../captures/calibration')
const LEDGER_PATH = join(CALIBRATION_DIR, 'budget-ledger-3.json')

export class BudgetExceededError extends Error {
  readonly code = 'budget_exceeded'
  constructor(spent: number, reserve: number) {
    super(
      `PLAFOND CALIBRATION ATTEINT : ${spent.toFixed(4)} € dépensés + ${reserve.toFixed(2)} € réservés > ${CAP_EUR.toFixed(2)} € — appel refusé avant envoi.`
    )
  }
}

type LedgerEntry = {
  at: string
  label: string
  model: string
  tokensIn: number
  tokensOut: number
  imagesOut: number
  resolution: string | null
  eur: number
}

type Ledger = { spentEur: number; entries: LedgerEntry[] }

function loadLedger(): Ledger {
  if (!existsSync(LEDGER_PATH)) return { spentEur: 0, entries: [] }
  try {
    return JSON.parse(readFileSync(LEDGER_PATH, 'utf-8')) as Ledger
  } catch {
    return { spentEur: 0, entries: [] }
  }
}

function saveLedger(ledger: Ledger) {
  mkdirSync(dirname(LEDGER_PATH), { recursive: true })
  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2))
}

export function spentEur(): number {
  return loadLedger().spentEur
}

// Étiquette de l'étape en cours — apparaît dans le grand livre pour que le
// journal puisse ventiler le coût par itération.
let currentLabel = 'calibration'
export function setBudgetLabel(label: string) {
  currentLabel = label
}

// Réserve conservatrice AVANT envoi : une génération image coûte au plus
// ~0,25 € (image 2K + thinking), un appel texte/vision au plus ~0,10 €.
// Le pré-contrôle garantit que même le pire appel ne crève pas le plafond.
function reserveFor(body: string): number {
  return body.includes('"responseModalities"') ? 0.35 : 0.1
}

function modelFromUrl(url: string): string {
  const m = url.match(/\/models\/([^:]+):/)
  return m?.[1] ?? 'inconnu'
}

type GeminiUsageMetadata = {
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  candidates?: Array<{ content?: { parts?: Array<{ inlineData?: unknown }> } }>
}

let installed = false

export function installBudgetGuard() {
  if (installed) return
  installed = true

  const realFetch = globalThis.fetch.bind(globalThis)
  // @ts-expect-error — remplacement volontaire : la garde EST le point de passage
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.includes('generativelanguage.googleapis.com')) return realFetch(input as never, init)

    const body = typeof init?.body === 'string' ? init.body : ''
    const ledger = loadLedger()
    const reserve = reserveFor(body)
    // ── LE REFUS DUR : l'appel ne part pas si le plafond serait crevé ──────
    if (ledger.spentEur + reserve > CAP_EUR) {
      throw new BudgetExceededError(ledger.spentEur, reserve)
    }

    const res = await realFetch(input as never, init)
    const text = await res.text()

    let usage: GeminiUsageMetadata | null = null
    try {
      usage = JSON.parse(text) as GeminiUsageMetadata
    } catch {
      usage = null
    }

    const model = modelFromUrl(url)
    const tokensIn = usage?.usageMetadata?.promptTokenCount ?? 0
    const tokensOut = usage?.usageMetadata?.candidatesTokenCount ?? 0
    const imagesOut =
      usage?.candidates?.reduce(
        (n, c) => n + (c.content?.parts?.filter((p) => p.inlineData).length ?? 0),
        0
      ) ?? 0
    const resolution = body.match(/"imageSize"\s*:\s*"(\d)K"/)?.[1] ? `${body.match(/"imageSize"\s*:\s*"(\d)K"/)?.[1]}K` : null
    // usage illisible (réponse non-JSON) : débit forfaitaire conservateur
    const eur = usage
      ? estimateCostEur({ model, tokensIn, tokensOut, imagesOut, resolution })
      : 0.05

    const fresh = loadLedger()
    fresh.spentEur = Math.round((fresh.spentEur + eur) * 10_000) / 10_000
    fresh.entries.push({
      at: new Date().toISOString(),
      label: currentLabel,
      model,
      tokensIn,
      tokensOut,
      imagesOut,
      resolution,
      eur,
    })
    saveLedger(fresh)

    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers })
  }
}

// Coût d'une étiquette (itération) — pour le journal.
export function spentForLabel(label: string): number {
  const ledger = loadLedger()
  return (
    Math.round(
      ledger.entries.filter((e) => e.label === label).reduce((s, e) => s + e.eur, 0) * 10_000
    ) / 10_000
  )
}

export function ledgerSummary(): { spentEur: number; parLabel: Array<{ label: string; eur: number; appels: number }> } {
  const ledger = loadLedger()
  const byLabel = new Map<string, { eur: number; appels: number }>()
  for (const e of ledger.entries) {
    const cur = byLabel.get(e.label) ?? { eur: 0, appels: 0 }
    cur.eur += e.eur
    cur.appels += 1
    byLabel.set(e.label, cur)
  }
  return {
    spentEur: ledger.spentEur,
    parLabel: [...byLabel.entries()].map(([label, v]) => ({ label, eur: Math.round(v.eur * 10_000) / 10_000, appels: v.appels })),
  }
}
