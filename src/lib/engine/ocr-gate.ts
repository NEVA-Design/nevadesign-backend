import sharp from 'sharp'
import { geminiVisionJson, GeminiError, type ThinkingLevel } from '../ai/gemini'
import { generateWithSoftRetry, type EngineGenerationLog, type EngineGenerationResult } from './generation'
import { logGeneration } from './guards'

// ── L'OCR gate (run 5.2, LOT 3/4) ────────────────────────────────────────────
// Rien de mal épelé n'atteint l'écran : toute proposition dont le texte lu
// diffère du texte attendu (nom du serveur, baseline) est rejetée et
// régénérée EN SILENCE — max 2 régénérations par slot, chaque rejet loggé
// côté système (generation_logs, kind suffixé _ocr_reject). Si la dernière
// tentative échoue encore, on renvoie une erreur propre : on n'affiche pas.

const OCR_MODEL = 'gemini-3.5-flash'
const MAX_OCR_RETRIES = 2

// Normalisation : l'OCR compare des lettres, pas des styles — casse, accents
// et séparateurs ne comptent pas ; l'ordre des caractères, si.
export function normalizeForOcr(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
}

type OcrReading = {
  texts: string[]
  exact_match: boolean
  misspelled_variant: string | null
}

export type OcrVerdict = {
  ok: boolean
  readTexts: string[]
  detail: string
}

export async function verifyRenderedText(opts: {
  dataUrl: string
  expectedTexts: string[]
  onTokens?: (tokensIn: number, tokensOut: number) => void
}): Promise<OcrVerdict> {
  const expected = opts.expectedTexts.map((t) => t.trim()).filter(Boolean)
  if (!expected.length) return { ok: true, readTexts: [], detail: 'aucun texte attendu' }

  // L'image descend à 768 px pour l'appel vision — l'orthographe se lit
  // très bien à cette taille et les tokens image fondent.
  const base64 = opts.dataUrl.split(',').pop() ?? ''
  const small = await sharp(Buffer.from(base64, 'base64'))
    .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer()

  const reading = await geminiVisionJson<OcrReading>({
    model: OCR_MODEL,
    imageBase64: small.toString('base64'),
    mimeType: 'image/jpeg',
    prompt: [
      `Read ALL rendered text in this image (stylized display lettering included).`,
      `Expected text(s), exact spelling: ${expected.map((t) => `"${t.toUpperCase()}"`).join(', ')}.`,
      `Answer as JSON: {"texts": [every distinct word/line you can read], "exact_match": true only if EVERY expected text appears with EXACTLY correct spelling (case and accents ignored), "misspelled_variant": the misspelled rendering if you see a near-miss of an expected text, else null}.`,
      `Be strict: a single missing, doubled, swapped or extra character means exact_match=false.`,
    ].join('\n'),
    temperature: 0,
    maxOutputTokens: 400,
    thinkingBudget: 0,
    onUsage: (u) => opts.onTokens?.(u.tokensIn, u.tokensOut),
  })

  if (!reading) {
    // OCR illisible : on ne bloque pas le produit sur une panne de vision,
    // mais on trace — le taux se surveille dans generation_logs.
    return { ok: true, readTexts: [], detail: 'ocr_unreadable' }
  }

  const haystack = normalizeForOcr((reading.texts ?? []).join(' '))
  const everyExpectedRead = expected.every((t) => haystack.includes(normalizeForOcr(t)))
  const ok = Boolean(reading.exact_match) && everyExpectedRead

  return {
    ok,
    readTexts: reading.texts ?? [],
    detail: ok
      ? 'exact'
      : reading.misspelled_variant
        ? `variante mal épelée lue : ${reading.misspelled_variant}`
        : `attendu ${expected.join(' / ')}, lu ${(reading.texts ?? []).join(' / ') || '(rien)'}`,
  }
}

export type OcrGatedResult = EngineGenerationResult & {
  ocrRejects: number
  ocrDetail: string
  // tokens vision consommés par la porte OCR (toutes tentatives) — alimente
  // le coût « relecture » de la page de test (run 5.3)
  ocrTokensIn: number
  ocrTokensOut: number
}

// Génération + porte OCR : régénère en silence tant que l'orthographe n'est
// pas parfaite (max MAX_OCR_RETRIES rejets), loggue chaque rejet, et jette
// une erreur propre si la dernière tentative reste fautive.
export async function generateWithOcrGate(opts: {
  model: string
  prompt: string
  referenceImages?: Array<{ data: string; mimeType: string }>
  imageConfig?: { aspectRatio?: string; imageSize?: '1K' | '2K' | '4K' }
  thinkingLevel?: ThinkingLevel
  expectedTexts: string[]
  log: EngineGenerationLog
}): Promise<OcrGatedResult> {
  let rejects = 0
  let lastDetail = 'exact'
  let totalOcrIn = 0
  let totalOcrOut = 0

  for (let attempt = 0; attempt <= MAX_OCR_RETRIES; attempt += 1) {
    const result = await generateWithSoftRetry({
      model: opts.model,
      prompt: opts.prompt,
      referenceImages: opts.referenceImages,
      imageConfig: opts.imageConfig,
      thinkingLevel: opts.thinkingLevel,
      log: opts.log,
    })

    if (!opts.expectedTexts.length) {
      return { ...result, ocrRejects: rejects, ocrDetail: 'aucun texte attendu', ocrTokensIn: totalOcrIn, ocrTokensOut: totalOcrOut }
    }

    let ocrTokensIn = 0
    let ocrTokensOut = 0
    const verdict = await verifyRenderedText({
      dataUrl: result.dataUrl,
      expectedTexts: opts.expectedTexts,
      onTokens: (tIn, tOut) => {
        ocrTokensIn += tIn
        ocrTokensOut += tOut
      },
    })
    totalOcrIn += ocrTokensIn
    totalOcrOut += ocrTokensOut

    if (verdict.ok) {
      return { ...result, ocrRejects: rejects, ocrDetail: verdict.detail, ocrTokensIn: totalOcrIn, ocrTokensOut: totalOcrOut }
    }

    // Rejet silencieux : l'utilisateur ne voit rien, le système logge tout
    // (l'image rejetée a bien été générée et payée : imagesOut reste 1).
    rejects += 1
    lastDetail = verdict.detail
    void logGeneration({
      userId: opts.log.userId,
      projectId: opts.log.projectId ?? null,
      assetId: opts.log.assetId ?? null,
      kind: `${opts.log.kind}_ocr_reject`,
      model: OCR_MODEL,
      resolution: opts.log.resolution ?? null,
      imagesOut: 0,
      tokensIn: ocrTokensIn,
      tokensOut: ocrTokensOut,
    })
  }

  console.warn(`[ocr-gate] ${opts.log.kind} : ${rejects} rejets, dernier verdict — ${lastDetail}`)
  throw new GeminiError(
    "Le moteur n'a pas réussi une orthographe parfaite sur cette proposition — relance la génération.",
    422,
    false
  )
}
