import { GeminiError } from '../ai/gemini'
import { ENGINE_MODELS, LOGO_THINKING_LEVEL } from './generation'
import { generateWithOcrGate, MAX_OCR_RETRIES } from './ocr-gate'
import { reviewLogoAgainstConcept, type ConceptScores, type ConceptVerdict } from './logo-critic'
import { estimateCostEur } from './pricing'
import { cutoutFlatBackground } from './cutout'
import { assembleLogo, compileEmblemePrompt, compileFondCalquePrompt, compileLockupPrompt, compileLockupFromBasePrompt, renderLettrageBase } from './logo-stack'
import { logGeneration } from './guards'
import type { LogoAnswersV3 } from './logo-brief'
import type { LogoConcept } from './logo-director'

// ── Étages 2 + 3 du pipeline logo — REFONDU run 5.8 (lockup fusionné) ────────
// Le run 5.7 générait l'emblème SEUL puis posait par-dessus un lettrage local
// (aplat/dégradé/contour/glow) centré mécaniquement : la fusion décrite par
// les concepts (lettre traversée par l'emblème, coupes custom, chrome,
// extrusions) n'existait jamais physiquement — c'était structurellement
// l'effet sticker que les prompts interdisent. Run 5.8 :
//   1. FOND plein cadre généré SEUL (OCR exclusion : aucun texte toléré)
//   2. LOCKUP FUSIONNÉ (emblème + lettrage dessinés ENSEMBLE) généré sur
//      #F2F2F2, porte OCR en LISTE BLANCHE (le mot exact du brief), 3 essais.
//      Si l'orthographe échoue encore → FALLBACK SILENCIEUX sur l'ancien
//      chemin : emblème seul + lettrage typographié local (recette calques).
//   3. Détourage local, ASSEMBLAGE sharp (glow de contact, grain) → master+alpha
// Puis la relecture de concept (étage 3). Si elle échoue, la régénération est
// CIBLÉE sur le calque fautif (fond ou lockup/emblème). Tout est loggé, le
// coût par étage est rendu à l'appelant.

export type LogoPropositionCout = {
  generationEur: number
  relectureEur: number
}

export type LogoLayers = {
  /** fond plein cadre (PNG base64 data URL) — absent si recette sans fond */
  fondDataUrl: string | null
  /** run 5.8 : lockup fusionné détouré (PNG alpha) — absent en mode fallback */
  lockupDataUrl: string | null
  /** emblème détouré (PNG alpha) — chemin fallback uniquement */
  emblemeDataUrl: string | null
  /** la marque sans le fond — la déclinaison alpha, dérivée gratuitement */
  alphaDataUrl: string
}

/** run 5.8 : références jointes, par calque — la marque reçoit des références
 *  de la MÊME famille de rendu que le concept (sélection dans la route). */
export type LogoPropositionRefs = {
  fond: Array<{ data: string; mimeType: string }>
  marque: Array<{ data: string; mimeType: string }>
}

export type LogoCalqueKind = 'fond' | 'lockup' | 'embleme'

export type LogoProposition = {
  dataUrl: string
  layers: LogoLayers
  concept: LogoConcept
  ocrRejects: number
  conceptOk: boolean
  // verdicts ADN du contrôle enrichi (run 5.4, LOT 3) — affichés page de test
  adnOk: boolean
  serveurLogo: boolean
  lisible64: boolean
  scores: ConceptScores
  defauts: string[]
  /** le verdict complet de la critique (fondOk, themeOk… — utilisé par la calibration) */
  verdict: ConceptVerdict
  regenere: boolean
  /** run 5.8 : le calque régénéré quand la critique a échoué */
  calqueRegenere: LogoCalqueKind | null
  /** run 5.8 : true si le lockup fusionné a rendu la marque (chemin nominal) */
  modeLockup: boolean
  /** run 5.9 : true si le lockup est parti de la base typographique locale */
  lockupBaseUtilisee: boolean
  /** run 5.8 : true si l'orthographe du lockup a échoué 3× → emblème + lettrage local */
  fallbackLettrageLocal: boolean
  /** run 5.8 : les prompts calques RÉELLEMENT envoyés à l'API image (rejouables) */
  promptsCalques: Partial<Record<string, string>>
  imagesGenerees: number
  cout: LogoPropositionCout
}

