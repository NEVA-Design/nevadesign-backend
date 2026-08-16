import { geminiJson, type GeminiUsage } from '../ai/gemini'
import { ENGINE_MODELS, LOGO_THINKING_LEVEL } from './generation'
import { pickExemplarNotes } from './exemplars'
import { renderLogoBrief, LOGO_AMBIANCE_TAG, type LogoAnswersV3 } from './logo-brief'
import { adnBlockLogo, fondsBlockLogo, famillesRenduLogo } from './adn'
import { logGeneration } from './guards'
import { UNIVERSE_LABELS, type ArtDirection } from './mapping'
import { validateCalquesRecette, detecteFrancais, demandeInterdite, spellOut, type LogoCalquesRecette } from './logo-stack'
import { loadFonts, psdBornes } from './lettrage'
import type { ProjectLike } from './compiler'

// ── Étage 1 : le directeur artistique logo (run 5.3 → 5.10) ──────────────────
// Run 5.10 — PIVOT RENDU INTÉGRAL, prouvé par le test plafond du 5.9
// (_plafond-run59/) : le transfert minimal (3 phrases + références HQ
// étiquetées) a produit les deux meilleurs FRUITZ du projet, largement
// au-dessus de tout ce que le pipeline en couches a jamais sorti, pendant que
// le prompt pipeline avec les MÊMES références donnait un rendu propre mais
// stérile. Conclusion opérateur : moins de prompt = plus de qualité quand les
// références portent le style. Le DA produit donc désormais, par concept, UN
// PROMPT MINIMAL (30-120 mots, plafond DUR au validateur) calqué sur le
// format gagnant du plafond — le gabarit maître en sections 0-5 ne pilote
// plus la génération (il survit ci-dessous comme DOCUMENTATION de la
// doctrine mesurée). La recette calques reste produite : c'est le plan de
// secours orthographe et la machinerie de l'étape B.

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
  // Run 5.10 : LE PROMPT MINIMAL INTÉGRAL (30-120 mots, anglais) — le prompt
  // de génération complet, exécuté tel quel avec les références étiquetées.
  prompt: string
  // Run 5.7 : la RECETTE DE CALQUES exécutable — conservée comme PLAN DE
  // SECOURS orthographe (lettrage typographié local) et pour l'étape B.
  calques: LogoCalquesRecette
}

export type LogoDirectorResult = {
  concepts: LogoConcept[]
  usage: GeminiUsage
  durationMs: number
  // brief explicitement « sans relief » détecté → famille dimensionnelle exclue, loggé
  reliefLeve: boolean
}

// Run 5.10 : bornes du prompt minimal — le plafond de 120 mots est DUR, le
// validateur rejette au-delà (preuve plafond : la densité du format gagnant).
export const MIN_PROMPT_INTEGRAL_MOTS = 30
export const MAX_PROMPT_INTEGRAL_MOTS = 120

// ── LE GABARIT MAÎTRE — DOCUMENTATION SEULEMENT depuis le run 5.10 ───────────
// C'était le format de sortie obligatoire du DA (runs 5.4 → 5.9). Le test
// plafond a prouvé que cette anatomie en sections dilue la qualité que les
// références portent déjà : il ne pilote PLUS la génération. Il reste exporté
// comme mémoire de la doctrine mesurée (ADN chiffré, familles de rendu,
// section 2bis du fond, material law) — les lois qu'il énonce survivent en
// code dans le validateur (demandeInterdite, detecteFrancais, derive_de) et
// dans les détecteurs éliminatoires du critic/jury.
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

You will receive: a logo brief, the MEASURED DNA of the reference corpus, and notes describing the reference images that will be attached to the generation call. Answer with THREE DISTINCT CONCEPTS — three different creative intentions, NOT three variations of one idea — one per render family.

INTEGRAL RENDER (run 5.10, proven by a controlled ceiling test): the image model produces its best work from a SHORT prompt plus 3-4 high-quality LABELED reference images. One image call renders the COMPLETE logo — custom lettering, fused emblem, materials, lighting and worked dark background composed TOGETHER in one image. Each concept's "prompt" is that single MINIMAL prompt, executed verbatim.

