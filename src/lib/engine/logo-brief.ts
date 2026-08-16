import { sanitizeText } from '../security'

// ── Le brief logo (run 5.3 → 5.5) ────────────────────────────────────────────
// Le wizard pose les bonnes questions : sujet/thème, forme, ambiance,
// couleurs libres (picker + dégradé), interdits — le brief exact transmis au
// directeur artistique (étage 1) et affiché tel quel dans le récap wizard.
// Run 5.4, LOT 4 : la question « fond » DISPARAÎT de l'étape logo.
// Run 5.5 (calibration) : l'étape A rend le logo dans sa PRÉSENTATION CORPUS
// (fond sombre atmosphérique + glow — mesuré : 78 % de fonds sombres). La
// version alpha détourée est DÉRIVÉE du master validé (seconde passe
// /logo/master sur #F2F2F2), et le fond entièrement personnalisé reste
// l'étape B (écran dédié, généré séparément, composé par calques). Le champ
// `fond` ne survit que pour lire les wizard_answers d'avant le run 5.4.

export type LogoType = 'lettre' | 'nom' | 'embleme'

// ── WIZARD v4 (run 5.5) — questions CONÇUES DEPUIS LES AXES MESURÉS ─────────
// Tableau de preuve question → axe du corpus (59 logos, manifest v4) → effet :
//
// | Question     | Axe mesuré                                              | Effet dans le pipeline                     |
// |--------------|---------------------------------------------------------|--------------------------------------------|
// | La forme     | monogram 49 % · wordmark 34 % · emblème pur 17 %        | type → épellation OCR + section 1 gabarit  |
// | Le sujet     | 59 % des marques FUSIONNENT un emblème thématique       | section 1 + règle de fusion (H10)          |
// | La matière   | neon 27 % · metal+chrome 18 % · glass 8 % · or #FFD700  | section 2 matières (LOGO_MATIERE_DA)       |
// |              |   3e couleur dominante du corpus                        |   — l'axe le plus clivant, jamais piloté   |
// | L'ambiance   | tags : urbain 53 % · luxe 42 % · sombre 37 % · esport   | section 2 éclairage + tags de sélection    |
// |              |   27 % · retro 27 % · ete 25 %                          |   few-shot (scoreEntry)                    |
// | Les couleurs | palette dominante ADN : #FFFFFF #000000 #FFD700 …       | section 3 hex EXACTS + validateur          |
// | À éviter     | pilote flatOverride (règle 2-relief levée) + forbids    | validateur + règle de famille              |
//
// Supprimés du wizard (ne pilotaient rien de distinct) : ambiance « néon »
// (c'est une MATIÈRE — 27 % du corpus, déplacée dans sa vraie question) et
// « propre » (aucun tag corpus, redondant avec l'interdit « sans relief »).
// Ajoutés : « urbain » (53 % — le tag DOMINANT du corpus, absent du wizard
// v3 !) et « esport » (27 %). La question « fond » reste à l'étape B.
// Les valeurs legacy neon/propre restent PARSÉES (assets d'avant run 5.5).

export type LogoAmbiance = 'ete' | 'sombre' | 'luxe' | 'urbain' | 'esport' | 'retro' | 'neon' | 'propre'

// La matière dominante — l'axe le plus différenciant du corpus, désormais
// une question à part entière (le wizard v3 la noyait dans l'ambiance).
export type LogoMatiere = 'neon' | 'chrome' | 'or' | 'verre' | 'studio'

export type LogoCouleurs =
  // palette dérivée du mapping projet — le comportement v2, conservé en défaut
  | { mode: 'palette' }
  // une couleur exacte choisie au picker (roue + hex)
  | { mode: 'unie'; couleur: string }
  // dégradé construit par l'utilisateur : 2-3 hex + angle, transmis tel quel
  | { mode: 'degrade'; couleurs: string[]; angle: number }

export type LogoFond = 'transparent' | 'plein' | 'degrade_motifs'

