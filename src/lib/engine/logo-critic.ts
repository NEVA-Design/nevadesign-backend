import sharp from 'sharp'
import { geminiVisionJson, type GeminiUsage } from '../ai/gemini'
import { logGeneration } from './guards'
import { LOGO_AMBIANCE_PROMPTS, type LogoAnswersV3 } from './logo-brief'
import type { LogoConcept } from './logo-director'

// ── Étage 3 : la relecture critique de concept (run 5.3, LOT 1) ─────────────
// Après l'OCR gate (épellation stricte, inchangé), chaque rendu est relu
// CONTRE SON BRIEF par le modèle vision : le thème est-il présent (le fruit,
// le dauphin…) ? le dégradé demandé est-il respecté ? le fond est-il
// conforme ? Verdict structuré ; en cas d'échec, la route régénère UNE fois
// avec les défauts nommés dans le prompt, puis affiche le meilleur des deux.
// C'est de l'analyse mécanique, pas de la création : flash + thinkingBudget 0
// (l'interdit « jamais thinking à 0 » ne vise que le DA et la génération).

const CRITIC_MODEL = 'gemini-3.5-flash'

export type ConceptVerdict = {
  ok: boolean
  themeOk: boolean
  couleursOk: boolean
  fondOk: boolean
  // défauts nommés — réinjectés tels quels dans le prompt de régénération
  defauts: string[]
  usage: GeminiUsage
}

type CriticReading = {
  theme_present: boolean
  colors_respected: boolean
  background_conform: boolean
  defects: string[]
}

export async function reviewLogoAgainstConcept(opts: {
  dataUrl: string
  concept: LogoConcept
  answers: LogoAnswersV3
  projectName: string
  log: { userId: string; projectId?: string | null; assetId?: string | null; kind: string }
}): Promise<ConceptVerdict> {
  const { answers } = opts
  const base64 = opts.dataUrl.split(',').pop() ?? ''
  const small = await sharp(Buffer.from(base64, 'base64'))
    .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer()

  const expectations = [
    answers.sujet
      ? `THEME: the logo must visibly embody the theme "${answers.sujet}" (given by the user). A generic compass/crest/badge with no trace of this theme = theme_present false.`
      : 'THEME: none required (pure lettering brief) — theme_present is true unless an unrequested foreign theme dominates.',
    answers.couleurs.mode === 'degrade'
      ? `COLORS: the mark must carry a gradient close to ${answers.couleurs.couleurs.join(' → ')} (direction ~${answers.couleurs.angle}°). Flat single-color rendering or wrong hue family = colors_respected false.`
      : answers.couleurs.mode === 'unie'
        ? `COLORS: the dominant color must be close to ${answers.couleurs.couleur}. A clearly different hue family = colors_respected false.`
        : 'COLORS: free palette — colors_respected is true unless the render is muddy or colorless.',
    answers.fond === 'degrade_motifs'
      ? 'BACKGROUND: expected full-bleed gradient background with small thematic doodle motifs. A flat empty background = background_conform false.'
      : answers.fond === 'plein'
        ? 'BACKGROUND: expected one solid full-bleed background color. A busy scene or gradient+motifs = background_conform false.'
        : 'BACKGROUND: expected a flat uniform neutral studio background (for cutout). A busy scene behind the mark = background_conform false.',
    answers.interdits ? `USER FORBIDS: "${answers.interdits}" — if violated, name it in defects.` : '',
  ].filter(Boolean).join('\n')

  let usage: GeminiUsage = { tokensIn: 0, tokensOut: 0 }
  const reading = await geminiVisionJson<CriticReading>({
    model: CRITIC_MODEL,
    imageBase64: small.toString('base64'),
    mimeType: 'image/jpeg',
    prompt: [
      `This image is a logo proposal for the server "${opts.projectName}", generated from the concept "${opts.concept.nom}".`,
      `CONCEPT INTENT: ${opts.concept.justification}`,
      'Review the render STRICTLY against these expectations:',
      expectations,
      'Answer as JSON: {"theme_present": bool, "colors_respected": bool, "background_conform": bool, "defects": ["each failed expectation as one short imperative fix instruction in English, e.g. \'integrate the fruit theme into the lettering\', \'apply the coral-to-peach gradient on the wordmark\'"]}. Empty defects array if everything passes.',
    ].join('\n'),
    temperature: 0,
    maxOutputTokens: 400,
    thinkingBudget: 0,
    onUsage: (u) => {
      usage = { tokensIn: usage.tokensIn + u.tokensIn, tokensOut: usage.tokensOut + u.tokensOut }
    },
  })

  // Vision illisible : on ne bloque pas le produit — verdict permissif tracé.
  const verdict: ConceptVerdict = reading
    ? {
        themeOk: Boolean(reading.theme_present),
        couleursOk: Boolean(reading.colors_respected),
        fondOk: Boolean(reading.background_conform),
        defauts: (reading.defects ?? []).map((d) => String(d)).slice(0, 4),
        ok: Boolean(reading.theme_present && reading.colors_respected && reading.background_conform),
        usage,
      }
    : { ok: true, themeOk: true, couleursOk: true, fondOk: true, defauts: [], usage }

  void logGeneration({
    userId: opts.log.userId,
    projectId: opts.log.projectId ?? null,
    assetId: opts.log.assetId ?? null,
    kind: verdict.ok ? opts.log.kind : `${opts.log.kind}_echec`,
    model: CRITIC_MODEL,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
  })

  return verdict
}