const CRITIC_PRICING_MODEL = 'gemini-3.5-flash'
const STACK_SIZE_2K = 2048

const b64 = (buf: Buffer) => `data:image/png;base64,${buf.toString('base64')}`
const fromDataUrl = (u: string) => Buffer.from(u.split(',').pop() ?? '', 'base64')

// La régénération vise le calque que les défauts nomment. Sur le chemin
// lockup, tout défaut de marque (emblème, lettrage, matières) cible le lockup
// entier — il n'y a qu'un calque de marque. Depuis le run 5.9, le champ
// STRUCTURÉ verdict.calqueFautif du critic fait foi ; cette regex n'est que
// le secours quand il est nul. « motif » en est RETIRÉ : sur iter11-58, le
// défaut « replace the wheat ear motif » (un défaut d'EMBLÈME) matchait la
// branche fond à cause de ce seul mot — mauvais calque régénéré.
export function calqueCible(defauts: string[], opts?: { lockupMode?: boolean }): LogoCalqueKind | null {
  const texte = defauts.join(' ').toLowerCase()
  if (/fond|backdrop|background|scene|scène|texture|vignette|halo|atmosph/i.test(texte)) return 'fond'
  if (/embl|emblem|symbol|mascot|dauphin|dolphin|icon|silhouette|sujet|subject|shape|forme|letter|lettrage|wordmark|typo|font|bevel|extrusion|gloss|matte|satin|motif/i.test(texte)) {
    return opts?.lockupMode ? 'lockup' : 'embleme'
  }
  return null
}

// Run 5.9 : la décision de régénération est une FONCTION PURE, testée par
// scripts/test-regen-ciblee.ts — le run 5.8 a prouvé qu'un filet non testé
// peut être éteint sans que personne ne le voie (criticRegen jamais passé
// par la calibration + regex piégée par « motif »).
export function decideRegen(
  verdict: Pick<ConceptVerdict, 'ok' | 'calqueFautif' | 'defauts'>,
  ctx: { lockupMode: boolean; hasFond: boolean; hasEmbleme: boolean }
): LogoCalqueKind | null {
  if (verdict.ok) return null
  const cible = verdict.calqueFautif ?? calqueCible(verdict.defauts, { lockupMode: ctx.lockupMode })
  if (!cible) return null
  const disponible =
    cible === 'fond' ? ctx.hasFond : cible === 'lockup' ? ctx.lockupMode : cible === 'embleme' ? ctx.hasEmbleme : false
  return disponible ? cible : null
}

