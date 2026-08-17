/*
 * Run 7 (SÉPARATION DES MOTEURS) — garde budget dure, enveloppe NEUVE.
 *
 * Mandat opérateur du 17/08 : 5,00 € pour les 7 phases, exécutées de bout en
 * bout sans arbitrage. Nouveauté par rapport à budget5/budget6 : la garde tient
 * un PLAFOND PAR PHASE en plus du plafond global. Une phase qui dépasse son
 * plafond ne fait pas tomber la session — elle jette `PhaseBudgetError`, que
 * l'appelant attrape pour passer à la phase suivante avec ce qu'il a. C'est le
 * mandat, littéralement : « Si une phase dépasse son plafond, tu passes à la
 * suivante avec ce que tu as. »
 *
 * Mécanique héritée et inchangée : intercepteur sur globalThis.fetch, refus
 * AVANT envoi, grand livre persistant. Les ledgers 2 à 6 restent intacts.
 *
 * Réserves (piège n°23) : un MAJORANT du coût de l'appel, jamais du pire appel
 * imaginable. Relevés du ledger 6 : image 2K = 0,1390-0,1396 € (variance nulle
 * à 3 décimales), appel DA pro = 0,0353 € au plus cher, appel flash = 0,0007 €.
 * D'où 0,16 € (2K) / 0,35 € (4K) / 0,05 € (texte). Une réserve trop large gèle
 * du budget disponible et fait perdre le rendu qu'elle prétend couvrir.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { estimateCostEur } from '../../src/lib/engine/pricing'

/** Plafond DUR de la session 7. Mandat opérateur : 5,00 €, mandat complet. */
export const CAP_EUR = 5.0

/*
 * Plafonds par phase, du mandat. La somme fait 3,70 € : les 1,30 € restants
 * sont la marge de reprise de la session (une phase qui échoue et se rejoue,
 * un rendu perdu). Ils ne sont attribués à aucune phase — donc dépensables
 * seulement par un relèvement explicite et tracé de son plafond.
 */
export const PLAFONDS_PHASE: Record<string, number> = {
  'p1-corpus': 0.8,
  'p2-da': 0.6,
  'p3-svg': 0.9,
  'p4-fond': 0.6,
  'p5-compose': 0.0,
  'p6-temoin': 0.6,
  'p7-livraison': 0.2,
}

// compat harnais iterate.ts / e3-briefs.ts (mêmes noms que budget5/budget6)
export const CHECKPOINT_EUR = 2.5
export const STOP_SANS_CONVERGENCE_EUR = 4.0

export const CALIBRATION_DIR = resolve(import.meta.dir, '../../../captures/calibration')
export const V7_DIR = join(CALIBRATION_DIR, '_v7')
const LEDGER_PATH = join(CALIBRATION_DIR, 'budget-ledger-7.json')

export class BudgetExceededError extends Error {
  readonly code = 'budget_exceeded'
  constructor(spent: number, reserve: number, cap: number) {
    super(
      `PLAFOND SESSION 7 ATTEINT : ${spent.toFixed(4)} € dépensés + ${reserve.toFixed(2)} € réservés > ${cap.toFixed(2)} € — appel refusé avant envoi.`
    )
  }
}

/*
 * Dépassement de PHASE — volontairement une classe distincte : elle ne dit pas
 * « la session est finie », elle dit « cette phase est finie ». L'appelant la
 * traite comme une fin de phase normale, pas comme une panne.
 */
export class PhaseBudgetError extends Error {
  readonly code = 'phase_budget_exceeded'
  constructor(
    readonly phase: string,
    spent: number,
    reserve: number,
    cap: number
  ) {
    super(
      `PLAFOND DE PHASE « ${phase} » ATTEINT : ${spent.toFixed(4)} € dépensés sur cette phase + ${reserve.toFixed(2)} € réservés > ${cap.toFixed(2)} € — appel refusé avant envoi, on passe à la suite.`
    )
  }
}

type LedgerEntry = {
  at: string
  phase: string
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
  } catch (err) {
    // Piège n°17 : un catch qui renvoie du vide coûte le prochain appel. Un
    // ledger illisible ferait repartir la garde de zéro, c'est-à-dire
    // autoriser 5 € de plus. On s'arrête.
    throw new Error(
      `Grand livre 7 illisible (${LEDGER_PATH}) : ${(err as Error).message}. Refus de repartir de zéro — corrige ou archive le fichier.`
    )
  }
}

