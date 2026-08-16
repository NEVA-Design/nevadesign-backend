import sharp from 'sharp'
import { estimateCostEur } from './pricing'
import { ENGINE_MODELS, LOGO_THINKING_LEVEL, generateWithSoftRetry } from './generation'
import { verifyRenderedText, generateWithOcrGate } from './ocr-gate'
import { cutoutDecontamine, type CutoutDecontamineResult } from './cutout'
import { assembleLogo, compileEmblemePrompt, type LogoCalquesRecette } from './logo-stack'
import { LOGO_BACKGROUND_HEX } from './compiler'
import type { LogoFamilleRendu } from './logo-director'

// ── Run 5.10 (chantier 2) : l'ALPHA et le MASTER à partir du rendu intégral ──
// Le produit a toujours besoin du master transparent et des déclinaisons
// monochromes. Quand l'utilisateur choisit sa proposition — et seulement à ce
// moment-là, pour ne payer qu'une fois sur trois — un appel d'ÉDITION re-rend
// le logo choisi, identique, isolé sur fond uni plat (la repro pure du test
// plafond prouve que le modèle sait préserver un design existant). Le rendu
// isolé passe ensuite au détourage DÉCONTAMINÉ (cutoutDecontamine — érosion
// 1-2 px + couleur des bords reprise à l'intérieur : la frange blanche est
// corrigée). Deux échecs d'isolation → fallback sur la base typographique
// locale composée comme aujourd'hui (assembleLogo + recette calques).

export const ISOLATION_MAX_TENTATIVES = 2

// Verdicts mécaniques d'une isolation réussie : le fond plat doit exister
// (part de pixels fond) et la marque ne doit pas remplir tout le cadre.
const ISOLATION_FOND_RATIO_MIN = 0.12
const ISOLATION_BBOX_MAX = 0.96

export function compileIsolationPrompt(tentative: number): string {
  // Une tâche de REMPLACEMENT DE FOND, jamais un « re-rendu » créatif : dit
  // « re-render this exact logo », le modèle re-produit la composition
  // ENTIÈRE, fond décoré compris (vu sur integ3). Et ZÉRO glow/ombre : le
  // voile lumineux d'un lockup 3D est trop proche du fond clair pour être
  // détouré (la « tache blanche » vécue depuis le 5.9) — le glow de
  // présentation est réappliqué localement par l'assemblage.
  const base = [
    `BACKGROUND REPLACEMENT TASK — mechanical, not creative. The attached image shows a finished logo on a decorated background.`,
    `OUTPUT: the very same logo, pixel-faithful — identical letterforms, identical shapes, identical colors, identical materials and finish — with the ENTIRE background replaced by one single flat, uniform, seamless light grey ${LOGO_BACKGROUND_HEX} sheet, edge to edge. No scenery, no leaves, no motifs, no texture, no gradient, no vignette, no fog.`,
    `REMOVE every light effect around the mark: ZERO outer glow, ZERO halo, ZERO drop shadow, ZERO soft white cloud behind the letters — the artwork's edges sit crisp and hard directly against the flat ${LOGO_BACKGROUND_HEX} sheet (presentation glow is re-applied later at composition). Leave at least 12% clear padding on all sides.`,
    `No extra words, no watermark.`,
  ]
  if (tentative > 0) {
    base.splice(1, 0, `PREVIOUS ATTEMPT FAILED: the decorated background (or a glow/shadow cloud) survived, or a glyph was altered. Only two things are allowed in the output image: the untouched logo artwork, and flat ${LOGO_BACKGROUND_HEX} everywhere else — every glyph EXACTLY as in the source image.`)
  }
  return base.join('\n\n')
}

// ── Détecteur de VOILE BLANC (la tache de détourage des lockups 3D) ──────────
// Un glow/ombre clair conservé au détourage devient un bloc quasi blanc,
// neutre et opaque dans l'alpha — mesurable : part des pixels opaques à la
// fois très clairs (lum >= 225) et non saturés (chroma <= 24). Les speculars
// chrome d'un lettrage restent marginaux (< 8 %) ; un voile conservé pèse
// plusieurs dizaines de pourcents.
export const VOILE_BLANC_MAX_RATIO = 0.08

