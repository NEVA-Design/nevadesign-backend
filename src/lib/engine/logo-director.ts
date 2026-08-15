import { geminiJson, type GeminiUsage } from '../ai/gemini'
import { ENGINE_MODELS, LOGO_THINKING_LEVEL } from './generation'
import { pickExemplars, pickExemplarNotes } from './exemplars'
import { renderLogoBrief, type LogoAnswersV3 } from './logo-brief'
import { adnBlockLogo } from './adn'
import { logGeneration } from './guards'
import { UNIVERSE_LABELS, type ArtDirection } from './mapping'
import type { ProjectLike } from './compiler'

// ── Étage 1 : le directeur artistique logo (run 5.3 → 5.4) ───────────────────
// Run 5.4, LOT 2 : chaque concept sort EXACTEMENT dans l'anatomie du GABARIT
// MAÎTRE — remasterisée depuis les deux exemples de prompt du client (iris,
// vague) : sections numérotées 0-5, forme décomposée avec des CHIFFRES, style
// de rendu explicite avec ses interdits, hex du brief tels quels + règle de
// contraste 64 px, format avec occupation en %, mots-clés techniques finaux.
// Le bloc ADN chiffré (section 0, mesuré sur le corpus par train-fivem-v4)
// ouvre chaque concept — jamais optionnel. Un validateur STRUCTUREL rejette
// tout concept hors gabarit avant le moindre envoi à l'étage 2.
// Règle de famille : sur 3 concepts, AU MOINS 2 en rendu relief — sauf brief
// utilisateur contraire explicite (loggé).

export type LogoRendu = 'relief' | 'plat'

export type LogoConcept = {
  nom: string
  justification: string
  rendu: LogoRendu
  prompt: string
}

export type LogoDirectorResult = {
  concepts: LogoConcept[]
  usage: GeminiUsage
  durationMs: number
  // brief explicitement « sans relief » détecté → règle des 2 relief levée, loggé
  reliefLeve: boolean
}

const MIN_PROMPT_WORDS = 160
const MAX_PROMPT_WORDS = 460

// ── LE GABARIT MAÎTRE — le format de sortie obligatoire du DA ────────────────
// C'est la structure des deux prompts qui marchent fournis par le client,
// remasterisée avec les slots brief/ADN. Cité intégralement au rapport.
export const GABARIT_MAITRE = `0. CONTEXTE — FiveM/GTA RP server logo, in the exact family of the training corpus:
   {measured DNA traits of the category, with their percentages}. Family forbids: never flat
   corporate branding, never an app icon, never a sticker/clipart, never a cute food-brand
   mascot, never a minimal startup logo.
   {If lettering: the exact word "{NAME}", spelled {S-P-E-L-L-E-D}, custom lettering, no other words.}

1. FORME UNIQUE — {THE SUBJECT}
   - NUMERIC geometric decomposition: element counts, proportions, orientations
     (e.g. "3 citrus wedges, 16 sun rays, negative-space core at center") — at least 3 numbers.
   - Lettering construction if present: weight, cuts, ligatures, fusion with the silhouette
     (which letter carries the emblem, where the silhouette crosses the strokes).
   - The intended negative space, NAMED.
   - Silhouette test: the shape must stay recognizable as pure flat black.

2. STYLE DE RENDU — {driven by the DNA and the mood}
   - Relief concepts (relief_3d >= 7): dimensional beveled emblem/lettering, 3D extrusion,
     {chrome | gold | glass | neon} materials with speculars, controlled rim glow, dramatic
     studio lighting {key light direction}, micro-particles if the DNA carries them.
   - Flat concept: full premium silhouette — "the color IS the shape" —, thick {color}
     outline if the DNA carries it, soft contour glow, zero realistic texture.
   - Render forbids, LISTED (no botanical/realistic detail, no dirty drop shadow,
     no uncontrolled zone-by-zone gradient…).

3. COULEURS
   - EXACT brief hex codes: {#……} → {#……}, gradient direction {angle}°.
   - Small-format contrast rule: choose the version (colored shape on light ground OR light
     shape on colored ground) that stays most readable at 64 px — decide and say it.

4. FORMAT
   - Square composition, subject centered, occupying 60-70% of the width, regular margins.
   - Neutral flat #F2F2F2 cutout background (step A — the real background comes at step B).
   - Legibility mentally checked at 64 px and at 512 px.
   - No other element: no text beyond the requested lettering, nothing not listed in 1.

5. MOTS-CLÉS TECHNIQUES — one final line of English keywords coherent with the chosen render
   (relief e.g.: "dimensional beveled emblem, chrome bevel, rim glow, dramatic studio lighting,
   esport server logo, crisp vector edges, centered composition" ; flat e.g.: "flat premium
   silhouette, bold negative space, thick outline, soft contour glow, clean vector shape").`