function saveLedger(ledger: Ledger) {
  mkdirSync(dirname(LEDGER_PATH), { recursive: true })
  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2))
}

export function spentEur(): number {
  return loadLedger().spentEur
}

export function spentForPhase(phase: string): number {
  const ledger = loadLedger()
  return (
    Math.round(
      ledger.entries.filter((e) => e.phase === phase).reduce((s, e) => s + e.eur, 0) * 10_000
    ) / 10_000
  )
}

export function spentForLabel(label: string): number {
  const ledger = loadLedger()
  return (
    Math.round(
      ledger.entries.filter((e) => e.label === label).reduce((s, e) => s + e.eur, 0) * 10_000
    ) / 10_000
  )
}

export function resteDePhase(phase: string): number {
  const cap = PLAFONDS_PHASE[phase] ?? 0
  return Math.round((cap - spentForPhase(phase)) * 10_000) / 10_000
}

let currentPhase = 'hors-phase'
let currentLabel = 'session7'

export function setPhase(phase: string) {
  if (!(phase in PLAFONDS_PHASE)) throw new Error(`Phase inconnue : ${phase}`)
  currentPhase = phase
}
export function setBudgetLabel(label: string) {
  currentLabel = label
}

let activeCap = CAP_EUR
export function setActiveCap(cap: number) {
  activeCap = Math.min(cap, CAP_EUR)
}

/**
 * Réserve retenue avant envoi — majorant du coût de CET appel (piège n°23).
 * Le modèle compte : un appel flash de mesure coûte 0,0007 €, un appel
 * `gemini-3.1-pro-preview` en raisonnement élevé avec 11 images jointes et
 * 8000 tokens de sortie coûte ~0,10 €. Une réserve unique de 0,05 € laisserait
 * un plafond de phase se faire dépasser de 0,05 € par appel — soit 0,10 € sur
 * la phase 3, qui en fait huit.
 */
export function reserveFor(url: string, body: string): number {
  if (!body.includes('"responseModalities"')) {
    // Relevés du ledger 7 : appel flash de mesure 0,0007 € · appel pro avec
    // 11 images jointes et raisonnement élevé 0,0370 €. Réserver 0,05 € pour un
    // flash, c'est un majorant à 70× : sur la phase 4, les quatre plaques
    // consomment 0,558 € du plafond de 0,60 € et cette réserve-là suffisait à
    // faire refuser la porte de vérification d'une image DÉJÀ payée. C'est le
    // piège n°23 mot pour mot, et il se corrige en distinguant les deux.
    return /-pro/.test(url) ? 0.13 : 0.01
  }
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
    const reserve = reserveFor(url, body)

    if (ledger.spentEur + reserve > activeCap) {
      throw new BudgetExceededError(ledger.spentEur, reserve, activeCap)
    }

    const capPhase = PLAFONDS_PHASE[currentPhase]
    if (capPhase !== undefined) {
      const dejaPhase = ledger.entries
        .filter((e) => e.phase === currentPhase)
        .reduce((s, e) => s + e.eur, 0)
      if (dejaPhase + reserve > capPhase) {
        throw new PhaseBudgetError(currentPhase, dejaPhase, reserve, capPhase)
      }
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
    const resKm = body.match(/"imageSize"\s*:\s*"(\d)K"/)?.[1]
    const resolution = resKm ? `${resKm}K` : null
    const eur = usage
      ? estimateCostEur({ model, tokensIn, tokensOut, imagesOut, resolution })
      : 0.05

    const fresh = loadLedger()
    fresh.spentEur = Math.round((fresh.spentEur + eur) * 10_000) / 10_000
    fresh.entries.push({
      at: new Date().toISOString(),
      phase: currentPhase,
      label: currentLabel,
      model,
      tokensIn,
      tokensOut,
      imagesOut,
      resolution,
      eur,
    })
    saveLedger(fresh)

    return new Response(text, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  }
}

/** Récapitulatif par phase — sert au rapport final, jamais estimé à la main. */
export function recapPhases(): Array<{ phase: string; cap: number; spent: number; appels: number }> {
  const ledger = loadLedger()
  return Object.keys(PLAFONDS_PHASE).map((phase) => {
    const e = ledger.entries.filter((x) => x.phase === phase)
    return {
      phase,
      cap: PLAFONDS_PHASE[phase]!,
      spent: Math.round(e.reduce((s, x) => s + x.eur, 0) * 10_000) / 10_000,
      appels: e.length,
    }
  })
}