THE MINIMAL PROMPT — 5-6 sentences, ${MIN_PROMPT_INTEGRAL_MOTS}-${MAX_PROMPT_INTEGRAL_MOTS} words TOTAL. The validator REJECTS any prompt above ${MAX_PROMPT_INTEGRAL_MOTS} words: the ceiling test proved that less prompt means more quality when the references carry the style. In order:
1. The opening, modeled on the winning transfer: Design a premium logo for a FiveM/GTA RP server named "{NAME}", spelled {N-A-M-E}, at the same production quality as the attached reference logos.
2. The emblem idea AND its fusion into the lettering — which letter it replaces, crosses or slices (one sentence).
3. The typographic treatment (one sentence, concrete positive vocabulary: deep matte extrusion, polished chrome edge bevels, satin layered fills, sharp angular cuts…).
4. The palette with the EXACT brief hex codes.
5. The backdrop mood in ONE sentence — a deep dark atmospheric background, subject-derived motifs or texture sensed at low opacity, never competing with the mark.
6. The critical negatives line, closing with the exact-reading lock: The word must read exactly "{NAME}" with perfectly formed letters — no other words, no outline around the whole lockup, no uniform candy gloss, no watermark.

WORKED EXAMPLE — the ceiling-test winner (52 words; match this density):
Design a premium logo for a FiveM/GTA RP server named "FRUITZ", spelled F-R-U-I-T-Z, at the same production quality as the attached reference logos. Custom display lettering fused with a citrus slice emblem, chrome or satin materials, on a dark atmospheric background. The word must read exactly "FRUITZ" with perfectly formed letters.
Your prompts add the palette hexes, the precise emblem fusion and the negatives line — and stay under ${MAX_PROMPT_INTEGRAL_MOTS} words.

HARD RULES — a concept violating any of these is REJECTED by a structural validator:
- The prompt is written ENTIRELY in English — it is sent verbatim to the image model, which misreads French (a French "feuille de palmier" once rendered as a wheat ear).
- If the brief asks for lettering: the exact word "{NAME}" AND its letter-by-letter spelling {N-A-M-E} appear in the prompt, plus the closing lock "must read exactly". An emblem-only brief states "no text, no lettering" instead.
- The brief's hex codes appear UNCHANGED in the prompt.
- ONE sentence describes the deep dark worked backdrop (the word "background" or "backdrop" must appear).
- The negatives line carries at least two "no …" clauses.
- STICKER LAW: NEVER ask for an outline, border or contour around the WHOLE lockup — outlines hug EACH letterform's own silhouette. NEVER ask for a uniform candy/gel/gloss coating — fills are satin/matte with at most ONE controlled specular accent per element. The validator rejects any prompt or description carrying these.
- If the brief has a SUBJECT/THEME, every concept is built around it — the emblem AND the backdrop motifs derive from it. A compass/crest instead is a failure.
- Exactly 3 concepts covering THREE DISTINCT render families — one "famille" each among plat_premium / semi_flat_biseau / dimensionnelle (the measured corpus clusters provided below). If the brief explicitly forbids relief/3D, replace dimensionnelle by a second concept in one of the flat families.
- Each concept cites the brief answers it uses (citations).

CALQUES RECIPE — unchanged contract, now the SPELLING FALLBACK and the step-B machinery (never the default path): besides the minimal prompt, every concept ships an executable "calques" recipe:
- "calques.lockup" (MANDATORY when the brief asks for lettering): the fused lockup described as ONE piece, in concrete POSITIVE ENGLISH vocabulary — WHICH letter carries or is crossed by the emblem, WHERE the cuts pass, the TYPOGRAPHIC TREATMENT (polished chrome bevels, deep matte extrusion, layered strokes, sharp angular cuts, letters sliced by the emblem). 80+ chars. Optional "echelle" 0.5-0.8.
- "calques.lettrage" (when the brief asks for lettering): the FALLBACK recipe, complete — the EXACT text, a "police" from the embedded font catalogue provided below, fill ("couleur" hex OR "gradient" with 2-6 stops+locations), optional "contour"/"glow"/"ombre" whose pixel values MUST sit inside the measured PSD distribution provided below. It renders server-side with the real font if the integral render fails its spelling gate.
- "calques.embleme": the pictorial emblem ALONE (subject-derived symbol, zero letters) — used by the fallback path and emblem-only briefs. "echelle" 0.3-0.75.
- "calques.fond": famille motif / scene / texture / combinaison + the precise content in English.
- "calques.disposition": "fusion" (the corpus default), "pile", "lettrage_seul", "embleme_seul".
- LANGUAGE LAW: every "description" field in calques is written in ENGLISH — these strings are sent VERBATIM to the image model. Only "nom", "justification" and "citations" stay French.
- SUBJECT LAW: when the brief has a subject, "calques.lockup.derive_de" and "calques.embleme.derive_de" each carry ONE VERBATIM WORD copied from the brief subject — the emblem derives strictly from it (checked in code).