const DIRECTOR_SYSTEM = `You are the senior brand designer of a premium FiveM/GTA RP studio. Your quality references: the ALYA badge (gradient background + thematic doodles), the Fruitz wordmark (custom lettering fused with a fruit slice), the fractured gold R monogram, the FLASH MOOD chrome wordmark. You design at that level — never at the level of generic esports crests, compasses, shields, or flat app icons.

You will receive: a logo brief, the MEASURED DNA of the reference corpus (real percentages), and exemplary recipes. Answer with THREE DISTINCT CONCEPTS — three different creative intentions, NOT three variations of one idea. Each concept explores a different construction language.

Each concept's "prompt" is the COMPLETE generation prompt an image model will execute, written EXACTLY in this master template anatomy (numbered sections 0-5, English):

${GABARIT_MAITRE}

HARD RULES — a concept violating any of these is REJECTED by a structural validator:
- Section 0 opens with the DNA block provided below (keep its numbers) and the family forbids. If the brief asks for lettering, state the exact word and its letter-by-letter spelling.
- Section 1 contains AT LEAST 3 numeric values (counts, %, angles) describing the construction.
- Section 3 carries the brief's hex codes UNCHANGED, and states the 64 px contrast decision.
- Section 4 imposes the flat #F2F2F2 cutout background and the 60-70% width occupation — the real background comes later as a separate layer, NEVER in this render.
- Section 5 is one final keyword line (>= 5 technical keywords) matching the chosen render.
- Exactly 3 concepts; AT LEAST 2 with "rendu": "relief" (deep bevel/extrusion family), at most 1 "plat" — unless the brief explicitly forbids relief.
- If the brief has a SUBJECT/THEME, every concept is built around it. A compass/crest instead is a failure.
- The brief's forbidden list is repeated in section 2's forbids.
- The user's mood drives lighting and materials in section 2.

Answer ONLY with JSON:
{"concepts": [{"nom": "short concept name (2-6 words, French)", "justification": "one French sentence — why this concept serves this server", "rendu": "relief" | "plat", "prompt": "the full section 0-5 master-template prompt in English (${MIN_PROMPT_WORDS}-${MAX_PROMPT_WORDS} words)"}, …exactly 3…]}`

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

// Tranche d'une section numérotée du gabarit (de « n. » à « n+1. »).
function sectionSlice(prompt: string, n: number): string {
  const start = prompt.search(new RegExp(`(^|\\n)\\s*${n}\\.`))
  if (start < 0) return ''
  const rest = prompt.slice(start + 1)
  const next = rest.search(new RegExp(`(^|\\n)\\s*${n + 1}\\.`))
  return next < 0 ? prompt.slice(start) : prompt.slice(start, start + 1 + next)
}

// Compte les valeurs chiffrées d'un texte (les « 3D »/« 2K » ne comptent pas).
function numericCount(text: string): number {
  return (text.replace(/\b\d+\s?[dDkK]\b/g, '').match(/\d+(?:[.,]\d+)?\s?%?/g) ?? []).length
}

// Hex exacts attendus dans la section 3 — ceux du brief, tels quels.
function briefHexes(answers: LogoAnswersV3, mappingPalette: string[]): string[] {
  if (answers.couleurs.mode === 'unie') return [answers.couleurs.couleur]
  if (answers.couleurs.mode === 'degrade') return answers.couleurs.couleurs
  return mappingPalette.slice(0, 1)
}