export type LogoAnswersV3 = {
  version: 3
  type: LogoType
  // 3-8 mots — le cœur du concept (« fruit, été, juteux », « dauphin, océan »).
  // Chaîne vide = « juste le lettrage » : aucun thème imposé.
  sujet: string
  ambiance: LogoAmbiance | null
  // v4 (run 5.5) : la matière dominante — 'studio' = le studio choisit
  // (fallback sur les matières de l'ambiance, comportement v3)
  matiere: LogoMatiere
  couleurs: LogoCouleurs
  // LEGACY (assets d'avant le run 5.4) — le wizard ne pose plus la question,
  // toute nouvelle réponse retombe sur 'transparent' (étape A détourée).
  fond: LogoFond
  // « pas de noir, pas de blason… » — repris mot pour mot dans le brief
  interdits: string
}

// ── Choix de fond de l'étape B (run 5.4, LOT 4) — APRÈS validation du master ─
export type LogoFondChoix = 'signature' | 'atmospherique' | 'scene'

export const LOGO_FOND_CHOIX: LogoFondChoix[] = ['signature', 'atmospherique', 'scene']

export const LOGO_AMBIANCE_PROMPTS: Record<LogoAmbiance, string> = {
  ete: 'summer mood — bright, juicy, sun-soaked, saturated warmth',
  sombre: 'dark mood — moody, high contrast, deep shadows',
  luxe: 'luxury mood — refined, premium materials, restrained elegance',
  urbain: 'urban street mood — raw city energy, confident swagger, night asphalt',
  esport: 'esport mood — aggressive competitive energy, sharp dynamic angles',
  retro: 'retro mood — vintage textures, heritage letterforms, aged warmth',
  // legacy (wizard v3) — plus proposées, encore parsées
  neon: 'neon mood — glowing tube light, night energy, electric hues',
  propre: 'clean mood — minimal, crisp, flat, optically perfect',
}

// L'ambiance pilote AUSSI la sélection few-shot : son tag rejoint les
// clusterTags du projet dans scoreEntry (exemplars) — question → exemples.
export const LOGO_AMBIANCE_TAG: Record<LogoAmbiance, string> = {
  ete: 'ete',
  sombre: 'sombre',
  luxe: 'luxe',
  urbain: 'urbain',
  esport: 'esport',
  retro: 'retro',
  neon: 'esport',
  propre: 'neutre',
}

// ── LE MAPPING matière → section 2 du gabarit (run 5.5) — VERSIONNÉ ─────────
// Chaque option est JUSTIFIÉE par l'axe mesuré (ADN v4, 59 logos) :
//   neon 27 % · metal 10 % + chrome 8 % · glass 8 % · or = #FFD700, 3e couleur
//   dominante du corpus (et luxe = 42 % des tags). 'studio' = fallback sur les
//   matières de l'ambiance (comportement v3, LOGO_AMBIANCE_DA).
export const LOGO_MATIERE_DA: Record<Exclude<LogoMatiere, 'studio'>, string> = {
  neon: 'glowing neon tube accents, satin acrylic, chrome details with realistic falloff — gloss reserved for one accent highlight',
  chrome: 'polished chrome and brushed metal, crisp controlled speculars',
  or: 'polished gold with aged gold accents, black lacquer contrast',
  verre: 'frosted and smoked glass, controlled glossy speculars, clean edge highlights',
}

