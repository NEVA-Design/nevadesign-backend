import { geminiJson, type GeminiUsage } from '../ai/gemini'
import { ENGINE_MODELS, LOGO_THINKING_LEVEL } from './generation'
import { pickExemplars, pickExemplarNotes } from './exemplars'
import { renderLogoBrief, LOGO_AMBIANCE_TAG, type LogoAnswersV3 } from './logo-brief'
import { adnBlockLogo, fondsBlockLogo, famillesRenduLogo } from './adn'
import { logGeneration } from './guards'
import { UNIVERSE_LABELS, type ArtDirection } from './mapping'
import { validateCalquesRecette, type LogoCalquesRecette } from './logo-stack'
import { loadFonts, psdBornes } from './lettrage'
import type { ProjectLike } from './compiler'

// ── Étage 1 : le directeur artistique logo (run 5.3 → 5.6) ───────────────────
// Run 5.4, LOT 2 : chaque concept sort EXACTEMENT dans l'anatomie du GABARIT
// MAÎTRE — sections numérotées, forme décomposée avec des CHIFFRES, style
// de rendu explicite avec ses interdits, hex du brief tels quels + règle de
// contraste 64 px, format avec occupation en %, mots-clés techniques finaux.
// Le bloc ADN chiffré (section 0, mesuré sur le corpus par train-fivem-v4)
// ouvre chaque concept — jamais optionnel. Un validateur STRUCTUREL rejette
// tout concept hors gabarit avant le moindre envoi à l'étage 2.
// Run 5.6 : la règle « >= 2 relief sur 3 » du 5.4 est ABROGÉE (elle a produit
// le faux optimum candy gloss du 5.5). À la place : les 3 concepts viennent
// des 3 FAMILLES DE RENDU mesurées du corpus (clé familles_rendu de
// logo.json — plat premium 46 %, semi-flat biseauté 32 %, dimensionnelle
// 22 %), et chaque concept porte la section 2bis LE FOND (doctrine client :
// jamais vide, couches à 8-20 % d'opacité, « on les voit presque pas »).

export type LogoRendu = 'relief' | 'plat'

// Les 3 familles de rendu mesurées (clusters manifest v4, analyze-fonds.ts).
export const LOGO_FAMILLES_RENDU = ['plat_premium', 'semi_flat_biseau', 'dimensionnelle'] as const
export type LogoFamilleRendu = (typeof LOGO_FAMILLES_RENDU)[number]

export type LogoConcept = {
  nom: string
  justification: string
  // LOT 5 : chaque concept CITE les réponses du brief qu'il utilise —
  // format « "réponse de l'utilisateur" → effet dans le concept »
  citations: string[]
  // Run 5.6 : la famille de rendu du concept — les 3 concepts d'un trio
  // couvrent 3 familles distinctes. `rendu` est DÉRIVÉ de la famille
  // (dimensionnelle → relief, sinon plat) pour la critique de production.
  famille: LogoFamilleRendu
  rendu: LogoRendu
  prompt: string
  // Run 5.7 : la RECETTE DE CALQUES exécutable — lettrage typographié
  // (police du catalogue embarqué, effets bornés par la distribution PSD),
  // emblème à générer seul, fond section 2bis. C'est elle que le pipeline
  // superposé exécute ; le prompt gabarit reste la référence créative.
  calques: LogoCalquesRecette
}

export type LogoDirectorResult = {
  concepts: LogoConcept[]
  usage: GeminiUsage
  durationMs: number
  // brief explicitement « sans relief » détecté → famille dimensionnelle exclue, loggé
  reliefLeve: boolean
}

const MIN_PROMPT_WORDS = 180
const MAX_PROMPT_WORDS = 520

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
     The emblem is FUSED with or crossing the lettering — never a separate mascot
     floating above or beside the words.
   - The intended negative space, NAMED.
   - COMPOSITION ECONOMY: lettering + ONE hero element maximum — the corpus averages
     complexity 3.9/10; never stack several decorative elements (wave + droplets +
     flourishes together). Every element not named here is forbidden in the render.
   - Silhouette test: the shape must stay recognizable as pure flat black.

