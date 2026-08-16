import sharp from 'sharp'
import { geminiVisionJson, GeminiError, type ThinkingLevel } from '../ai/gemini'
import { generateWithSoftRetry, type EngineGenerationLog, type EngineGenerationResult } from './generation'
import { logGeneration } from './guards'

// ── L'OCR gate (run 5.2, LOT 3/4 — durci run 5.7, LOT 3.3) ───────────────────
// Rien de mal épelé n'atteint l'écran : toute proposition dont le texte lu
// diffère du texte attendu (nom du serveur, baseline) est rejetée et
// régénérée EN SILENCE — max 2 régénérations par slot, chaque rejet loggé
// côté système (generation_logs, kind suffixé _ocr_reject). Si la dernière
// tentative échoue encore, on renvoie une erreur propre : on n'affiche pas.
//
// Run 5.7 : LISTE BLANCHE STRICTE. Le bug « The Ocean Swell » du 5.6 venait
// du code qui ne testait que la PRÉSENCE des textes attendus, jamais l'absence
// de mots EN TROP (la détection reposait sur le seul booléen exact_match du
// modèle). La décision est maintenant une fonction pure (ocrDecision) : tout
// mot lu hors liste blanche = rejet. Et le mode `forbidAnyText` protège les
// calques IA du pipeline superposé (fond, emblème) : AUCUN texte toléré.

const OCR_MODEL = 'gemini-3.5-flash'
// 2 rejets silencieux + la tentative initiale = 3 essais par calque, la même
// enveloppe pour l'exclusion (fond/emblème) et la liste blanche (lockup 5.8).
export const MAX_OCR_RETRIES = 2

// Un résidu de moins de 3 caractères alphanumériques consécutifs n'est pas un
// « mot » : les micro-marques (grain, éclats) lues comme 1-2 lettres ne
// doivent pas faire rejeter un rendu sain.
const EXTRA_WORD_MIN_CHARS = 3

// Normalisation : l'OCR compare des lettres, pas des styles — casse, accents
// et séparateurs ne comptent pas ; l'ordre des caractères, si.
export function normalizeForOcr(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
}

export type OcrDecision = {
  ok: boolean
  motsEnTrop: string[]
  attendusManquants: string[]
}

// ── LA décision liste-blanche, pure et testée (scripts/test-ocr-exclusion.ts) ─
// Chaque texte lu doit être couvert par la liste blanche : soit il fait partie
// d'un texte attendu (fragment : « OCEAN » pour « THE OCEAN »), soit un texte
// attendu se lit à travers la concaténation. Tout mot résiduel >= 3 caractères
// est un mot EN TROP → rejet. En mode forbidAnyText (calques IA), la liste
// blanche est vide : le moindre mot lu rejette le rendu.
export function ocrDecision(readTexts: string[], expectedTexts: string[], opts?: { forbidAnyText?: boolean; expectedOptional?: boolean }): OcrDecision {
  const expected = expectedTexts.map(normalizeForOcr).filter(Boolean)
  const reads = readTexts.map((t) => ({ brut: t, norm: normalizeForOcr(t) })).filter((t) => t.norm)

  // 1. présence : chaque attendu se lit dans la concaténation des lectures.
  // Run 5.8 (lockup monogramme) : en mode expectedOptional, la présence n'est
  // PAS exigée — une lettre ultra-stylisée peut être illisible pour l'OCR sans
  // être une faute ; la liste blanche continue de rejeter les mots EN TROP.
  const haystack = reads.map((r) => r.norm).join('')
  const haystackSpaced = reads.map((r) => r.norm).join(' ')
  const attendusManquants = opts?.expectedOptional
    ? []
    : expected.filter((e) => !haystack.includes(e) && !haystackSpaced.replace(/ /g, '').includes(e))

  // 2. exclusion : tout texte lu doit être couvert par la liste blanche
  const motsEnTrop: string[] = []
  for (const r of reads) {
    if (opts?.forbidAnyText) {
      if (r.norm.length >= EXTRA_WORD_MIN_CHARS) motsEnTrop.push(r.brut)
      continue
    }
    // couvert si : fragment d'un attendu, ou concaténation exacte d'attendus
    const couvert = expected.some((e) => e.includes(r.norm)) || isConcatOfExpected(r.norm, expected)
    if (!couvert && r.norm.length >= EXTRA_WORD_MIN_CHARS) motsEnTrop.push(r.brut)
  }

  return { ok: attendusManquants.length === 0 && motsEnTrop.length === 0, motsEnTrop, attendusManquants }
}

// « FRUITZRP » lu d'un bloc quand la liste blanche est ["FRUITZ","RP"] :
// une lecture est couverte si elle se découpe entièrement en textes attendus.
function isConcatOfExpected(read: string, expected: string[]): boolean {
  if (!read) return true
  for (const e of expected) {
    if (e && read.startsWith(e) && isConcatOfExpected(read.slice(e.length), expected)) return true
  }
  return false
}

