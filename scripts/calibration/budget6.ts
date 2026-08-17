/*
 * Run 6 (session 6, pipeline logo v6) — garde budget dure, enveloppe NEUVE.
 * Mandat opérateur du 16/08 : 3,00 € pour le plan d'expériences §9 du
 * document v6 (E1 calibration de la mesure, puis E2-E5 une variable à la
 * fois, ~1,7 € estimés + marge de reprise).
 * Même mécanique que budget5.ts : intercepteur sur globalThis.fetch, refus
 * AVANT envoi, grand livre persistant budget-ledger-6.json. Les ledgers des
 * sessions 2-5 restent intacts pour l'historique.
 *
 * Note v6 : la garde n'intercepte que generativelanguage.googleapis.com. Si
 * l'adaptateur Anthropic du DA (logo-director-v6.ts) est un jour activé, sa
 * facturation est SÉPARÉE et n'apparaît pas dans ce ledger — c'est dit à
 * l'opérateur, jamais masqué.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { estimateCostEur } from '../../src/lib/engine/pricing'

/*
 * Plafond DUR session 6.
 *   16/08 — 3,00 € (mandat initial).
 *   17/08 — 3,25 € : rallonge accordée par l'opérateur pour le dernier tir du
 *   pivot idiome. À 2,5570 € dépensés, les 3 rendus demandaient ~0,49 € quand
 *   il restait 0,4430 € ; sans rallonge la garde aurait refusé la troisième
 *   image AVANT envoi et laissé une série de deux — 0,44 € pour un résultat
 *   incomparable. Les 0,25 € couvrent les 3 images ET un rejet OCR éventuel.
 *   17/08 (fin) — 3,40 € : le rendu d'azure, redemandé par l'opérateur au prix
 *   annoncé (~0,14 €). Son image précédente avait été payée puis perdue faute
 *   d'être écrite avant la porte OCR — le défaut est corrigé, la dépense non.
 *   3,35 € aurait suffi à la DÉPENSE (3,338 € attendus) mais pas à la RÉSERVE
 *   de 0,16 € que la garde retient avant envoi : un plafond doit accueillir la
 *   réserve, sinon c'est la réserve qu'on rogne — et une réserve rognée pour
 *   faire passer un appel ne protège plus rien.
 *   Dernier appel de la session : la calibration s'arrête après.
 */
export const CAP_EUR = 3.4
// compat harnais iterate.ts (mêmes noms que budget4.ts/budget5.ts)
export const CHECKPOINT_EUR = 1.5
export const STOP_SANS_CONVERGENCE_EUR = 2.5

export const CALIBRATION_DIR = resolve(import.meta.dir, '../../../captures/calibration')
const LEDGER_PATH = join(CALIBRATION_DIR, 'budget-ledger-6.json')

export class BudgetExceededError extends Error {
  readonly code = 'budget_exceeded'
  constructor(spent: number, reserve: number, cap: number) {
    super(
      `PLAFOND SESSION 6 ATTEINT : ${spent.toFixed(4)} € dépensés + ${reserve.toFixed(2)} € réservés > ${cap.toFixed(2)} € — appel refusé avant envoi.`
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

let currentLabel = 'session6'
export function setBudgetLabel(label: string) {
  currentLabel = label
}

let activeCap = CAP_EUR
export function setActiveCap(cap: number) {
  activeCap = Math.min(cap, CAP_EUR)
}

/*
 * La réserve retenue AVANT envoi. Elle doit majorer le coût réel de l'appel,
 * pas le coût du pire appel imaginable : à 0,35 € pour toute image, la garde
 * refusait un rendu 2K facturé 0,1393 € alors qu'il restait 0,3302 € — elle
 * gelait deux images payables (relevé du 17/08, série interrompue au 1er des 3
 * rendus). La réserve suit donc la RÉSOLUTION demandée.
 *
 * 2K = 0,16 € : les 15 images du ledger 6 tiennent dans 0,1390-0,1396 € — la
 * variance est nulle à trois décimales — soit ~15 % de marge sur le maximum
 * observé. Une réserve est un MAJORANT du coût de l'appel ; au-delà elle cesse
 * de protéger le budget et se met à geler des appels que le budget couvre (elle
 * a bloqué le dernier des trois rendus pour un centime de marge, sur un budget
 * qui laissait 0,1904 €).
 * Le 4K garde 0,35 € : il est facturé presque deux fois plus cher.
 */
function reserveFor(body: string): number {
  // Appel texte : le plus cher observé sur ce ledger est un DA pro à 0,0353 € ;
  // un flash (OCR, mesure, jury) coûte 0,0006 €. 0,10 € gelait 0,05 € de budget
  // utilisable et a refusé la porte OCR d'une image DÉJÀ payée — un refus qui
  // ne protège rien et perd le rendu.
  if (!body.includes('"responseModalities"')) return 0.05
  return /"imageSize"\s*:\s*"4K"/.test(body) ? 0.35 : 0.16
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