2. STYLE DE RENDU — {ONE of the three measured render families, NAMED}
   - plat_premium (46% of corpus): full premium flat silhouette/lettering — "the color IS
     the shape" — and NEVER a sticker: CUSTOM-CUT letterforms (deliberate chamfers, sharp
     cuts, italic tension — no stock rounded cartoon font), satin fills LAYERED in 2-3 close
     tonal steps with subtle inner shading and light grain (never one plain gradient), thick
     clean {color} outline hugging EACH element's own silhouette (never one fat border around
     the whole lockup), emblem FUSED into the lettering (replacing or crossing a letter, never
     perched above), soft contour glow optional, zero realistic texture.
   - semi_flat_biseau (32%): semi-flat two-tone mark, MATTE bevels and sharp deliberate
     fractures/cuts, controlled contour glow (84% of this family carries it), light grain
     on flat fills.
   - dimensionnelle (22%): deep bevel/extrusion with SATIN/MATTE faces (soft velvet falloff),
     {chrome | gold | glass} reserved for thin edge accents (chamfer lines, kickers) with at
     most ONE edge specular per element — depth from shading and edge light, never a wet
     candy/gel coat over the faces; tight rim glow, dramatic studio lighting {key light direction}.
   - MATERIAL LAW (all families): fills are SATIN or MATTE with a whisper of grain on flats;
     gloss is an ACCENT — at most ONE controlled specular highlight per element, never a
     uniform candy-gloss/gel coat over whole letters (FORBIDDEN).
   - Render forbids, LISTED (no botanical/realistic detail, no dirty drop shadow,
     no uncontrolled zone-by-zone gradient, no floating micro-elements — droplets,
     splashes, crumbs — detached from the mark: they render as artifacts).

2bis. LE FOND (présentation naturelle) — NEVER EMPTY, this section is MANDATORY
   - Family of the backdrop layer, NAMED: thematic motif derived from the subject /
     contextual micro-scene (palm or city skyline silhouettes, foliage, distant figures) /
     graphic texture (halftone dots, topographic lines, thin arcs, grain, sparse particles) —
     or a corpus combination (41% combine texture + scene).
   - Its precise content: WHICH motifs, WHICH scene elements, WHICH texture — listed.
   - Opacity NUMBERS: every backdrop layer at 8-20% visibility over the base — cite the
     figure per layer (e.g. "palm silhouettes at 10%, halftone field at 15%").
   - Color nuance of the base: directional gradient {angle}, subtle vignette, soft glow
     halo echoing the mark's dominant color — never one flat tone.
   - The layer is DESATURATED and value-close to the base: the backdrop is sensed,
     never watched. It never competes with the mark — no sharp objects, no readable text.