Answer ONLY with JSON:
{"concepts": [{"nom": "short concept name (2-6 words, French)", "justification": "one French sentence — why this concept serves this server", "citations": ["2-4 French entries proving which brief answers this concept uses, each formatted «réponse utilisateur» → effet"], "famille": "plat_premium" | "semi_flat_biseau" | "dimensionnelle", "prompt": "the MINIMAL INTEGRAL prompt (${MIN_PROMPT_INTEGRAL_MOTS}-${MAX_PROMPT_INTEGRAL_MOTS} words, English, the 6-sentence format above)", "calques": {"disposition": "fusion" | "pile" | "lettrage_seul" | "embleme_seul", "lockup": {"description": "ENGLISH ONLY — the fused lockup as ONE piece", "echelle": 0.5-0.8, "derive_de": "one verbatim word copied from the brief subject"} | null, "lettrage": {"texte": "...", "police": "font family from the catalogue", "couleur": "#…" | null, "gradient": {"stops": [{"color": "#…", "location": 0..1}, …], "angle": 90} | null, "contour": {"taillePx": n, "couleur": "#…", "position": "outside"|"inside"} | null, "glow": {"taillePx": n, "couleur": "#…", "opacite": 0..1} | null, "ombre": {"taillePx": n, "distancePx": n, "opacite": 0..1} | null, "tracking": n | null}, "embleme": {"description": "the emblem alone, English, no letters", "echelle": 0.3-0.75, "derive_de": "one verbatim word copied from the brief subject"} | null, "fond": {"famille": "motif"|"scene"|"texture"|"combinaison", "description": "precise backdrop content, English"}}}, …exactly 3…]}`

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

// Hex exacts attendus dans le prompt — ceux du brief, tels quels.
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

// ── LE VALIDATEUR DU PROMPT MINIMAL (run 5.10) — rien ne part sans lui ───────
// Chaque message d'erreur CITE ce qui manque ou ce qui déborde et dit la
// reformulation attendue — à la 2e tentative le DA reçoit ces erreurs, un
// message actionnable évite qu'il répète la même faute (piège vécu au 5.9).
export function validateConceptsIntegraux(raw: unknown, opts: {
  answers: LogoAnswersV3
  projectName: string
  mappingPalette: string[]
  flatAutorise: boolean
  // calibration : famille de fond imposée — vérifiée sur la recette calques
  fondImpose?: 'motif' | 'scene' | 'texture'
}): { concepts: LogoConcept[] } | { errors: string[] } {
  const parsed = raw as { concepts?: unknown } | null
  const list = Array.isArray(parsed?.concepts) ? parsed.concepts : null
  if (!list || list.length !== 3) return { errors: ['exactly 3 concepts required'] }

  const { answers } = opts
  const hexes = briefHexes(answers, opts.mappingPalette)
  const sujetMots = answers.sujet
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[,\s]+/)
    .filter((m) => m.length >= 3)
  const errors: string[] = []
  const concepts: LogoConcept[] = []

  list.forEach((item, i) => {
    const c = item as Partial<LogoConcept>
    const label = `concept ${i + 1}`
    if (!c?.nom || !c.justification || !c.prompt) {
      errors.push(`${label}: missing nom/justification/prompt`)
      return
    }
    const famille = (LOGO_FAMILLES_RENDU as readonly string[]).includes(String(c.famille))
      ? (c.famille as LogoFamilleRendu)
      : null
    if (!famille) {
      errors.push(`${label}: "famille" must be one of ${LOGO_FAMILLES_RENDU.join(' / ')}`)
      return
    }
    if (opts.flatAutorise && famille === 'dimensionnelle') {
      errors.push(`${label}: the brief explicitly forbids relief — famille dimensionnelle not allowed`)
    }
    const rendu: LogoRendu = famille === 'dimensionnelle' ? 'relief' : 'plat'
    const prompt = String(c.prompt)
    const promptLower = prompt.toLowerCase()

    // 1. le plafond DUR de mots — la preuve du test plafond fait loi
    const words = wordCount(prompt)
    if (words > MAX_PROMPT_INTEGRAL_MOTS) {
      errors.push(`${label}: prompt is ${words} words — the HARD ceiling is ${MAX_PROMPT_INTEGRAL_MOTS} (ceiling test: less prompt = more quality when the references carry the style). Cut it to the 6-sentence minimal format`)
    } else if (words < MIN_PROMPT_INTEGRAL_MOTS) {
      errors.push(`${label}: prompt is only ${words} words (minimum ${MIN_PROMPT_INTEGRAL_MOTS}) — the 6-sentence format needs the emblem fusion, treatment, hexes, backdrop and negatives`)
    }
    // 2. anglais uniquement — le prompt part verbatim au modèle image
    if (detecteFrancais(prompt)) {
      errors.push(`${label}: prompt must be written ENTIRELY in English (French words/accents detected) — it is sent verbatim to the image model`)
    }
    // 3. interdits sticker/candy — mêmes regex que les recettes (négations neutralisées)
    const interdit = demandeInterdite(prompt)
    if (interdit) errors.push(`${label}: prompt ${interdit}`)
    // 4. le mot exact + l'épellation + le verrou de lecture
    if (answers.type === 'nom') {
      const motAttendu = opts.projectName.trim().toUpperCase()
      if (!prompt.toUpperCase().includes(motAttendu)) {
        errors.push(`${label}: the exact word "${motAttendu}" is absent from the prompt`)
      }
      if (!prompt.toUpperCase().includes(spellOut(motAttendu))) {
        errors.push(`${label}: the letter-by-letter spelling "${spellOut(motAttendu)}" is absent — the opening sentence must carry « spelled ${spellOut(motAttendu)} »`)
      }
      if (!/reads?\s+exactly/i.test(prompt)) {
        errors.push(`${label}: the exact-reading lock is absent — close with « The word must read exactly "${motAttendu}" with perfectly formed letters »`)
      }
    } else if (answers.type === 'lettre') {
      const lettre = (opts.projectName.trim()[0] ?? 'N').toUpperCase()
      if (!prompt.toUpperCase().includes(`"${lettre}"`)) {
        errors.push(`${label}: the monogram letter "${lettre}" (quoted) is absent from the prompt`)
      }
    } else if (!/no\s+(text|lettering|words)/i.test(prompt)) {
      errors.push(`${label}: emblem-only brief — the prompt must state "no text, no lettering"`)
    }
    // 5. les hex du brief tels quels
    for (const hex of hexes) {
      if (!prompt.toUpperCase().includes(hex.toUpperCase())) {
        errors.push(`${label}: the exact hex ${hex} is absent from the prompt`)
      }
    }
    // 6. la phrase de fond
    if (!/background|backdrop/i.test(prompt)) {
      errors.push(`${label}: the backdrop sentence is absent — one sentence must describe the deep dark worked background`)
    }
    // 7. la ligne de négatifs critiques (>= 2 clauses « no … »)
    const negatifs = prompt.match(/\bno\s+[a-z]/gi) ?? []
    if (negatifs.length < 2) {
      errors.push(`${label}: the critical negatives line is missing or too thin (${negatifs.length} "no …" clause) — e.g. « no other words, no outline around the whole lockup, no uniform candy gloss, no watermark »`)
    }
    // 8. thème présent quand le brief en donne un
    if (sujetMots.length && !/theme|subject/i.test(prompt) && !sujetMots.some((m) => promptLower.includes(m))) {
      errors.push(`${label}: the user subject "${answers.sujet}" is absent from the prompt — the emblem and backdrop derive from it`)
    }
    // 9. traçabilité : le concept cite les réponses du brief utilisées
    const citations = (Array.isArray(c.citations) ? c.citations : [])
      .map((x) => String(x).slice(0, 200))
      .filter(Boolean)
      .slice(0, 4)
    if (!citations.length) {
      errors.push(`${label}: citations missing — each concept must cite the brief answers it uses («réponse» → effet)`)
    }

    // 10. la recette calques (fallback orthographe + étape B) — inchangée
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
    // 11. calibration : famille de fond imposée — vérifiée sur la recette
    if (opts.fondImpose && calquesVerdict.recette.fond.famille !== opts.fondImpose && calquesVerdict.recette.fond.famille !== 'combinaison') {
      errors.push(`${label}: calques.fond.famille is "${calquesVerdict.recette.fond.famille}" but the calibration imposes "${opts.fondImpose}"`)
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

  // 12. DIVERSITÉ (run 5.6) : 3 familles de rendu distinctes (2 minimum quand
  // le brief interdit le relief et prive le trio de la famille dimensionnelle).
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
  // Run 5.6 (calibration) : famille de FOND imposée — une variable
  // d'expérience, jamais utilisée en production.
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

  // Run 5.10 : les reverse-prompts gabarit ne nourrissent PLUS le DA (leur
  // densité tirait vers les prompts longs que le plafond a disqualifiés). Le
  // style voyage désormais par les références étiquetées jointes à la
  // génération — le DA reçoit leurs NOTES pour savoir à quoi elles ressemblent.
  const daLogo = answers.ambiance
    ? { ...da, clusterTags: [...new Set([...da.clusterTags, LOGO_AMBIANCE_TAG[answers.ambiance]])] }
    : da
  const notes = pickExemplarNotes({ category: 'logo', da: daLogo, energie: opts.energie, modernite: opts.modernite, max: 4 })

  // Le brief « sans relief » explicite exclut la famille dimensionnelle — loggé.
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
  const fondsBlock = fondsBlockLogo()
  const familles = famillesRenduLogo()

  // Run 5.7 : le catalogue de polices embarquées et la distribution d'effets
  // PSD voyagent dans CHAQUE appel — la recette calques (fallback) se choisit dedans.
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
    ? `CALIBRATION CONSTRAINT — BACKDROP FAMILY IMPOSED: the backdrop sentence of EVERY prompt and calques.fond use the ${
        opts.fondImpose === 'motif'
          ? 'thematic motif family (repeated subtle motifs derived from the subject)'
          : opts.fondImpose === 'scene'
            ? 'contextual micro-scene family (palm/city skyline silhouettes, foliage, distant figures)'
            : 'graphic texture family (halftone, topographic lines, arcs, grain, particles)'
      } — sensed at low opacity, desaturated.`
    : ''

  const prompt = [
    'LOGO BRIEF (from the client wizard — verbatim user words included):',
    brief,
    `CATEGORY DNA — measured on the full training corpus (context for your creative choices, NOT text to copy into the minimal prompts):\n${adn}`,
    fondsBlock,
    `RENDER FAMILIES — measured corpus clusters, one concept per family:\n${familles.resume_en}`,
    catalogueBlock,
    bornesBlock,
    fondImposeLine,
    flatAutorise
      ? 'RELIEF FORBIDDEN BY BRIEF: the user explicitly forbids relief/3D — no dimensionnelle concept; cover the two flat families instead.'
      : '',
    notes.length
      ? `CLUSTER REFERENCE NOTES (labeled reference images like these will be attached to the generation call — they carry the style, your prompt stays minimal): \n${notes.map((n) => `- ${n}`).join('\n')}`
      : '',
    'Now think, then deliver the 3 distinct minimal-prompt concepts as specified.',
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
      // mange une part du budget de sortie). Run 5.9 : 9000 tronquait à
      // nouveau → 14000. Les prompts 5.10 sont courts mais les recettes
      // calques et le thinking restent — on ne redescend pas.
      maxOutputTokens: 14000,
      thinkingLevel: LOGO_THINKING_LEVEL,
      onUsage: track,
    })

    const verdict = validateConceptsIntegraux(raw, {
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
  throw new Error(`Le directeur artistique n'a pas produit 3 concepts au format minimal intégral (${lastErrors.slice(0, 6).join('; ')}) — relance la génération.`)
}
