import { GeminiError } from '../ai/gemini'
import { ENGINE_MODELS, LOGO_THINKING_LEVEL } from './generation'
import { generateWithOcrGate } from './ocr-gate'
import { reviewLogoAgainstConcept, type ConceptVerdict } from './logo-critic'
import { estimateCostEur } from './pricing'
import { generateLogoProposition, type LogoProposition, type LogoPropositionRefs } from './logo-pipeline'
import type { ExemplarEtiquete } from './exemplars'
import type { LogoAnswersV3 } from './logo-brief'
import type { LogoConcept } from './logo-director'

// ── Run 5.10 : LE RENDU INTÉGRAL — une proposition = UN appel image ──────────
// Preuve (test plafond 5.9, _plafond-run59/) : l'architecture en couches
// (lockup sur fond gris → détourage → collage sur fond généré à part)
// produisait MÉCANIQUEMENT les franges blanches de détourage, l'effet sticker
// et un éclairage incohérent entre la marque et le fond. Les deux réussites
// du plafond sont des images INTÉGRALES : le modèle compose marque, lumière
// et fond ensemble. Le chemin des propositions est donc :
//   1. prompt minimal du DA (30-120 mots, plafond dur) exécuté VERBATIM,
//      références HQ étiquetées jointes AVANT le texte ;
//   2. porte OCR glyphe par glyphe sur le rendu intégral (mode 1 mot) ;
//   3. critique comparative avec détecteurs éliminatoires (sticker, candy,
//      glyphes, fond dominant) ; si elle échoue → UNE régénération : le même
//      appel intégral relancé avec les défauts injectés ;
//   4. si l'ORTHOGRAPHE échoue après 3 essais (ou refus safety) → FALLBACK
//      sur le pipeline calques (base typographique locale, plan de secours
//      orthographe) — l'utilisateur n'est jamais bloqué.
// La génération lockup + fond séparés ne sert plus qu'au fallback et à
// l'étape B (le code de logo-pipeline.ts/logo-stack.ts reste en place).

const CRITIC_PRICING_MODEL = 'gemini-3.5-flash'

export type LogoPropositionIntegrale = {
  dataUrl: string
  concept: LogoConcept
  /** 'integral' = un appel image ; 'fallback_calques' = plan de secours orthographe */
  mode: 'integral' | 'fallback_calques'
  ocrRejects: number
  conceptOk: boolean
  adnOk: boolean
  serveurLogo: boolean
  lisible64: boolean
  scores: ConceptVerdict['scores']
  defauts: string[]
  verdict: ConceptVerdict
  regenere: boolean
  /** le prompt intégral RÉELLEMENT envoyé (rejouable) — null en mode fallback */
  promptIntegral: string | null
  /** le prompt de régénération si elle a tourné (défauts injectés) */
  promptRegen: string | null
  /** slugs des références étiquetées jointes */
  referencesEtiquetees: string[]
  /** calques du fallback (réassemblage master 4K) — null en mode intégral */
  fallback: LogoProposition | null
  imagesGenerees: number
  cout: { generationEur: number; relectureEur: number }
}

// ── La décision de régénération, FONCTION PURE (scripts/test-regen-integrale.ts)
// Le 5.8 a prouvé qu'un filet non testé peut être éteint sans que personne ne
// le voie. Sur le chemin intégral il n'y a qu'un calque : tout verdict en
// échec avec des défauts nommés relance l'appel intégral, une fois.
export function decideRegenIntegral(verdict: Pick<ConceptVerdict, 'ok' | 'defauts'>): boolean {
  return !verdict.ok && verdict.defauts.length > 0
}

/** Le prompt de régénération : le prompt intégral + les défauts nommés par la
 *  critique, injectés tels quels. */
export function buildRegenPromptIntegral(prompt: string, defauts: string[]): string {
  return `${prompt}\n\nCRITIC PASS FAILED on the previous render — fix EXACTLY these defects while keeping everything else (same concept, same lettering, same palette):\n${defauts.map((d) => `- ${d}`).join('\n')}`
}