// ── LE MAPPING ambiance → éclairage + matières (run 5.4, LOT 5) — VERSIONNÉ ──
// L'ambiance du logo PILOTE la section 2 du gabarit maître (éclairage, key
// light, matières) via l'ADN. Toute évolution se fait ICI et nulle part
// ailleurs — le tableau est cité au rapport (question → effet dans le prompt).
export const LOGO_AMBIANCE_DA: Record<LogoAmbiance, { eclairage: string; matieres: string }> = {
  // Run 5.5 (H9) : « wet glass, juicy glossy gradients » produisait un rendu
  // gel/plastique candy étranger au corpus (repéré à l'aveugle sur chaque
  // candidat été) — matières recalibrées sur les familles mesurées.
  ete: {
    eclairage: 'warm golden key light from top-left, sun-kissed speculars, bright bounce',
    matieres: 'light chrome with crisp speculars, frosted glass, polished beveled surfaces — shine stays controlled, never liquid or gel-like',
  },
  sombre: {
    eclairage: 'low-key dramatic lighting, hard rim light carving the mark out of black',
    matieres: 'aged gold on black, gunmetal, smoked glass',
  },
  luxe: {
    eclairage: 'soft studio key with a warm golden rim, controlled speculars',
    matieres: 'polished gold, black lacquer, marble accents',
  },
  urbain: {
    eclairage: 'cool city-night key light, sodium/neon practicals bouncing off the mark, hard shadows',
    matieres: 'brushed metal, concrete-smooth fills, chrome accents',
  },
  esport: {
    eclairage: 'high-contrast arena lighting, hard rim light, punchy speculars',
    matieres: 'carbon accents, sharp metallic bevels, satin team-jersey fills',
  },
  neon: {
    eclairage: 'saturated neon glow with realistic falloff, night-blue ambient',
    matieres: 'neon tubes, satin acrylic, chrome accents — gloss only as one controlled highlight',
  },
  retro: {
    eclairage: 'warm vintage sunset light, gentle bloom, soft film halation',
    matieres: 'aged enamel, brushed brass, subtle paper grain',
  },
  propre: {
    eclairage: 'even soft studio light, minimal shadows, optically clean edges',
    matieres: 'clean vector surfaces, subtle satin finish, zero texture noise',
  },
}

// Étape A : le livrable est TOUJOURS le même — la ligne fixe du brief.
// Run 5.6 : présentation corpus TRAVAILLÉE (le « empty and calm » du 5.5 est
// la cause racine du verdict client — voir calibration-log-2.md, LOT 1).
export const LOGO_ETAPE_A_LINE =
  'DELIVERABLE (step A): ONE INTEGRAL IMAGE — the complete logo composed WITH its natural corpus backdrop in a single render: deep dark nuanced base (directional gradient, vignette, controlled glow behind the mark) carrying a barely-visible worked layer (thematic motif, contextual micro-scene or graphic texture, sensed at low opacity). The flat cutout (alpha) version is DERIVED from the chosen render in a second isolation pass, and the fully custom background is still a SEPARATE later step (own layer).'

const HEX = /^#[0-9a-fA-F]{6}$/

function parseCouleurs(raw: unknown): LogoCouleurs {
  const input = raw as { mode?: unknown; couleur?: unknown; couleurs?: unknown; angle?: unknown } | null
  if (input?.mode === 'unie' && typeof input.couleur === 'string' && HEX.test(input.couleur)) {
    return { mode: 'unie', couleur: input.couleur.toUpperCase() }
  }
  if (input?.mode === 'degrade' && Array.isArray(input.couleurs)) {
    const couleurs = input.couleurs
      .filter((c): c is string => typeof c === 'string' && HEX.test(c))
      .map((c) => c.toUpperCase())
      .slice(0, 3)
    if (couleurs.length >= 2) {
      const angle = Number(input.angle)
      return { mode: 'degrade', couleurs, angle: Number.isFinite(angle) ? ((angle % 360) + 360) % 360 : 45 }
    }
  }
  return { mode: 'palette' }
}

const LOGO_TYPES: LogoType[] = ['lettre', 'nom', 'embleme']
const LOGO_AMBIANCES: LogoAmbiance[] = ['ete', 'sombre', 'luxe', 'urbain', 'esport', 'retro', 'neon', 'propre']
const LOGO_MATIERES: LogoMatiere[] = ['neon', 'chrome', 'or', 'verre', 'studio']
const LOGO_FONDS: LogoFond[] = ['transparent', 'plein', 'degrade_motifs']

