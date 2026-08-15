import { geminiJson, type GeminiUsage } from '../ai/gemini'
import { ENGINE_MODELS, LOGO_THINKING_LEVEL } from './generation'
import { pickExemplars, pickExemplarNotes } from './exemplars'
import { renderLogoBrief, type LogoAnswersV3 } from './logo-brief'
import { logGeneration } from './guards'
import { UNIVERSE_LABELS, type ArtDirection } from './mapping'
import type { ProjectLike } from './compiler'
import guideLogo from '../../engine/styles/fivem/logo.json'

// ── Étage 1 : le directeur artistique logo (run 5.3, LOT 1) ─────────────────
// Le constat client : des logos génériques (boussoles, blasons esport) sortis
// en ~2 s sans réflexion, thème jamais transmis. Ici, AVANT de dessiner, un
// modèle de raisonnement (Gemini 3.1 Pro, thinking HIGH — jamais 0) écrit
// 3 CONCEPTS DISTINCTS : trois intentions différentes, pas trois variations.
// Chaque concept = nom + justification (1 phrase) + prompt de génération
// complet (150-250 mots) avec sujet, construction du lettrage, matières,
// éclairage, fond, palette exacte (hex) et interdits.

export type LogoConcept = {
  nom: string
  justification: string
  prompt: string
}

export type LogoDirectorResult = {
  concepts: LogoConcept[]
  usage: GeminiUsage
  durationMs: number
}

const MIN_PROMPT_WORDS = 150
const MAX_PROMPT_WORDS = 250

const DIRECTOR_SYSTEM = `You are the senior brand designer of a premium FiveM/GTA RP studio. Your references in quality: the ALYA badge (gradient background + thematic doodles), the Fruitz wordmark (custom lettering fused with a fruit slice), the fractured gold R monogram, the FLASH MOOD chrome wordmark. You design at that level — never at the level of generic esports crests, compasses or shields.

You will receive a logo brief. Your job is to think, then answer with THREE DISTINCT CONCEPTS — three different creative intentions, NOT three variations of one idea. Example for a "fruit, summer, juicy" brief: (1) custom lettering hugging the inside of a fruit slice; (2) retro "juicy" wordmark with a sunset gradient; (3) citrus-sun emblem + monogram. Each concept explores a different construction language.

For EACH concept, write the COMPLETE generation prompt (${MIN_PROMPT_WORDS}-${MAX_PROMPT_WORDS} words, English) that an image model will execute. The prompt MUST specify, concretely: the subject/theme integration, the lettering construction (how letters are drawn, fused, or interleaved with the theme), materials and finishes, lighting, the background treatment, the exact color palette or gradient as hex codes, and what is forbidden. Write prompts, not descriptions — directive voice.

HARD RULES:
- If the brief has a SUBJECT/THEME, every concept is built around it. Inventing an unrelated compass/crest instead is a failure.
- Exact hex codes from the brief travel into every prompt unchanged.
- The brief's forbidden list is repeated in every prompt.
- Concepts must differ in construction, not just in color.

Answer ONLY with JSON:
{"concepts": [{"nom": "short concept name (2-6 words, French)", "justification": "one French sentence — why this concept serves this server", "prompt": "the full ${MIN_PROMPT_WORDS}-${MAX_PROMPT_WORDS} word generation prompt in English"}, …exactly 3…]}`