type OcrReading = {
  texts: string[]
  exact_match: boolean
  misspelled_variant: string | null
}

// Run 5.9 (chantier 2) : lecture GLYPHE PAR GLYPHE pour le lockup — la
// lecture « de mots » du 5.8 laissait la vision reconnaître « FRUITZ »
// top-down sur des glyphes cassés (iter11 : « FRU VTZ » sur deux lignes,
// 0 rejet OCR, journal « orthographe parfaite »).
type GlyphReading = {
  glyphs: string[]
  first_glance_read: boolean
  other_texts: string[]
}

export type GlyphDecision = {
  ok: boolean
  lu: string
  detail: string
}

// LA décision glyphe à glyphe, pure et testée (scripts/test-glyph-gate.ts) :
// chaque forme transcrite est comparée position par position au mot attendu.
// Le moindre écart — lettre manquante, doublée, déformée (transcrite '?'),
// substituée — rejette le lockup.
export function glyphDecision(glyphs: string[], expectedWord: string): GlyphDecision {
  const attendu = normalizeForOcr(expectedWord)
  const lus = glyphs.map((g) => {
    const n = normalizeForOcr(String(g))
    return n.length === 1 ? n : '?' // un glyphe = UNE forme ; ambigu/malformé = ?
  })
  const lu = lus.join('')
  if (lus.length !== attendu.length) {
    return { ok: false, lu, detail: `glyphes lus « ${lu} » (${lus.length}) ≠ attendu « ${attendu} » (${attendu.length})` }
  }
  for (let i = 0; i < attendu.length; i++) {
    if (lus[i] !== attendu[i]) {
      return { ok: false, lu, detail: `glyphe ${i + 1} lu « ${lus[i]} » ≠ « ${attendu[i]} » (mot lu « ${lu} », attendu « ${attendu} »)` }
    }
  }
  return { ok: true, lu, detail: 'glyphes exacts' }
}

export type OcrVerdict = {
  ok: boolean
  readTexts: string[]
  detail: string
}