// Accepte le v3 complet ET les réponses v2 ({ type }) des assets existants —
// les champs manquants retombent sur le comportement v2 (palette mapping,
// fond transparent, pas de sujet).
export function parseLogoAnswersV3(raw: unknown): LogoAnswersV3 | null {
  const input = raw as {
    type?: unknown
    sujet?: unknown
    ambiance?: unknown
    matiere?: unknown
    couleurs?: unknown
    fond?: unknown
    interdits?: unknown
  } | null
  if (!input) return null
  const type = LOGO_TYPES.includes(input.type as LogoType) ? (input.type as LogoType) : null
  if (!type) return null

  const ambiance = LOGO_AMBIANCES.includes(input.ambiance as LogoAmbiance) ? (input.ambiance as LogoAmbiance) : null
  // migration v3 → v4 : l'ambiance « néon » d'hier EST la matière néon
  const matiere = LOGO_MATIERES.includes(input.matiere as LogoMatiere)
    ? (input.matiere as LogoMatiere)
    : ambiance === 'neon'
      ? 'neon'
      : 'studio'

  return {
    version: 3,
    type,
    sujet: sanitizeText(input.sujet, 80),
    ambiance,
    matiere,
    couleurs: parseCouleurs(input.couleurs),
    fond: LOGO_FONDS.includes(input.fond as LogoFond) ? (input.fond as LogoFond) : 'transparent',
    interdits: sanitizeText(input.interdits, 160),
  }
}

// Ligne couleurs du brief — les hex de l'utilisateur partent TEL QUELS.
export function couleursBriefLine(couleurs: LogoCouleurs, mappingPalette: string[]): string {
  if (couleurs.mode === 'unie') {
    return `Colors: build the mark around the exact color ${couleurs.couleur} (user-picked), plus neutral shading only.`
  }
  if (couleurs.mode === 'degrade') {
    return `Colors: the mark carries a user-built gradient — exactly ${couleurs.couleurs.join(' → ')} at a ${couleurs.angle}° angle. Reproduce these exact hex stops and this direction.`
  }
  return `Colors: project palette — dominant ${mappingPalette[0] ?? '#00D2FF'}${mappingPalette.length > 1 ? `, accents ${mappingPalette.slice(1).join(', ')}` : ''} — plus neutral shading.`
}

// Le brief complet, en anglais, transmis à l'étage 1 (DA). Les mots de
// l'utilisateur (sujet, interdits) voyagent verbatim.
export function renderLogoBrief(opts: {
  projectName: string
  answers: LogoAnswersV3
  mappingPalette: string[]
  universeLabel: string
}): string {
  const { projectName, answers } = opts
  const typeLine =
    answers.type === 'embleme'
      ? 'Logo type: pure pictorial emblem — a symbol only, zero lettering.'
      : answers.type === 'lettre'
        ? `Logo type: single-letter monogram around the letter "${(projectName.trim()[0] ?? 'N').toUpperCase()}".`
        : `Logo type: full wordmark of the server name "${projectName.trim().toUpperCase()}".`

  return [
    `SERVER NAME: "${projectName.trim()}" (FiveM/GTA RP server, universe: ${opts.universeLabel}).`,
    typeLine,
    answers.sujet
      ? `SUBJECT / THEME (the heart of the concept, given by the user in their own words): "${answers.sujet}". Every concept MUST be built around this theme — never substitute a generic compass, crest or esports badge for it.`
      : 'SUBJECT / THEME: none — the user wants pure lettering craft, no imposed theme.',
    answers.ambiance
      ? `LOGO MOOD (distinct from the server universe): ${LOGO_AMBIANCE_PROMPTS[answers.ambiance]}. This mood DRIVES the lighting of section 2 — ${LOGO_AMBIANCE_DA[answers.ambiance].eclairage}.`
      : '',
    // v4 : la matière choisie PILOTE la section 2 ; 'studio' retombe sur les
    // matières de l'ambiance (comportement v3), sinon sur celles du mapping.
    answers.matiere !== 'studio'
      ? `MATERIALS (user-picked, drives section 2): ${LOGO_MATIERE_DA[answers.matiere]}.`
      : answers.ambiance
        ? `MATERIALS (studio's pick from the mood): ${LOGO_AMBIANCE_DA[answers.ambiance].matieres}.`
        : '',
    couleursBriefLine(answers.couleurs, opts.mappingPalette),
    LOGO_ETAPE_A_LINE,
    answers.interdits ? `USER FORBIDS (verbatim, must be respected): "${answers.interdits}".` : '',
  ].filter(Boolean).join('\n')
}