function guideBlock(): string {
  const guide = (guideLogo as { guide?: Record<string, unknown> }).guide
  if (!guide) return ''
  const sections: string[] = []
  for (const key of ['composition', 'typographie', 'effets', 'grammaire', 'interdits']) {
    const value = guide[key]
    if (Array.isArray(value) && value.length) {
      sections.push(`${key}: ${value.filter((v) => typeof v === 'string').join(' | ')}`)
    }
  }
  return sections.length ? `LOGO STYLE GUIDE (distilled from the client's reference training set):\n${sections.join('\n')}` : ''
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function validateConcepts(raw: unknown, hasSujet: boolean, sujet: string): { concepts: LogoConcept[] } | { errors: string[] } {
  const parsed = raw as { concepts?: unknown } | null
  const list = Array.isArray(parsed?.concepts) ? parsed.concepts : null
  if (!list || list.length !== 3) return { errors: ['exactly 3 concepts required'] }

  const errors: string[] = []
  const concepts: LogoConcept[] = []
  list.forEach((item, i) => {
    const c = item as Partial<LogoConcept>
    if (!c?.nom || !c.justification || !c.prompt) {
      errors.push(`concept ${i + 1}: missing nom/justification/prompt`)
      return
    }
    const words = wordCount(c.prompt)
    if (words < MIN_PROMPT_WORDS - 30 || words > MAX_PROMPT_WORDS + 60) {
      errors.push(`concept ${i + 1}: prompt is ${words} words (target ${MIN_PROMPT_WORDS}-${MAX_PROMPT_WORDS})`)
    }
    // le thème donné par l'utilisateur doit apparaître dans le prompt — au
    // moins un de ses mots significatifs (le DA écrit en anglais, on tolère
    // la traduction : le contrôle dur se fait à l'étage 3 sur l'image).
    if (hasSujet && !/theme|subject/i.test(c.prompt) && !c.prompt.toLowerCase().includes(sujet.split(/[,\s]+/)[0]?.toLowerCase() ?? '')) {
      errors.push(`concept ${i + 1}: the user subject "${sujet}" is absent from the prompt`)
    }
    concepts.push({ nom: String(c.nom).slice(0, 80), justification: String(c.justification).slice(0, 240), prompt: String(c.prompt) })
  })
  return errors.length ? { errors } : { concepts }
}

export async function directLogoConcepts(opts: {
  project: ProjectLike
  da: ArtDirection
  answers: LogoAnswersV3
  energie?: number
  modernite?: number
  log: { userId: string; projectId?: string | null; assetId?: string | null }
}): Promise<LogoDirectorResult> {
  const startedAt = Date.now()
  const { project, da, answers } = opts

  const brief = renderLogoBrief({
    projectName: project.name,
    answers,
    mappingPalette: da.palette,
    universeLabel: UNIVERSE_LABELS[da.universe],
  })

  // 3-5 recettes exemplaires : recettes humaines du dossier d'abord (boost
  // dans scoreEntry), reverse-prompts logo ensuite. Run 5.4 : jette
  // TrainingRequiredError si l'entraînement n'est pas installé — le DA ne
  // travaille plus jamais sans few-shot.
  const exemplars = pickExemplars({ category: 'logo', da, energie: opts.energie, modernite: opts.modernite, maxPrompts: 5, maxReferences: 0 })
  const notes = pickExemplarNotes({ category: 'logo', da, energie: opts.energie, modernite: opts.modernite, max: 4 })

  const prompt = [
    'LOGO BRIEF (from the client wizard — verbatim user words included):',
    brief,
    guideBlock(),
    exemplars.reversePrompts.length
      ? `EXEMPLARY RECIPES (proven prompts from the reference set — client-validated recipes first; match their density and finish level, never their subjects):\n${exemplars.reversePrompts.map((p, i) => `RECIPE ${i + 1}: ${p}`).join('\n')}`
      : '',
    notes.length
      ? `CLUSTER REFERENCE NOTES (these reference images will be attached to the generation call): \n${notes.map((n) => `- ${n}`).join('\n')}`
      : '',
    'Now think, then deliver the 3 distinct concepts as specified.',
  ].filter(Boolean).join('\n\n')

  let usage: GeminiUsage = { tokensIn: 0, tokensOut: 0 }
  const track = (u: GeminiUsage) => {
    usage = { tokensIn: usage.tokensIn + u.tokensIn, tokensOut: usage.tokensOut + u.tokensOut }
  }

  const hasSujet = answers.sujet.length > 0
  let lastErrors: string[] = []

  // 2 tentatives : la seconde reçoit les erreurs de validation nommées.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await geminiJson<unknown>({
      model: ENGINE_MODELS.logoDirector,
      prompt: attempt === 0 ? prompt : `${prompt}\n\nYOUR PREVIOUS ANSWER WAS REJECTED: ${lastErrors.join('; ')}. Fix precisely these points and answer again with the full JSON.`,
      systemInstruction: DIRECTOR_SYSTEM,
      temperature: 0.7,
      maxOutputTokens: 4000,
      thinkingLevel: LOGO_THINKING_LEVEL,
      onUsage: track,
    })

    const verdict = validateConcepts(raw, hasSujet, answers.sujet)
    if ('concepts' in verdict) {
      void logGeneration({
        userId: opts.log.userId,
        projectId: opts.log.projectId ?? null,
        assetId: opts.log.assetId ?? null,
        kind: 'logo_director',
        model: ENGINE_MODELS.logoDirector,
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        retried: attempt > 0,
        durationMs: Date.now() - startedAt,
      })
      return { concepts: verdict.concepts, usage, durationMs: Date.now() - startedAt }
    }
    lastErrors = verdict.errors
  }

  void logGeneration({
    userId: opts.log.userId,
    projectId: opts.log.projectId ?? null,
    assetId: opts.log.assetId ?? null,
    kind: 'logo_director_failed',
    model: ENGINE_MODELS.logoDirector,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    retried: true,
    durationMs: Date.now() - startedAt,
  })
  throw new Error(`Le directeur artistique n'a pas produit 3 concepts valides (${lastErrors.join('; ')}) — relance la génération.`)
}
