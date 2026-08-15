// Tarification Gemini centralisée — TOUTES les estimations de coût du
// backend passent par ici. Montants en USD par défaut (grille publique
// Google AI), convertis en EUR à taux fixe. Les valeurs marquées
// « estimation » sont recalées sur la facture Google Cloud réelle au
// premier relevé (LOT 7) : ajuster UNIQUEMENT ce fichier, jamais en dur
// ailleurs.

export const EUR_PER_USD = 0.92

type ModelPricing = {
  // $ par million de tokens texte
  textInPerM: number
  textOutPerM: number
  // $ par image générée, selon la résolution demandée
  imageOut?: {
    default: number
    k4?: number
  }
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'gemini-2.0-flash': { textInPerM: 0.1, textOutPerM: 0.4 },
  'gemini-2.5-flash': { textInPerM: 0.3, textOutPerM: 2.5 },
  'gemini-2.5-pro': { textInPerM: 1.25, textOutPerM: 10 },
  'gemini-2.5-flash-image': {
    textInPerM: 0.3,
    textOutPerM: 2.5,
    // 1290 tokens image à 30 $/M
    imageOut: { default: 0.039 },
  },
  // estimation — modèle récent, à recaler sur la facture réelle
  'gemini-3.1-flash-image': {
    textInPerM: 0.3,
    textOutPerM: 2.5,
    imageOut: { default: 0.067 },
  },
  // estimation — 1K/2K au même tarif, 4K plus cher
  'gemini-3-pro-image': {
    textInPerM: 2,
    textOutPerM: 12,
    imageOut: { default: 0.134, k4: 0.24 },
  },
}

const FALLBACK_PRICING: ModelPricing = {
  textInPerM: 0.3,
  textOutPerM: 2.5,
  imageOut: { default: 0.067 },
}

export type CostInput = {
  model: string
  tokensIn?: number | null
  tokensOut?: number | null
  imagesOut?: number
  resolution?: string | null
  // mode Batch Gemini : −50 % sur tout
  batch?: boolean
}

export function estimateCostEur({ model, tokensIn, tokensOut, imagesOut = 0, resolution, batch = false }: CostInput): number {
  const pricing = MODEL_PRICING[model] ?? FALLBACK_PRICING

  let usd = 0
  usd += ((tokensIn ?? 0) / 1_000_000) * pricing.textInPerM
  usd += ((tokensOut ?? 0) / 1_000_000) * pricing.textOutPerM

  if (imagesOut > 0 && pricing.imageOut) {
    const is4k = (resolution ?? '').toLowerCase() === '4k'
    const perImage = is4k && pricing.imageOut.k4 ? pricing.imageOut.k4 : pricing.imageOut.default
    usd += imagesOut * perImage
  }

  if (batch) usd *= 0.5

  return Math.round(usd * EUR_PER_USD * 10_000) / 10_000
}
