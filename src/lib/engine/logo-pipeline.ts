import { ENGINE_MODELS, LOGO_THINKING_LEVEL } from './generation'
import { generateWithOcrGate } from './ocr-gate'
import { reviewLogoAgainstConcept, type ConceptVerdict } from './logo-critic'
import { compileLogoConceptPrompt } from './compiler'
import { estimateCostEur } from './pricing'
import type { LogoAnswersV3 } from './logo-brief'
import type { LogoConcept } from './logo-director'

// ── Étages 2 + 3 du pipeline logo (run 5.3, LOT 1) ──────────────────────────
// UNE proposition = un concept du DA exécuté par le pro image (2K, thinking
// activé, 2-3 références jointes, épellation forcée) puis relu : OCR gate
// (inchangé) + contrôle de concept. Si le contrôle échoue → UNE régénération
// ciblée avec les défauts nommés dans le prompt, et on affiche le meilleur
// des deux. Tout est loggé, le coût par étage est rendu à l'appelant.

export type LogoPropositionCout = {
  generationEur: number
  relectureEur: number
}

export type LogoProposition = {
  dataUrl: string
  concept: LogoConcept
  ocrRejects: number
  conceptOk: boolean
  defauts: string[]
  regenere: boolean
  imagesGenerees: number
  cout: LogoPropositionCout
}

const CRITIC_PRICING_MODEL = 'gemini-3.5-flash'

export async function generateLogoProposition(opts: {
  projectName: string
  answers: LogoAnswersV3
  concept: LogoConcept
  references: Array<{ data: string; mimeType: string }>
  resolution?: '2K' | '4K'
  log: { userId: string; projectId?: string | null; assetId?: string | null; kind: string }
}): Promise<LogoProposition> {
  const resolution = opts.resolution ?? '2K'
  const compiled = compileLogoConceptPrompt({
    projectName: opts.projectName,
    conceptPrompt: opts.concept.prompt,
    type: opts.answers.type,
    fond: opts.answers.fond,
  })

  let generationTokensIn = 0
  let generationTokensOut = 0
  let imagesGenerees = 0
  let relectureTokensIn = 0
  let relectureTokensOut = 0

  const runOnce = async (prompt: string, kindSuffix: string) => {
    const generation = await generateWithOcrGate({
      model: ENGINE_MODELS.logoImage,
      prompt,
      referenceImages: opts.references,
      imageConfig: { aspectRatio: '1:1', imageSize: resolution },
      thinkingLevel: LOGO_THINKING_LEVEL,
      expectedTexts: compiled.expectedTexts,
      log: { ...opts.log, kind: `${opts.log.kind}${kindSuffix}`, resolution },
    })
    generationTokensIn += generation.usage.tokensIn
    generationTokensOut += generation.usage.tokensOut
    imagesGenerees += 1 + generation.ocrRejects
    relectureTokensIn += generation.ocrTokensIn
    relectureTokensOut += generation.ocrTokensOut

    const verdict = await reviewLogoAgainstConcept({
      dataUrl: generation.dataUrl,
      concept: opts.concept,
      answers: opts.answers,
      projectName: opts.projectName,
      log: { ...opts.log, kind: `${opts.log.kind}_concept` },
    })
    relectureTokensIn += verdict.usage.tokensIn
    relectureTokensOut += verdict.usage.tokensOut
    return { generation, verdict }
  }

  const first = await runOnce(compiled.prompt, '')

  let best: { dataUrl: string; ocrRejects: number; verdict: ConceptVerdict } = {
    dataUrl: first.generation.dataUrl,
    ocrRejects: first.generation.ocrRejects,
    verdict: first.verdict,
  }
  let regenere = false

  if (!first.verdict.ok && first.verdict.defauts.length) {
    // UNE régénération ciblée max — le défaut est nommé dans le prompt.
    regenere = true
    const fixedPrompt = `${compiled.prompt}\n\nCRITIC PASS FAILED — the previous render had these precise defects, fix EXACTLY these while keeping the concept intact:\n${first.verdict.defauts.map((d) => `- ${d}`).join('\n')}`
    try {
      const second = await runOnce(fixedPrompt, '_regen')
      const secondBetter =
        second.verdict.ok || second.verdict.defauts.length < first.verdict.defauts.length
      if (secondBetter) {
        best = { dataUrl: second.generation.dataUrl, ocrRejects: second.generation.ocrRejects, verdict: second.verdict }
      }
    } catch {
      // régénération échouée (OCR à bout, refus…) : on garde le premier rendu
    }
  }

  return {
    dataUrl: best.dataUrl,
    concept: opts.concept,
    ocrRejects: best.ocrRejects,
    conceptOk: best.verdict.ok,
    defauts: best.verdict.defauts,
    regenere,
    imagesGenerees,
    cout: {
      generationEur: estimateCostEur({
        model: ENGINE_MODELS.logoImage,
        tokensIn: generationTokensIn,
        tokensOut: generationTokensOut,
        imagesOut: imagesGenerees,
        resolution,
      }),
      relectureEur: estimateCostEur({
        model: CRITIC_PRICING_MODEL,
        tokensIn: relectureTokensIn,
        tokensOut: relectureTokensOut,
      }),
    },
  }
}