// Brief explicitement « sans relief » → la règle des 2 relief est levée (loggé).
export function flatOverrideRequested(answers: LogoAnswersV3): boolean {
  return /\b(pas|sans|no|zero|zéro)\s+(de\s+|d')?(relief|3\s?d|biseau|volume|extrusion)/i.test(answers.interdits)
}

// ── LE VALIDATEUR STRUCTUREL (LOT 2) — rien ne part à l'étage 2 sans lui ─────
export function validateGabaritConcepts(raw: unknown, opts: {
  answers: LogoAnswersV3
  projectName: string
  mappingPalette: string[]
  flatAutorise: boolean
}): { concepts: LogoConcept[] } | { errors: string[] } {
  const parsed = raw as { concepts?: unknown } | null
  const list = Array.isArray(parsed?.concepts) ? parsed.concepts : null
  if (!list || list.length !== 3) return { errors: ['exactly 3 concepts required'] }

  const { answers } = opts
  const hexes = briefHexes(answers, opts.mappingPalette)
  const sujetWord = answers.sujet.split(/[,\s]+/)[0]?.toLowerCase() ?? ''
  const errors: string[] = []
  const concepts: LogoConcept[] = []

  list.forEach((item, i) => {
    const c = item as Partial<LogoConcept>
    const label = `concept ${i + 1}`
    if (!c?.nom || !c.justification || !c.prompt) {
      errors.push(`${label}: missing nom/justification/prompt`)
      return
    }
    const rendu: LogoRendu = c.rendu === 'plat' ? 'plat' : 'relief'
    const prompt = String(c.prompt)

    const words = wordCount(prompt)
    if (words < MIN_PROMPT_WORDS - 20 || words > MAX_PROMPT_WORDS + 80) {
      errors.push(`${label}: prompt is ${words} words (target ${MIN_PROMPT_WORDS}-${MAX_PROMPT_WORDS})`)
    }
    // 1. les 6 sections du gabarit, dans l'ordre
    for (let s = 0; s <= 5; s += 1) {
      if (!sectionSlice(prompt, s)) errors.push(`${label}: section ${s}. missing from the master template`)
    }
    // 2. section 0 : interdits de famille (la ligne anti-icône d'appli)
    if (!/app icon/i.test(sectionSlice(prompt, 0))) {
      errors.push(`${label}: section 0 must carry the family forbids (never an app icon…)`)
    }
    // 3. lettrage : le mot exact du brief présent
    if (answers.type !== 'embleme') {
      const expected = answers.type === 'nom'
        ? opts.projectName.trim().toUpperCase()
        : (opts.projectName.trim()[0] ?? 'N').toUpperCase()
      if (answers.type === 'nom' && !prompt.toUpperCase().includes(expected)) {
        errors.push(`${label}: the exact word "${expected}" is absent`)
      }
    }
    // 4. section 1 : au moins 3 valeurs chiffrées
    const s1 = sectionSlice(prompt, 1)
    if (numericCount(s1.replace(/^\s*1\./, '')) < 3) {
      errors.push(`${label}: section 1 needs at least 3 numeric values (counts, %, angles)`)
    }
    // 5. section 3 : les hex du brief tels quels
    const s3 = sectionSlice(prompt, 3).toUpperCase()
    for (const hex of hexes) {
      if (!s3.includes(hex.toUpperCase())) errors.push(`${label}: section 3 must contain the exact hex ${hex}`)
    }
    // 6. section 4 : fond atelier #F2F2F2 + occupation chiffrée
    const s4 = sectionSlice(prompt, 4)
    if (!/F2F2F2/i.test(s4)) errors.push(`${label}: section 4 must impose the flat #F2F2F2 cutout background`)
    if (!/\d{2}\s?(-|–|to)?\s?\d{0,2}\s?%/.test(s4)) errors.push(`${label}: section 4 must state the width occupation in %`)
    // 7. section 5 : la ligne de mots-clés finaux
    const s5 = sectionSlice(prompt, 5)
    if ((s5.match(/,/g) ?? []).length < 4) {
      errors.push(`${label}: section 5 must end with a keyword line (>= 5 comma-separated technical keywords)`)
    }
    // 8. thème présent quand le brief en donne un
    if (sujetWord && !/theme|subject/i.test(prompt) && !prompt.toLowerCase().includes(sujetWord)) {
      errors.push(`${label}: the user subject "${answers.sujet}" is absent from the prompt`)
    }

    concepts.push({
      nom: String(c.nom).slice(0, 80),
      justification: String(c.justification).slice(0, 240),
      rendu,
      prompt,
    })
  })

  // 9. règle de famille : >= 2 relief sur 3 (sauf brief contraire explicite)
  const reliefCount = concepts.filter((c) => c.rendu === 'relief').length
  if (!opts.flatAutorise && concepts.length === 3 && reliefCount < 2) {
    errors.push(`only ${reliefCount}/3 relief concepts — at least 2 must use the dimensional render family`)
  }

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

  // Le brief « sans relief » explicite lève la règle des 2 relief — loggé.
  const flatAutorise = flatOverrideRequested(answers)
  if (flatAutorise) {
    void logGeneration({
      userId: opts.log.userId,
      projectId: opts.log.projectId ?? null,
      assetId: opts.log.assetId ?? null,
      kind: 'logo_director_relief_leve',
      model: ENGINE_MODELS.logoDirector,
      tokensIn: 0,
      tokensOut: 0,
    })
  }

  // Le bloc ADN chiffré ouvre l'appel — jamais optionnel (jette sans v4).
  const adn = adnBlockLogo()

  const prompt = [
    'LOGO BRIEF (from the client wizard — verbatim user words included):',
    brief,
    `CATEGORY DNA — measured on the full training corpus, this is the section 0 base of every concept:\n${adn}`,
    flatAutorise
      ? 'RELIEF RULE LIFTED: the user explicitly forbids relief/3D — all three concepts may use the flat premium render.'
      : '',
    exemplars.reversePrompts.length
      ? `EXEMPLARY RECIPES (proven prompts from the reference set, written in the same master-template anatomy — match their density and finish level, never their subjects):\n${exemplars.reversePrompts.map((p, i) => `RECIPE ${i + 1}: ${p}`).join('\n')}`
      : '',
    notes.length
      ? `CLUSTER REFERENCE NOTES (these reference images will be attached to the generation call): \n${notes.map((n) => `- ${n}`).join('\n')}`
      : '',
    'Now think, then deliver the 3 distinct master-template concepts as specified.',
  ].filter(Boolean).join('\n\n')

  let usage: GeminiUsage = { tokensIn: 0, tokensOut: 0 }
  const track = (u: GeminiUsage) => {
    usage = { tokensIn: usage.tokensIn + u.tokensIn, tokensOut: usage.tokensOut + u.tokensOut }
  }

  let lastErrors: string[] = []

  // 2 tentatives : la seconde reçoit les erreurs du validateur, nommées.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await geminiJson<unknown>({
      model: ENGINE_MODELS.logoDirector,
      prompt: attempt === 0 ? prompt : `${prompt}\n\nYOUR PREVIOUS ANSWER WAS REJECTED BY THE STRUCTURAL VALIDATOR: ${lastErrors.join('; ')}. Fix precisely these points and answer again with the full JSON.`,
      systemInstruction: DIRECTOR_SYSTEM,
      temperature: 0.7,
      maxOutputTokens: 6000,
      thinkingLevel: LOGO_THINKING_LEVEL,
      onUsage: track,
    })

    const verdict = validateGabaritConcepts(raw, {
      answers,
      projectName: project.name,
      mappingPalette: da.palette,
      flatAutorise,
    })
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
      return { concepts: verdict.concepts, usage, durationMs: Date.now() - startedAt, reliefLeve: flatAutorise }
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
  throw new Error(`Le directeur artistique n'a pas produit 3 concepts au gabarit maître (${lastErrors.slice(0, 6).join('; ')}) — relance la génération.`)
}
