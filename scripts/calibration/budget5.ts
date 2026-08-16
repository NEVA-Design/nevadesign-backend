/*
 * Run 5.10 (session 5, pivot rendu intégral) — garde budget dure, enveloppe NEUVE.
 * Mandat opérateur du 16/08 : 3,00 € pour le run de validation du pivot
 * (3 familles fruitz en rendu intégral + preuve d'isolation chantier 2).
 * Même mécanique que budget4.ts : intercepteur sur globalThis.fetch, refus
 * AVANT envoi, grand livre persistant budget-ledger-5.json. Les ledgers des
 * sessions 2-4 restent intacts pour l'historique.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { estimateCostEur } from '../../src/lib/engine/pricing'

export const CAP_EUR = 3.0 // plafond DUR session 5 — mandat opérateur
// compat harnais iterate.ts (mêmes noms que budget4.ts)
export const CHECKPOINT_EUR = 1.5
export const STOP_SANS_CONVERGENCE_EUR = 2.5

export const CALIBRATION_DIR = resolve(import.meta.dir, '../../../captures/calibration')
const LEDGER_PATH = join(CALIBRATION_DIR, 'budget-ledger-5.json')

export class BudgetExceededError extends Error {
  readonly code = 'budget_exceeded'
  constructor(spent: number, reserve: number, cap: number) {
    super(
      `PLAFOND SESSION 5 ATTEINT : ${spent.toFixed(4)} € dépensés + ${reserve.toFixed(2)} € réservés > ${cap.toFixed(2)} € — appel refusé avant envoi.`
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

let currentLabel = 'session5'
export function setBudgetLabel(label: string) {
  currentLabel = label
}

let activeCap = CAP_EUR
export function setActiveCap(cap: number) {
  activeCap = Math.min(cap, CAP_EUR)
}

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
    if (ledger.spentEur + reserve > activeCap) {
      throw new BudgetExceededError(ledger.spentEur, reserve, activeCap)
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

export function spentForLabel(label: string): number {
  const ledger = loadLedger()
  return (
    Math.round(
      ledger.entries.filter((e) => e.label === label).reduce((s, e) => s + e.eur, 0) * 10_000
    ) / 10_000
  )
}