export async function verifyRenderedText(opts: {
  dataUrl: string
  expectedTexts: string[]
  /** calques IA du pipeline superposé (fond, emblème) : AUCUN texte toléré */
  forbidAnyText?: boolean
  /** run 5.8 (lockup monogramme) : présence non exigée, mots en trop rejetés */
  expectedOptional?: boolean
  onTokens?: (tokensIn: number, tokensOut: number) => void
}): Promise<OcrVerdict> {
  const expected = opts.expectedTexts.map((t) => t.trim()).filter(Boolean)
  if (!expected.length && !opts.forbidAnyText) return { ok: true, readTexts: [], detail: 'aucun texte attendu' }

  // L'image descend à 768 px pour l'appel vision — l'orthographe se lit
  // très bien à cette taille et les tokens image fondent.
  const base64 = opts.dataUrl.split(',').pop() ?? ''
  const small = await sharp(Buffer.from(base64, 'base64'))
    .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer()

  // ── Run 5.9 : MODE GLYPHE pour le lockup (un seul mot attendu) ─────────────
  // Transcription stricte forme par forme + « un inconnu le lirait-il du
  // premier coup ? » — la comparaison lettre à lettre se fait EN CODE.
  if (expected.length === 1 && !opts.forbidAnyText && !opts.expectedOptional) {
    const mot = expected[0]!
    const reading = await geminiVisionJson<GlyphReading>({
      model: OCR_MODEL,
      imageBase64: small.toString('base64'),
      mimeType: 'image/jpeg',
      prompt: [
        `This image contains ONE stylized logo wordmark. Transcribe it GLYPH BY GLYPH.`,
        `Rules — follow them mechanically:`,
        `- "glyphs": list EVERY letter-shape from left to right (top line first if the lettering breaks across lines), EXACTLY as drawn — one entry per shape.`,
        `- Transcribe what the SHAPE is, not what the word should be. Do NOT use context or vocabulary to fix a shape: a malformed, merged, swallowed, split or ambiguous shape is transcribed as "?".`,
        `- A shape that reads as another letter (e.g. an R drawn like a P, a U eaten by an emblem that reads as V) is transcribed as what it LOOKS like, not what it was meant to be.`,
        `- Decorative emblems, slices, drops or icons are NOT glyphs — skip them unless they replace a letter, in which case transcribe what the resulting shape reads as.`,
        `- "first_glance_read": true ONLY if a stranger who does NOT know this brand would read the intended word correctly on FIRST glance, without effort.`,
        `- "other_texts": any OTHER readable text anywhere in the image (taglines, watermarks, background words) — empty array if none.`,
        `Answer as JSON: {"glyphs": ["F","R","?", ...], "first_glance_read": bool, "other_texts": []}.`,
      ].join('\n'),
      temperature: 0,
      maxOutputTokens: 400,
      thinkingBudget: 0,
      onUsage: (u) => opts.onTokens?.(u.tokensIn, u.tokensOut),
    })

    if (!reading) return { ok: true, readTexts: [], detail: 'ocr_unreadable' }

    const glyphes = glyphDecision(reading.glyphs ?? [], mot)
    const extras = (reading.other_texts ?? [])
      .map((t) => ({ brut: t, norm: normalizeForOcr(t) }))
      .filter((t) => t.norm.length >= EXTRA_WORD_MIN_CHARS && !normalizeForOcr(mot).includes(t.norm))
    const firstGlance = Boolean(reading.first_glance_read)
    const ok = glyphes.ok && firstGlance && extras.length === 0

    let detail = 'glyphes exacts, lecture premier coup'
    if (!glyphes.ok) detail = glyphes.detail
    else if (!firstGlance) detail = `glyphes exacts mais lecture premier coup douteuse (mot lu « ${glyphes.lu} »)`
    else if (extras.length) detail = `mots EN TROP : ${extras.map((e) => e.brut).join(' / ')}`

    return { ok, readTexts: [glyphes.lu, ...extras.map((e) => e.brut)], detail }
  }

  const reading = await geminiVisionJson<OcrReading>({
    model: OCR_MODEL,
    imageBase64: small.toString('base64'),
    mimeType: 'image/jpeg',
    prompt: [
      `Read ALL rendered text in this image (stylized display lettering included). Report EVERY distinct word or line you can read, even partial, decorative or background text.`,
      expected.length
        ? `Expected text(s), exact spelling: ${expected.map((t) => `"${t.toUpperCase()}"`).join(', ')}.`
        : `This image must contain NO text at all.`,
      `Answer as JSON: {"texts": [every distinct word/line you can read], "exact_match": ${
        expected.length
          ? 'true only if EVERY expected text appears with EXACTLY correct spelling (case and accents ignored) AND no other text exists anywhere'
          : 'true only if the image contains zero readable characters'
      }, "misspelled_variant": the misspelled rendering if you see a near-miss of an expected text, else null}.`,
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

  // Run 5.7 : la décision liste-blanche est EN CODE (ocrDecision) — le
  // booléen exact_match du modèle reste une ceinture supplémentaire quand des
  // textes sont attendus, plus jamais la seule défense contre les mots en trop.
  // Run 5.8 : en mode expectedOptional (monogramme), exact_match n'est exigé
  // que si l'OCR a lu quelque chose — une lecture vide est acceptable.
  const decision = ocrDecision(reading.texts ?? [], expected, { forbidAnyText: opts.forbidAnyText, expectedOptional: opts.expectedOptional })
  const nothingRead = !(reading.texts ?? []).some((t) => normalizeForOcr(t))
  const exactOk = opts.expectedOptional && nothingRead ? true : expected.length === 0 || Boolean(reading.exact_match)
  const ok = decision.ok && exactOk

  let detail = 'exact'
  if (!ok) {
    if (decision.motsEnTrop.length) {
      detail = `mots EN TROP hors liste blanche : ${decision.motsEnTrop.join(' / ')}`
    } else if (decision.attendusManquants.length) {
      detail = reading.misspelled_variant
        ? `variante mal épelée lue : ${reading.misspelled_variant}`
        : `attendu ${expected.join(' / ')}, lu ${(reading.texts ?? []).join(' / ') || '(rien)'}`
    } else {
      detail = reading.misspelled_variant
        ? `variante mal épelée lue : ${reading.misspelled_variant}`
        : 'exact_match=false (orthographe douteuse signalée par la vision)'
    }
  } else if (opts.forbidAnyText) {
    detail = 'aucun texte (exclusion respectée)'
  }

  return { ok, readTexts: reading.texts ?? [], detail }
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
  /** run 5.9 : images avant le texte, étiquetées */
  referencesFirst?: boolean
  referenceLabels?: string[]
  expectedTexts: string[]
  /** calques IA du pipeline superposé : AUCUN texte toléré (liste blanche vide) */
  forbidAnyText?: boolean
  /** run 5.8 (lockup monogramme) : présence non exigée, mots en trop rejetés */
  expectedOptional?: boolean
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
      referencesFirst: opts.referencesFirst,
      referenceLabels: opts.referenceLabels,
      log: opts.log,
    })

    if (!opts.expectedTexts.length && !opts.forbidAnyText) {
      return { ...result, ocrRejects: rejects, ocrDetail: 'aucun texte attendu', ocrTokensIn: totalOcrIn, ocrTokensOut: totalOcrOut }
    }

    let ocrTokensIn = 0
    let ocrTokensOut = 0
    const verdict = await verifyRenderedText({
      dataUrl: result.dataUrl,
      expectedTexts: opts.expectedTexts,
      forbidAnyText: opts.forbidAnyText,
      expectedOptional: opts.expectedOptional,
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