export async function generateLogoProposition(opts: {
  projectName: string
  answers: LogoAnswersV3
  concept: LogoConcept
  references: LogoPropositionRefs
  resolution?: '1K' | '2K' | '4K'
  /** calibration : bloc d'hypothèse versionné, ajouté aux prompts des calques IA */
  extraBlock?: string
  /** calibration : désactiver la régénération ciblée (défaut : activée, comme en prod) */
  criticRegen?: boolean
  /** run 5.9 (chantier 3) : le lockup part d'une BASE TYPOGRAPHIQUE locale
   *  (orthographe parfaite par construction, image-to-image). true par
   *  défaut ; false = génération libre 5.8, gardée comme variante de
   *  comparaison sur les runs de validation. */
  lockupBase?: boolean
  log: { userId: string; projectId?: string | null; assetId?: string | null; kind: string }
}): Promise<LogoProposition> {
  const resolution = opts.resolution ?? '2K'
  const { concept } = opts
  const recette = concept.calques
  const palette = paletteOf(concept, opts.answers)

  let generationTokensIn = 0
  let generationTokensOut = 0
  let imagesGenerees = 0
  let relectureTokensIn = 0
  let relectureTokensOut = 0
  let ocrRejects = 0
  const promptsCalques: Partial<Record<string, string>> = {}

  // Le mot exact vient de la recette VALIDÉE (=== brief par le validateur).
  const texteAttendu = recette.lettrage?.texte?.trim() || null

  // ── un calque IA = une génération isolée, porte OCR systématique ──
  // fond/emblème : exclusion (aucun texte) ; lockup : liste blanche (le mot
  // exact du brief), présence non exigée pour un monogramme d'une lettre.
  // Run 5.9 : la base typographique est rendue UNE fois (locale, gratuite) et
  // réutilisée par toutes les tentatives lockup, régénération incluse.
  const useLockupBase = (opts.lockupBase ?? true) && Boolean(recette.lettrage?.texte && recette.lettrage.police)
  let lettrageBaseJpeg: Buffer | null = null
  const getLettrageBase = async (): Promise<Buffer> => {
    if (!lettrageBaseJpeg) lettrageBaseJpeg = await renderLettrageBase(recette.lettrage!)
    return lettrageBaseJpeg
  }

  const genLayer = async (kind: LogoCalqueKind, extraDefauts: string[] = []): Promise<Buffer> => {
    const lockupEnBase = kind === 'lockup' && useLockupBase
    const basePrompt =
      kind === 'fond'
        ? compileFondCalquePrompt({ fond: recette.fond, palette, sujet: opts.answers.sujet })
        : kind === 'lockup'
          ? lockupEnBase
            ? compileLockupFromBasePrompt({ lockup: recette.lockup!, texte: texteAttendu!, famille: concept.famille, palette })
            : compileLockupPrompt({ lockup: recette.lockup!, texte: texteAttendu!, famille: concept.famille, palette })
          : compileEmblemePrompt({ embleme: recette.embleme!, famille: concept.famille, palette })
    const withExtra = opts.extraBlock ? `${basePrompt}\n\n${opts.extraBlock}` : basePrompt
    const prompt = extraDefauts.length
      ? `${withExtra}\n\nCRITIC PASS FAILED on the previous ${kind} layer — fix EXACTLY these defects while keeping everything else:\n${extraDefauts.map((d) => `- ${d}`).join('\n')}`
      : withExtra
    const corpusRefs =
      kind === 'fond'
        ? opts.references.fond
        : kind === 'lockup'
          ? opts.references.marque.slice(0, lockupEnBase ? 2 : 3)
          : opts.references.marque.slice(0, 2)
    const referenceImages = lockupEnBase
      ? [{ data: (await getLettrageBase()).toString('base64'), mimeType: 'image/jpeg' }, ...corpusRefs]
      : corpusRefs
    const referenceLabels = lockupEnBase
      ? [
          'STRUCTURAL BASE — the exact lettering to re-render (keep every letterform and the spelling exactly as drawn):',
          ...corpusRefs.map((_, i) => `REFERENCE ${i + 1} — a real logo of the target family (match its finish quality, not its shapes):`),
        ]
      : corpusRefs.map((_, i) => `REFERENCE ${i + 1} — a real logo of the target family (match its finish quality, not its shapes):`)
    const generation = await generateWithOcrGate({
      model: ENGINE_MODELS.logoImage,
      prompt,
      referenceImages,
      // Run 5.9 : images AVANT le texte, étiquetées — adhérence aux références
      // nettement meilleure (mesuré au test plafond du chantier 0).
      referencesFirst: true,
      referenceLabels,
      imageConfig: { aspectRatio: '1:1', imageSize: resolution },
      thinkingLevel: LOGO_THINKING_LEVEL,
      expectedTexts: kind === 'lockup' ? [texteAttendu!] : [],
      forbidAnyText: kind !== 'lockup', // exclusion totale hors lockup
      expectedOptional: kind === 'lockup' && opts.answers.type === 'lettre',
      log: { ...opts.log, kind: `${opts.log.kind}_${kind}`, resolution },
    })
    generationTokensIn += generation.usage.tokensIn
    generationTokensOut += generation.usage.tokensOut
    imagesGenerees += 1 + generation.ocrRejects
    ocrRejects += generation.ocrRejects
    relectureTokensIn += generation.ocrTokensIn
    relectureTokensOut += generation.ocrTokensOut
    promptsCalques[extraDefauts.length ? `${kind}_regen` : kind] = generation.finalPrompt
    return fromDataUrl(generation.dataUrl)
  }

  const wantFond = true // doctrine 5.6 : la présentation corpus a toujours un fond travaillé
  const wantLockup = Boolean(recette.lockup && texteAttendu && recette.disposition !== 'embleme_seul')
  const wantEmblemeSeul = !wantLockup && recette.disposition !== 'lettrage_seul' && !!recette.embleme

  let fondPng: Buffer | null = null
  let lockupPng: Buffer | null = null // détouré
  let emblemePng: Buffer | null = null // détouré (fallback)
  let modeLockup = false
  let fallbackLettrageLocal = false

  // La marque : lockup fusionné d'abord ; si l'ORTHOGRAPHE échoue après 3
  // essais (ou refus safety même adouci), FALLBACK SILENCIEUX sur emblème +
  // lettrage local — l'utilisateur n'est jamais bloqué. Les erreurs
  // TRANSITOIRES (429/503/timeout) ne déclenchent pas le fallback : elles
  // valent un retry court, sinon elles remontent — dégrader le rendu à cause
  // d'une surcharge passagère serait payer le prix du sticker pour rien.
  const genMarque = async (): Promise<{ kind: 'lockup' | 'embleme'; png: Buffer } | null> => {
    if (wantLockup) {
      for (let tentative = 0; ; tentative += 1) {
        try {
          const png = await genLayer('lockup')
          modeLockup = true
          return { kind: 'lockup', png }
        } catch (error) {
          const g = error as GeminiError
          const transient = g instanceof GeminiError && !g.refusal && (g.status === 429 || g.status >= 500)
          if (transient && tentative < 2) {
            await new Promise((r) => setTimeout(r, 4000 * (tentative + 1)))
            continue
          }
          if (transient) throw error // toujours indisponible : erreur franche, pas un faux rendu
          fallbackLettrageLocal = true
          // l'épuisement OCR (422 non-refus) a bien généré et payé 3 images
          if (g instanceof GeminiError && g.status === 422 && !g.refusal) {
            imagesGenerees += 1 + MAX_OCR_RETRIES
          }
          void logGeneration({
            userId: opts.log.userId,
            projectId: opts.log.projectId ?? null,
            assetId: opts.log.assetId ?? null,
            kind: `${opts.log.kind}_lockup_fallback`,
            model: ENGINE_MODELS.logoImage,
            tokensIn: 0,
            tokensOut: 0,
          })
          console.warn(`[logo-pipeline] lockup fallback (${opts.log.kind}) :`, (error as Error).message)
          if (recette.embleme && recette.disposition !== 'lettrage_seul') {
            return { kind: 'embleme', png: await genLayer('embleme') }
          }
          return null // lettrage_seul : le lettrage local suffit
        }
      }
    }
    if (wantEmblemeSeul) return { kind: 'embleme', png: await genLayer('embleme') }
    return null
  }

  const [fondBrut, marqueBrute] = await Promise.all([
    wantFond ? genLayer('fond') : Promise.resolve(null),
    genMarque(),
  ])
  fondPng = fondBrut
  if (marqueBrute?.kind === 'lockup') lockupPng = (await cutoutFlatBackground(marqueBrute.png)).png
  else if (marqueBrute?.kind === 'embleme') emblemePng = (await cutoutFlatBackground(marqueBrute.png)).png

  const buildStack = async () => {
    const stack = await assembleLogo({
      fondPng: fondPng ?? undefined,
      lockupPng: lockupPng ?? undefined,
      emblemePng: emblemePng ?? undefined,
      recette,
      taille: STACK_SIZE_2K,
    })
    return stack
  }

  let stack = await buildStack()

  const review = async () => {
    const verdict = await reviewLogoAgainstConcept({
      dataUrl: b64(stack.master),
      concept,
      answers: opts.answers,
      projectName: opts.projectName,
      // Run 5.9 : la critique est COMPARATIVE — l'étalon (2 références de la
      // même famille) voyage dans l'appel. Sans lui, iter10b-58 lisait
      // relief 2 sur un rendu 8 et laissait passer le sticker.
      references: opts.references.marque.slice(0, 2),
      log: { ...opts.log, kind: `${opts.log.kind}_concept` },
    })
    relectureTokensIn += verdict.usage.tokensIn
    relectureTokensOut += verdict.usage.tokensOut
    return verdict
  }

  let verdict: ConceptVerdict = await review()
  let regenere = false
  let calqueRegenereFinal: LogoCalqueKind | null = null

  if (opts.criticRegen ?? true) {
    // UNE régénération ciblée max — le calque STRUCTURÉ du critic fait foi,
    // la regex n'est qu'un secours (decideRegen, fonction pure testée).
    const cible = decideRegen(verdict, { lockupMode: modeLockup, hasFond: wantFond, hasEmbleme: Boolean(emblemePng) })
    if (cible) {
      regenere = true
      calqueRegenereFinal = cible
      try {
        const neuf = await genLayer(cible, verdict.defauts)
        const prevFond = fondPng
        const prevLockup = lockupPng
        const prevEmbleme = emblemePng
        if (cible === 'fond') fondPng = neuf
        else if (cible === 'lockup') lockupPng = (await cutoutFlatBackground(neuf)).png
        else emblemePng = (await cutoutFlatBackground(neuf)).png
        const prevStack = stack
        const prevVerdict = verdict
        stack = await buildStack()
        const second = await review()
        if (second.ok || second.defauts.length < prevVerdict.defauts.length) {
          verdict = second
        } else {
          // le nouveau calque est pire : on garde la première pile
          fondPng = prevFond
          lockupPng = prevLockup
          emblemePng = prevEmbleme
          stack = prevStack
          verdict = prevVerdict
        }
      } catch {
        // régénération échouée (OCR à bout, refus…) : on garde la première pile
      }
    }
  }

  return {
    dataUrl: b64(stack.master),
    layers: {
      fondDataUrl: fondPng ? b64(fondPng) : null,
      lockupDataUrl: lockupPng ? b64(lockupPng) : null,
      emblemeDataUrl: emblemePng ? b64(emblemePng) : null,
      alphaDataUrl: b64(stack.alpha),
    },
    concept,
    ocrRejects,
    conceptOk: verdict.ok,
    adnOk: verdict.adnOk,
    serveurLogo: verdict.serveurLogo,
    lisible64: verdict.lisible64,
    scores: verdict.scores,
    defauts: verdict.defauts,
    verdict,
    regenere,
    calqueRegenere: calqueRegenereFinal,
    modeLockup,
    lockupBaseUtilisee: modeLockup && useLockupBase,
    fallbackLettrageLocal,
    promptsCalques,
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

function paletteOf(concept: LogoConcept, answers: LogoAnswersV3): string[] {
  if (answers.couleurs.mode === 'degrade') return answers.couleurs.couleurs
  if (answers.couleurs.mode === 'unie') return [answers.couleurs.couleur]
  // studio : les couleurs de la recette (gradient du lettrage) sinon neutres
  const stops = concept.calques.lettrage?.gradient?.stops?.map((s) => s.color)
  if (stops?.length) return stops
  const c = concept.calques.lettrage?.couleur
  return c ? [c] : ['#118AB2', '#06D6A0']
}