export async function generateLogoIntegral(opts: {
  projectName: string
  answers: LogoAnswersV3
  concept: LogoConcept
  /** 3-4 références HQ étiquetées (pickExemplarsEtiquetes) */
  references: ExemplarEtiquete[]
  /** références du FALLBACK calques (fond + marque) — le plan de secours */
  fallbackReferences: LogoPropositionRefs
  resolution?: '1K' | '2K' | '4K'
  /** calibration : bloc d'hypothèse ajouté au prompt intégral */
  extraBlock?: string
  /** défaut true, comme en prod — false = expérience contrôlée */
  criticRegen?: boolean
  log: { userId: string; projectId?: string | null; assetId?: string | null; kind: string }
}): Promise<LogoPropositionIntegrale> {
  const resolution = opts.resolution ?? '2K'
  const { concept, answers } = opts

  const motAttendu =
    answers.type === 'nom'
      ? opts.projectName.trim().toUpperCase()
      : answers.type === 'lettre'
        ? (opts.projectName.trim()[0] ?? 'N').toUpperCase()
        : null

  let generationTokensIn = 0
  let generationTokensOut = 0
  let imagesGenerees = 0
  let relectureTokensIn = 0
  let relectureTokensOut = 0
  let ocrRejects = 0

  const promptIntegral = opts.extraBlock ? `${concept.prompt}\n\n${opts.extraBlock}` : concept.prompt
  const referenceImages = opts.references.map((r) => ({ data: r.data, mimeType: r.mimeType }))
  const referenceLabels = opts.references.map((r) => r.label)

  // ── un appel intégral = génération + porte OCR (glyphe par glyphe si un
  // mot est attendu). Les erreurs TRANSITOIRES (429/503) valent un retry
  // court ; l'épuisement OCR ou un refus déclenchent le fallback calques.
  const genIntegral = async (prompt: string): Promise<string> => {
    for (let tentative = 0; ; tentative += 1) {
      try {
        const generation = await generateWithOcrGate({
          model: ENGINE_MODELS.logoImage,
          prompt,
          referenceImages,
          referencesFirst: true,
          referenceLabels,
          imageConfig: { aspectRatio: '1:1', imageSize: resolution },
          thinkingLevel: LOGO_THINKING_LEVEL,
          expectedTexts: motAttendu ? [motAttendu] : [],
          forbidAnyText: !motAttendu,
          expectedOptional: answers.type === 'lettre',
          log: { ...opts.log, kind: `${opts.log.kind}_integral`, resolution },
        })
        generationTokensIn += generation.usage.tokensIn
        generationTokensOut += generation.usage.tokensOut
        imagesGenerees += 1 + generation.ocrRejects
        ocrRejects += generation.ocrRejects
        relectureTokensIn += generation.ocrTokensIn
        relectureTokensOut += generation.ocrTokensOut
        return generation.dataUrl
      } catch (error) {
        const g = error as GeminiError
        const transient = g instanceof GeminiError && !g.refusal && (g.status === 429 || g.status >= 500)
        if (transient && tentative < 2) {
          await new Promise((r) => setTimeout(r, 4000 * (tentative + 1)))
          continue
        }
        throw error
      }
    }
  }

  const review = async (dataUrl: string): Promise<ConceptVerdict> => {
    const verdict = await reviewLogoAgainstConcept({
      dataUrl,
      concept,
      answers,
      projectName: opts.projectName,
      // l'étalon comparatif : 2 références étiquetées de la même famille
      references: referenceImages.slice(0, 2),
      log: { ...opts.log, kind: `${opts.log.kind}_concept` },
    })
    relectureTokensIn += verdict.usage.tokensIn
    relectureTokensOut += verdict.usage.tokensOut
    return verdict
  }

  let dataUrl: string
  try {
    dataUrl = await genIntegral(promptIntegral)
  } catch (error) {
    const g = error as GeminiError
    const transient = g instanceof GeminiError && !g.refusal && (g.status === 429 || g.status >= 500)
    if (transient) throw error // surcharge passagère : erreur franche, pas un faux rendu
    // ── FALLBACK ORTHOGRAPHE : le pipeline calques (base typo locale) ────────
    // L'épuisement OCR du rendu intégral (3 images payées) ou un refus safety
    // basculent sur le plan de secours — orthographe parfaite par construction.
    console.warn(`[logo-integral] fallback calques (${opts.log.kind}) :`, (error as Error).message)
    if (g instanceof GeminiError && g.status === 422 && !g.refusal) {
      imagesGenerees += 3 // la porte OCR a généré et payé 3 images rejetées
    }
    const fallback = await generateLogoProposition({
      projectName: opts.projectName,
      answers,
      concept,
      references: opts.fallbackReferences,
      resolution,
      criticRegen: opts.criticRegen,
      log: { ...opts.log, kind: `${opts.log.kind}_fallback` },
    })
    return {
      dataUrl: fallback.dataUrl,
      concept,
      mode: 'fallback_calques',
      ocrRejects: ocrRejects + fallback.ocrRejects,
      conceptOk: fallback.conceptOk,
      adnOk: fallback.adnOk,
      serveurLogo: fallback.serveurLogo,
      lisible64: fallback.lisible64,
      scores: fallback.scores,
      defauts: fallback.defauts,
      verdict: fallback.verdict,
      regenere: fallback.regenere,
      promptIntegral: null,
      promptRegen: null,
      referencesEtiquetees: opts.references.map((r) => r.slug),
      fallback,
      imagesGenerees: imagesGenerees + fallback.imagesGenerees,
      cout: {
        generationEur:
          fallback.cout.generationEur +
          estimateCostEur({
            model: ENGINE_MODELS.logoImage,
            tokensIn: generationTokensIn,
            tokensOut: generationTokensOut,
            imagesOut: imagesGenerees,
            resolution,
          }),
        relectureEur:
          fallback.cout.relectureEur +
          estimateCostEur({ model: CRITIC_PRICING_MODEL, tokensIn: relectureTokensIn, tokensOut: relectureTokensOut }),
      },
    }
  }

  // ── critique + UNE régénération intégrale max (défauts injectés) ───────────
  let verdict = await review(dataUrl)
  let regenere = false
  let promptRegen: string | null = null

  if ((opts.criticRegen ?? true) && decideRegenIntegral(verdict)) {
    regenere = true
    promptRegen = buildRegenPromptIntegral(promptIntegral, verdict.defauts)
    try {
      const neuf = await genIntegral(promptRegen)
      const second = await review(neuf)
      if (second.ok || second.defauts.length < verdict.defauts.length) {
        dataUrl = neuf
        verdict = second
      }
      // sinon : le nouveau rendu est pire, on garde le premier
    } catch {
      // régénération échouée (OCR à bout, refus…) : on garde le premier rendu
    }
  }

  return {
    dataUrl,
    concept,
    mode: 'integral',
    ocrRejects,
    conceptOk: verdict.ok,
    adnOk: verdict.adnOk,
    serveurLogo: verdict.serveurLogo,
    lisible64: verdict.lisible64,
    scores: verdict.scores,
    defauts: verdict.defauts,
    verdict,
    regenere,
    promptIntegral,
    promptRegen,
    referencesEtiquetees: opts.references.map((r) => r.slug),
    fallback: null,
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
