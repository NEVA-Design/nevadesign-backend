/*
 * Run 6 (§8) — L'ADAPTATEUR CLAUDE, dormant tant qu'aucune clé n'est posée.
 *
 * Le document v6 propose Claude Opus 5 pour l'étage DA : le travail y est
 * devenu du raisonnement de design contraint (choisir un archétype, décrire
 * une relation physique en une phrase, sélectionner 3 références), pas de la
 * rédaction longue. Décision opérateur du 16/08 : on garde gemini-3.1-pro
 * comme moteur par défaut et on câble cet adaptateur derrière une clé — le
 * VRAI changement du run 6 est le contrat (S2 seule, 15-25 mots, archétypes),
 * et le modèle est une SECONDE variable, à isoler dans un A/B ultérieur.
 *
 * ⚠ Facturation SÉPARÉE : la garde budget (scripts/calibration/budget6.ts)
 * n'intercepte que generativelanguage.googleapis.com. Les appels faits ici
 * n'apparaissent PAS dans le grand livre — c'est dit, jamais masqué.
 */

import Anthropic from '@anthropic-ai/sdk'
import { env } from '../../config/env'
import type { GeminiUsage } from './gemini'

/** Le modèle du §8 — le plus capable de la famille Opus. */
export const CLAUDE_DIRECTOR_MODEL = 'claude-opus-5'

let client: Anthropic | null = null

/** true quand une clé est configurée — sinon l'adaptateur reste dormant. */
export function claudeDisponible(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY)
}

function getClient(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error(
      "Le DA Claude n'est pas configuré (ANTHROPIC_API_KEY manquante dans nevadesign-backend/.env) — le moteur reste sur Gemini"
    )
  }
  if (!client) client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  return client
}

/**
 * Un appel de raisonnement JSON strict.
 *
 * `schema` (JSON Schema) passe par les sorties structurées : le modèle ne peut
 * plus rendre un JSON tronqué ou entouré de prose — c'est le piège n°5 de la
 * passation (le DA Gemini coupait son JSON à 6000 puis 9000 tokens) supprimé
 * par construction plutôt que par un budget de sortie généreux.
 */
export async function directWithClaude<T>(opts: {
  prompt: string
  systemInstruction: string
  schema?: Record<string, unknown>
  maxTokens?: number
  /** low | medium | high | xhigh | max — le DA travaille en raisonnement haut */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  onUsage?: (usage: GeminiUsage) => void
}): Promise<T | null> {
  const anthropic = getClient()

  const response = await anthropic.messages.create({
    model: CLAUDE_DIRECTOR_MODEL,
    max_tokens: opts.maxTokens ?? 8000,
    system: opts.systemInstruction,
    // Opus 5 : la réflexion est active par défaut ; l'effort règle sa
    // profondeur. Aucun temperature/top_p ici — ces paramètres sont refusés
    // (400) sur ce modèle, la conduite passe par le prompt.
    output_config: {
      effort: opts.effort ?? 'high',
      ...(opts.schema ? { format: { type: 'json_schema' as const, schema: opts.schema } } : {}),
    },
    messages: [{ role: 'user', content: opts.prompt }],
  })

  opts.onUsage?.({
    tokensIn: response.usage.input_tokens ?? 0,
    tokensOut: response.usage.output_tokens ?? 0,
  })

  // Les classifieurs peuvent décliner une requête : HTTP 200, stop_reason
  // « refusal », contenu vide. On le dit franchement au lieu de renvoyer null
  // comme si le modèle avait mal répondu.
  if (response.stop_reason === 'refusal') {
    throw new Error(
      `Le DA Claude a refusé la demande (${response.stop_details?.category ?? 'catégorie inconnue'}) — reformule le brief`
    )
  }

  const texte = response.content
    .filter((bloc): bloc is Anthropic.TextBlock => bloc.type === 'text')
    .map((bloc) => bloc.text)
    .join('')
    .trim()

  if (!texte) return null
  try {
    return JSON.parse(texte.replace(/^```(?:json)?|```$/g, '').trim()) as T
  } catch {
    return null
  }
}