3. COULEURS
   - EXACT brief hex codes: {#……} → {#……}, gradient direction {angle}°.
   - Small-format contrast rule: choose the version (colored shape on light ground OR light
     shape on colored ground) that stays most readable at 64 px — decide and say it.

4. FORMAT
   - Square composition, subject centered, occupying 60-70% of the width, regular margins.
   - Corpus presentation backdrop: the WORKED backdrop specified in section 2bis (step A
     presents the mark like the corpus — the flat cutout version is DERIVED from the
     validated master, and the fully custom background still comes at step B).
   - Legibility mentally checked at 64 px and at 512 px.
   - No other element: no text beyond the requested lettering, nothing not listed in 1/2bis.

5. MOTS-CLÉS TECHNIQUES — one final line of English keywords coherent with the chosen render
   family (dimensionnelle e.g.: "dimensional beveled emblem, controlled chrome, tight rim glow,
   dramatic studio lighting, esport server logo, crisp vector edges" ; plat_premium e.g.: "flat premium
   silhouette, bold negative space, thick outline, satin fills, soft contour glow, clean vector shape").`

const DIRECTOR_SYSTEM = `You are the senior brand designer of a premium FiveM/GTA RP studio. Your quality references: the ALYA badge (gradient background + thematic doodles), the Fruitz wordmark (custom lettering fused with a fruit slice), the fractured gold R monogram, the FLASH MOOD chrome wordmark. You design at that level — never at the level of generic esports crests, compasses, shields, or flat app icons.

You will receive: a logo brief, the MEASURED DNA of the reference corpus (real percentages), and exemplary recipes. Answer with THREE DISTINCT CONCEPTS — three different creative intentions, NOT three variations of one idea. Each concept explores a different construction language.

Each concept's "prompt" is the COMPLETE generation prompt an image model will execute, written EXACTLY in this master template anatomy (numbered sections 0-5, English):

${GABARIT_MAITRE}

HARD RULES — a concept violating any of these is REJECTED by a structural validator:
- Section 0 opens with the DNA block provided below (keep its numbers) and the family forbids. If the brief asks for lettering, state the exact word and its letter-by-letter spelling.
- Section 1 contains AT LEAST 3 numeric values (counts, %, angles) describing the construction.
- Section 2bis (LE FOND) is MANDATORY: the backdrop is NEVER empty — name its family (thematic motif / contextual micro-scene / graphic texture / combination), list its precise content, give an opacity FIGURE of 8-20% per layer, describe the base's color nuances (directional gradient, vignette, glow) and the layer's desaturation. A plain gradient with a light spot and nothing else is a REJECTED concept.
- Section 3 carries the brief's hex codes UNCHANGED, and states the 64 px contrast decision.
- Section 4 imposes the corpus presentation backdrop of section 2bis and the 60-70% width occupation — the flat cutout version is derived later from the validated master, and the fully custom background is still a separate later step.
- Section 5 is one final keyword line (>= 5 technical keywords) matching the chosen render family.
- Exactly 3 concepts covering THREE DISTINCT render families — one "famille" each among plat_premium / semi_flat_biseau / dimensionnelle (the measured corpus clusters provided below). If the brief explicitly forbids relief/3D, replace dimensionnelle by a second concept in one of the flat families (families still pairwise distinct where possible).
- MATERIAL LAW everywhere: satin/matte fills with light grain; gloss only as ONE controlled specular accent per element; uniform candy-gloss/gel coating is forbidden.
- If the brief has a SUBJECT/THEME, every concept is built around it — including the backdrop of section 2bis (motifs/scene derived from the subject). A compass/crest instead is a failure.
- The brief's forbidden list is repeated in section 2's forbids.
- The user's mood drives lighting and materials in section 2, and the backdrop's scene/motif choice in section 2bis.
- The mark is ONE FUSED PIECE: lettering and emblem are designed together (the emblem replaces, crosses or slices a letter). Never describe a separate emblem perched above plain text.
- LANGUAGE LAW (run 5.9): every "description" field in calques (lockup, embleme, fond) is written in ENGLISH — these strings are sent VERBATIM to the image model, which misreads French (a French "feuille de palmier" once rendered as a wheat ear). Only "nom", "justification" and "citations" stay French.
- STICKER LAW (run 5.9): NEVER ask for an outline, border or contour around the WHOLE lockup — outlines hug EACH letterform's own silhouette. NEVER ask for a uniform candy/gel/gloss coating. The validator rejects any description carrying these.
- SUBJECT LAW (run 5.9): when the brief has a subject, "calques.lockup.derive_de" and "calques.embleme.derive_de" each carry ONE VERBATIM WORD copied from the brief subject — the emblem derives strictly from it (checked in code; a wheat ear on a summer-fruit brief is structurally impossible).

RUN 5.8 — FUSED LOCKUP EXECUTION: when the brief asks for lettering, the mark is generated as ONE FUSED LOCKUP — emblem and custom lettering drawn together in a single image, like every reference of the corpus (letters sliced by the emblem, custom cuts, chrome, extrusions). Besides the master-template prompt, every concept ships an executable "calques" recipe:
- "calques.lockup" (MANDATORY when the brief asks for lettering): the fused lockup described as ONE piece, in concrete POSITIVE vocabulary — WHICH letter carries or is crossed by the emblem, WHERE the cuts pass, and above all the TYPOGRAPHIC TREATMENT: polished chrome bevels, deep matte extrusion, layered strokes, sharp angular cuts, letters sliced by the emblem — that register. 80+ chars, this description is what the image model executes. Optional "echelle" 0.5-0.8 (share of canvas width).
- "calques.lettrage" (when the brief asks for lettering): the FALLBACK recipe, still complete — the EXACT text, a "police" from the embedded font catalogue provided below (the real display fonts of the decomposed PSDs), fill ("couleur" hex OR "gradient" with 2-6 stops+locations), optional "contour"/"glow"/"ombre" whose pixel values MUST sit inside the measured PSD distribution provided below — values outside it are rejected by the validator. It renders server-side with the real font if the fused lockup fails its spelling gate.
- "calques.embleme": the pictorial emblem ALONE (subject-derived symbol, zero letters) — used by the fallback path and emblem-only briefs. "echelle" 0.3-0.75.
- "calques.fond": famille motif / scene / texture / combinaison + the precise content, consistent with section 2bis.
- "calques.disposition": "fusion" (emblem and lettering interlock — the corpus default), "pile" (emblem above, lettering below), "lettrage_seul", "embleme_seul".

Answer ONLY with JSON:
{"concepts": [{"nom": "short concept name (2-6 words, French)", "justification": "one French sentence — why this concept serves this server", "citations": ["2-4 French entries proving which brief answers this concept uses, each formatted «réponse utilisateur» → effet — e.g. «été» → soleil rayonnant en 16 rayons, «corail→pêche» → dégradé appliqué au biseau"], "famille": "plat_premium" | "semi_flat_biseau" | "dimensionnelle", "prompt": "the full section 0-5 master-template prompt (with 2bis) in English (${MIN_PROMPT_WORDS}-${MAX_PROMPT_WORDS} words)", "calques": {"disposition": "fusion" | "pile" | "lettrage_seul" | "embleme_seul", "lockup": {"description": "ENGLISH ONLY — the fused lockup as ONE piece: which letter carries the emblem, where the cuts pass, the typographic treatment (concrete positive vocabulary; never an outline around the whole lockup, never a uniform candy coat)", "echelle": 0.5-0.8, "derive_de": "one verbatim word copied from the brief subject that the emblem derives from"} | null, "lettrage": {"texte": "...", "police": "font family from the catalogue", "couleur": "#…" | null, "gradient": {"stops": [{"color": "#…", "location": 0..1}, …], "angle": 90} | null, "contour": {"taillePx": n, "couleur": "#…", "position": "outside"|"inside"} | null, "glow": {"taillePx": n, "couleur": "#…", "opacite": 0..1} | null, "ombre": {"taillePx": n, "distancePx": n, "opacite": 0..1} | null, "tracking": n | null}, "embleme": {"description": "the emblem alone, English, no letters", "echelle": 0.3-0.75, "derive_de": "one verbatim word copied from the brief subject"} | null, "fond": {"famille": "motif"|"scene"|"texture"|"combinaison", "description": "precise backdrop content, English"}}}, …exactly 3…]}`

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

// Brief explicitement « sans relief » → la famille dimensionnelle est exclue
// du trio (loggé). Run 5.6 : l'ancienne règle « 2 relief » n'existe plus.
export function flatOverrideRequested(answers: LogoAnswersV3): boolean {
  return /\b(pas|sans|no|zero|zéro)\s+(de\s+|d')?(relief|3\s?d|biseau|volume|extrusion)/i.test(answers.interdits)
}

// ── LE VALIDATEUR STRUCTUREL (LOT 2) — rien ne part à l'étage 2 sans lui ─────
export function validateGabaritConcepts(raw: unknown, opts: {
  answers: LogoAnswersV3
  projectName: string
  mappingPalette: string[]
  flatAutorise: boolean
  // calibration 5.6 : famille de fond imposée — le validateur exige la preuve
  fondImpose?: 'motif' | 'scene' | 'texture'
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
    // Run 5.6 : la famille de rendu est obligatoire ; `rendu` en est DÉRIVÉ
    // (dimensionnelle → relief pour la critique de production, sinon plat).
    const famille = (LOGO_FAMILLES_RENDU as readonly string[]).includes(String(c.famille))
      ? (c.famille as LogoFamilleRendu)
      : null
    if (!famille) {
      errors.push(`${label}: "famille" must be one of ${LOGO_FAMILLES_RENDU.join(' / ')}`)
      return
    }
    // Brief « sans relief » explicite : la famille dimensionnelle est exclue.
    if (opts.flatAutorise && famille === 'dimensionnelle') {
      errors.push(`${label}: the brief explicitly forbids relief — famille dimensionnelle not allowed`)
    }
    const rendu: LogoRendu = famille === 'dimensionnelle' ? 'relief' : 'plat'
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
    // 6. section 2bis (run 5.6) : LE FOND — jamais vide, opacités chiffrées
    const s2bisStart = prompt.search(/(^|\n)\s*2\s?bis\./i)
    const s2bis = s2bisStart < 0
      ? ''
      : (() => {
          const rest = prompt.slice(s2bisStart)
          const next = rest.slice(1).search(/(^|\n)\s*3\./)
          return next < 0 ? rest : rest.slice(0, next + 1)
        })()
    if (!s2bis) {
      errors.push(`${label}: section 2bis. (LE FOND) missing — the backdrop specification is mandatory`)
    } else {
      // Opacités chiffrées : l'écho verbatim de la consigne « 8-20% » ne
      // compte pas — on le retire AVANT d'extraire les pourcentages, puis on
      // exige au moins une opacité DE COUCHE dans la fourchette 5-25.
      const sansEcho = s2bis.replace(/8\s?[-–—]\s?20\s?%/g, '')
      const pcts = [...sansEcho.matchAll(/(\d{1,2})\s?%/g)].map((m) => Number(m[1]))
      if (!pcts.some((v) => v >= 5 && v <= 25)) {
        errors.push(`${label}: section 2bis must cite each backdrop layer's opacity as its own figure in the 8-20% range (echoing "8-20%" is not a per-layer figure)`)
      }
      if (!/motif|scene|scène|texture|halftone|topo|skyline|palm|silhouette|foliage|doodle/i.test(s2bis)) {
        errors.push(`${label}: section 2bis must name the backdrop family and its content (motif / micro-scene / graphic texture)`)
      }
      // Fond vide interdit — en neutralisant d'abord les NÉGATIONS légitimes
      // (« NEVER EMPTY » du header 2bis, « no readable text » de la discipline).
      const sansNegations = s2bis
        .replace(/never\s+empty/gi, '')
        .replace(/no\s+readable\s+text/gi, '')
      if (/\b(empty|plain background|no scenery, no objects|no patterns|pure atmosphere)\b/i.test(sansNegations)) {
        errors.push(`${label}: section 2bis describes an EMPTY backdrop — forbidden (run 5.6: the fond is part of the logo)`)
      }
      // Variable d'expérience : quand la calibration impose une famille de
      // fond, la section 2bis doit prouver qu'elle l'utilise — sinon la
      // cellule d'expérience mesurerait une autre famille en silence.
      if (opts.fondImpose) {
        const preuves: Record<'motif' | 'scene' | 'texture', RegExp> = {
          motif: /motif|doodle|pattern|repeated/i,
          scene: /scene|scène|skyline|palm|silhouette|foliage|figure|building|city/i,
          texture: /halftone|topo|grain|arc|particle|streak|texture/i,
        }
        if (!preuves[opts.fondImpose].test(s2bis)) {
          errors.push(`${label}: section 2bis must use the IMPOSED backdrop family "${opts.fondImpose}" (calibration constraint) — no evidence found`)
        }
      }
    }
    // 7. section 4 : présentation corpus + occupation chiffrée
    const s4 = sectionSlice(prompt, 4)
    if (!/backdrop|2bis/i.test(s4)) errors.push(`${label}: section 4 must impose the section 2bis worked backdrop`)
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
    // 9. traçabilité (LOT 5) : le concept cite les réponses du brief utilisées
    const citations = (Array.isArray(c.citations) ? c.citations : [])
      .map((x) => String(x).slice(0, 200))
      .filter(Boolean)
      .slice(0, 4)
    if (!citations.length) {
      errors.push(`${label}: citations missing — each concept must cite the brief answers it uses («réponse» → effet)`)
    }

    // 10. Run 5.7 : la recette de calques exécutable — police du catalogue,
    // effets DANS la distribution PSD, texte exact. Sans elle, pas de concept.
    const attenduTexte =
      answers.type === 'nom'
        ? opts.projectName.trim().toUpperCase()
        : answers.type === 'lettre'
          ? (opts.projectName.trim()[0] ?? 'N').toUpperCase()
          : null
    const calquesVerdict = validateCalquesRecette((c as { calques?: unknown }).calques, { attenduTexte, sujet: answers.sujet })
    if ('errors' in calquesVerdict) {
      errors.push(...calquesVerdict.errors.map((e) => `${label}: ${e}`))
      return
    }
    if (attenduTexte === null && calquesVerdict.recette.disposition !== 'embleme_seul') {
      errors.push(`${label}: brief is embleme-only — calques.disposition must be "embleme_seul"`)
      return
    }

    concepts.push({
      nom: String(c.nom).slice(0, 80),
      justification: String(c.justification).slice(0, 240),
      citations,
      famille,
      rendu,
      prompt,
      calques: calquesVerdict.recette,
    })
  })

  // 10. Run 5.6 — DIVERSITÉ : la règle « >= 2 relief » du 5.4 est ABROGÉE
  // (faux optimum candy gloss du 5.5). À la place : les 3 concepts couvrent
  // 3 familles de rendu DISTINCTES (2 distinctes minimum quand le brief
  // interdit le relief et prive le trio de la famille dimensionnelle).
  if (concepts.length === 3) {
    const distinct = new Set(concepts.map((c) => c.famille)).size
    const requis = opts.flatAutorise ? 2 : 3
    if (distinct < requis) {
      errors.push(`only ${distinct} distinct render familles across the 3 concepts — ${requis} required (measured clusters: plat_premium 46%, semi_flat_biseau 32%, dimensionnelle 22%)`)
    }
  }

  return errors.length ? { errors } : { concepts }
}

export async function directLogoConcepts(opts: {
  project: ProjectLike
  da: ArtDirection
  answers: LogoAnswersV3
  energie?: number
  modernite?: number
  // Run 5.6 (calibration) : famille de FOND imposée à la section 2bis des
  // 3 concepts — une variable d'expérience, jamais utilisée en production.
  fondImpose?: 'motif' | 'scene' | 'texture'
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
  // Run 5.5 (wizard v4) : l'AMBIANCE du logo pilote la sélection — son tag
  // rejoint les clusterTags du projet dans le score des exemplaires.
  const daLogo = answers.ambiance
    ? { ...da, clusterTags: [...new Set([...da.clusterTags, LOGO_AMBIANCE_TAG[answers.ambiance]])] }
    : da
  const exemplars = pickExemplars({ category: 'logo', da: daLogo, energie: opts.energie, modernite: opts.modernite, maxPrompts: 5, maxReferences: 0 })
  const notes = pickExemplarNotes({ category: 'logo', da: daLogo, energie: opts.energie, modernite: opts.modernite, max: 4 })

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
  // Run 5.6 : les fonds mesurés (LOT 1) et les familles de rendu voyagent
  // dans CHAQUE appel DA — la section 2bis et la diversité s'appuient dessus.
  const fondsBlock = fondsBlockLogo()
  const familles = famillesRenduLogo()

  // Run 5.7 : le catalogue de polices embarquées et la distribution d'effets
  // PSD voyagent dans CHAQUE appel — la recette calques se choisit dedans.
  const fonts = loadFonts()
  const bornes = psdBornes()
  const catalogueBlock = [
    `EMBEDDED FONT CATALOGUE (pick calques.lettrage.police EXACTLY from this list — these are the real display fonts of the decomposed professional PSDs or their mapped equivalents):`,
    ...fonts.map((f) => `- "${f.css_family}"${f.statut === 'equivalente' ? ` (equivalent of ${f.psd_font})` : ''}`),
  ].join('\n')
  const bornesBlock =
    `MEASURED PSD EFFECT DISTRIBUTION (13 professional PSDs — every calques effect value MUST sit inside these ranges, the validator rejects anything outside; scale reference: lettering ~100px tall):\n` +
    `- contour (stroke): ${bornes.stroke.min}-${bornes.stroke.max}px, median ${bornes.stroke.median}px — colors are LIGHT (white/pale accents), the thick black 2015 triple outline does NOT exist in the professional corpus\n` +
    `- outer glow: 0-${bornes.outerGlow.max}px, median ${bornes.outerGlow.median}px\n` +
    `- drop shadow: size ${bornes.dropShadowSize.min}-${bornes.dropShadowSize.max}px (median ${bornes.dropShadowSize.median}), distance ${bornes.dropShadowDistance.min}-${bornes.dropShadowDistance.max}px, opacity ~0.5\n` +
    `- bevel: median ${bornes.bevel.median}px (max ${bornes.bevel.max}) — bevel is RARE in the corpus`

  const fondImposeLine = opts.fondImpose
    ? `CALIBRATION CONSTRAINT — BACKDROP FAMILY IMPOSED: section 2bis of EVERY concept uses the ${
        opts.fondImpose === 'motif'
          ? 'thematic motif family (repeated subtle motifs derived from the subject)'
          : opts.fondImpose === 'scene'
            ? 'contextual micro-scene family (palm/city skyline silhouettes, foliage, distant figures)'
            : 'graphic texture family (halftone, topographic lines, arcs, grain, particles)'
      } — still at 8-20% visibility, desaturated.`
    : ''

  const prompt = [
    'LOGO BRIEF (from the client wizard — verbatim user words included):',
    brief,
    `CATEGORY DNA — measured on the full training corpus, this is the section 0 base of every concept:\n${adn}`,
    fondsBlock,
    `RENDER FAMILIES — measured corpus clusters, one concept per family:\n${familles.resume_en}`,
    catalogueBlock,
    bornesBlock,
    fondImposeLine,
    flatAutorise
      ? 'RELIEF FORBIDDEN BY BRIEF: the user explicitly forbids relief/3D — no dimensionnelle concept; cover the two flat families instead.'
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
      // Run 5.5 : 6000 tronquait le JSON ~1 fois sur 3 (le thinking high
      // mange une part du budget de sortie) → « exactly 3 concepts required ».
      // Run 5.9 : 9000 tronquait à nouveau (gabarit enrichi : lois de langue/
      // sticker/sujet + champs derive_de) → 14000.
      maxOutputTokens: 14000,
      thinkingLevel: LOGO_THINKING_LEVEL,
      onUsage: track,
    })

    const verdict = validateGabaritConcepts(raw, {
      answers,
      projectName: project.name,
      mappingPalette: da.palette,
      flatAutorise,
      fondImpose: opts.fondImpose,
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