export async function voileBlancRatio(cutoutPng: Buffer): Promise<number> {
  const { data, info } = await sharp(cutoutPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let opaques = 0
  let voile = 0
  for (let p = 0; p < info.width * info.height; p++) {
    if (data[p * 4 + 3]! < 200) continue
    opaques += 1
    const r = data[p * 4]!
    const g = data[p * 4 + 1]!
    const b = data[p * 4 + 2]!
    const lum = (r + g + b) / 3
    const chroma = Math.max(r, g, b) - Math.min(r, g, b)
    if (lum >= 225 && chroma <= 24) voile += 1
  }
  return opaques ? voile / opaques : 0
}

export type IsolationOk = {
  ok: true
  /** le rendu isolé brut (PNG, fond plat) */
  isolePng: Buffer
  /** le détourage décontaminé (PNG alpha recadré) */
  cutout: CutoutDecontamineResult
  tentatives: number
  imagesGenerees: number
  cout: { generationEur: number; relectureEur: number }
}

export type IsolationEchec = {
  ok: false
  raison: string
  /** le dernier rendu d'isolation (diagnostic sur pièces — jamais livré) */
  dernierIsolePng: Buffer | null
  tentatives: number
  imagesGenerees: number
  cout: { generationEur: number; relectureEur: number }
}

export type IsolationResult = IsolationOk | IsolationEchec

export async function isolateLogoRender(opts: {
  /** le rendu intégral choisi par l'utilisateur (data URL) */
  renderDataUrl: string
  /** le mot du brief — vérifié glyphe par glyphe sur le rendu isolé */
  expectedWord: string | null
  /** run 5.8 (monogramme) : présence non exigée */
  expectedOptional?: boolean
  resolution?: '1K' | '2K' | '4K'
  log: { userId: string; projectId?: string | null; assetId?: string | null; kind: string }
}): Promise<IsolationResult> {
  const resolution = opts.resolution ?? '4K'
  const base64 = opts.renderDataUrl.split(',').pop() ?? ''
  const reference = { data: base64, mimeType: 'image/png' }

  let tokensIn = 0
  let tokensOut = 0
  let ocrIn = 0
  let ocrOut = 0
  let imagesGenerees = 0
  let derniereRaison = 'aucune tentative'
  let dernierIsolePng: Buffer | null = null

  for (let tentative = 0; tentative < ISOLATION_MAX_TENTATIVES; tentative += 1) {
    let isolePng: Buffer
    try {
      const generation = await generateWithSoftRetry({
        model: ENGINE_MODELS.logoImage,
        prompt: compileIsolationPrompt(tentative),
        referenceImages: [reference],
        referencesFirst: true,
        referenceLabels: ['THE SOURCE — the logo to lift from its background (keep every glyph exactly as drawn, replace everything around it):'],
        imageConfig: { aspectRatio: '1:1', imageSize: resolution },
        thinkingLevel: LOGO_THINKING_LEVEL,
        log: { ...opts.log, kind: `${opts.log.kind}_isolation`, resolution },
      })
      tokensIn += generation.usage.tokensIn
      tokensOut += generation.usage.tokensOut
      imagesGenerees += 1
      isolePng = Buffer.from(generation.dataUrl.split(',').pop() ?? '', 'base64')
      dernierIsolePng = isolePng
    } catch (error) {
      derniereRaison = `génération d'isolation échouée : ${(error as Error).message}`
      continue
    }

    // Verdict 1 — le fond est-il plat ? Le détourage décontaminé répond :
    // ratio de fond flood-fillé et bbox du contenu.
    const cutout = await cutoutDecontamine(isolePng)
    if (
      cutout.fondRatio < ISOLATION_FOND_RATIO_MIN ||
      cutout.bboxFraction.width > ISOLATION_BBOX_MAX ||
      cutout.bboxFraction.height > ISOLATION_BBOX_MAX
    ) {
      derniereRaison = `fond non plat (fond ${(cutout.fondRatio * 100).toFixed(1)} %, bbox ${(cutout.bboxFraction.width * 100).toFixed(0)}×${(cutout.bboxFraction.height * 100).toFixed(0)} %)`
      continue
    }

    // Verdict 1bis — le VOILE BLANC (glow/ombre conservé au détourage) : la
    // tache de détourage des lockups 3D vécue depuis le 5.9. Un rendu isolé
    // dont l'alpha porte un bloc quasi blanc est rejeté — la tentative
    // suivante exige zéro glow, sinon fallback base typo.
    const voile = await voileBlancRatio(cutout.png)
    if (voile > VOILE_BLANC_MAX_RATIO) {
      derniereRaison = `voile blanc conservé au détourage (${(voile * 100).toFixed(1)} % des pixels opaques quasi blancs — glow/ombre non retiré par l'isolation)`
      continue
    }

    // Verdict 2 — l'identité du mot a survécu (glyphe par glyphe).
    if (opts.expectedWord) {
      const verdict = await verifyRenderedText({
        dataUrl: `data:image/png;base64,${isolePng.toString('base64')}`,
        expectedTexts: [opts.expectedWord],
        expectedOptional: opts.expectedOptional,
        onTokens: (tIn, tOut) => {
          ocrIn += tIn
          ocrOut += tOut
        },
      })
      if (!verdict.ok) {
        derniereRaison = `orthographe altérée par l'isolation : ${verdict.detail}`
        continue
      }
    }

    return {
      ok: true,
      isolePng,
      cutout,
      tentatives: tentative + 1,
      imagesGenerees,
      cout: {
        generationEur: estimateCostEur({ model: ENGINE_MODELS.logoImage, tokensIn, tokensOut, imagesOut: imagesGenerees, resolution }),
        relectureEur: estimateCostEur({ model: 'gemini-3.5-flash', tokensIn: ocrIn, tokensOut: ocrOut }),
      },
    }
  }

  return {
    ok: false,
    raison: derniereRaison,
    dernierIsolePng,
    tentatives: ISOLATION_MAX_TENTATIVES,
    imagesGenerees,
    cout: {
      generationEur: estimateCostEur({ model: ENGINE_MODELS.logoImage, tokensIn, tokensOut, imagesOut: imagesGenerees, resolution }),
      relectureEur: estimateCostEur({ model: 'gemini-3.5-flash', tokensIn: ocrIn, tokensOut: ocrOut }),
    },
  }
}

/** Pose le détourage au centre d'un canevas carré transparent — le livrable
 *  alpha du produit (même géométrie que stack.alpha : la marque occupe
 *  `echelle` de la largeur). */
export async function poseSurCanevasCarre(cutoutPng: Buffer, taille: number, echelle = 0.66): Promise<Buffer> {
  const ratio = Math.min(0.8, Math.max(0.5, echelle))
  const targetW = Math.round(taille * ratio)
  const resized = await sharp(cutoutPng).resize(targetW, targetW, { fit: 'inside', withoutEnlargement: false }).png().toBuffer()
  const meta = await sharp(resized).metadata()
  const w = meta.width ?? targetW
  const h = meta.height ?? targetW
  return sharp({ create: { width: taille, height: taille, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: resized, left: Math.round((taille - w) / 2), top: Math.round((taille - h) / 2) }])
    .png()
    .toBuffer()
}

// ── Le fallback des deux échecs : la base typographique locale, composée
// comme aujourd'hui (lettrage vraie police + emblème IA détouré + assembleLogo).
// Orthographe parfaite par construction — c'est le filet, pas la voie noble.
export async function composeAlphaLocale(opts: {
  recette: LogoCalquesRecette
  famille: LogoFamilleRendu
  palette: string[]
  taille: number
  log: { userId: string; projectId?: string | null; assetId?: string | null; kind: string }
}): Promise<{ alphaPng: Buffer; emblemeGenere: boolean; imagesGenerees: number; generationEur: number }> {
  let emblemePng: Buffer | undefined
  let imagesGenerees = 0
  let tokensIn = 0
  let tokensOut = 0

  if (opts.recette.embleme && opts.recette.disposition !== 'lettrage_seul') {
    try {
      const generation = await generateWithOcrGate({
        model: ENGINE_MODELS.logoImage,
        prompt: compileEmblemePrompt({ embleme: opts.recette.embleme, famille: opts.famille, palette: opts.palette }),
        imageConfig: { aspectRatio: '1:1', imageSize: '2K' },
        thinkingLevel: LOGO_THINKING_LEVEL,
        expectedTexts: [],
        forbidAnyText: true,
        log: { ...opts.log, kind: `${opts.log.kind}_embleme_fallback`, resolution: '2K' },
      })
      tokensIn += generation.usage.tokensIn
      tokensOut += generation.usage.tokensOut
      imagesGenerees += 1 + generation.ocrRejects
      emblemePng = (await cutoutDecontamine(Buffer.from(generation.dataUrl.split(',').pop() ?? '', 'base64'))).png
    } catch (error) {
      // l'emblème n'est pas bloquant : le lettrage typographié local suffit
      console.warn(`[logo-isolate] emblème fallback abandonné (${opts.log.kind}) :`, (error as Error).message)
    }
  }

  const stack = await assembleLogo({ recette: opts.recette, emblemePng, taille: opts.taille })
  return {
    alphaPng: stack.alpha,
    emblemeGenere: Boolean(emblemePng),
    imagesGenerees,
    generationEur: estimateCostEur({ model: ENGINE_MODELS.logoImage, tokensIn, tokensOut, imagesOut: imagesGenerees, resolution: '2K' }),
  }
}
