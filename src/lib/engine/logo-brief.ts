import { sanitizeText } from '../security'

// ── Le brief logo (run 5.3 → 5.4) ────────────────────────────────────────────
// Le wizard pose les bonnes questions : sujet/thème, forme, ambiance,
// couleurs libres (picker + dégradé), interdits — le brief exact transmis au
// directeur artistique (étage 1) et affiché tel quel dans le récap wizard.
// Run 5.4, LOT 4 : la question « fond » DISPARAÎT de l'étape logo. L'étape A
// livre toujours le lettrage/emblème seul sur fond #F2F2F2 de détourage — le
// relief et le glow appartiennent au logo, pas au fond. Le fond réel arrive à
// l'étape B (écran dédié après validation du master), généré SÉPARÉMENT et
// composé par calques. Le champ `fond` ne survit que pour lire les
// wizard_answers des assets d'avant le run 5.4.

export type LogoType = 'lettre' | 'nom' | 'embleme'

export type LogoAmbiance = 'ete' | 'sombre' | 'luxe' | 'neon' | 'retro' | 'propre'

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
  neon: 'neon mood — glowing tube light, night energy, electric hues',
  retro: 'retro mood — vintage textures, heritage letterforms, aged warmth',
  propre: 'clean mood — minimal, crisp, flat, optically perfect',
}

// ── LE MAPPING ambiance → éclairage + matières (run 5.4, LOT 5) — VERSIONNÉ ──
// L'ambiance du logo PILOTE la section 2 du gabarit maître (éclairage, key
// light, matières) via l'ADN. Toute évolution se fait ICI et nulle part
// ailleurs — le tableau est cité au rapport (question → effet dans le prompt).
export const LOGO_AMBIANCE_DA: Record<LogoAmbiance, { eclairage: string; matieres: string }> = {
  ete: {
    eclairage: 'warm golden key light from top-left, sun-kissed speculars, bright bounce',
    matieres: 'light chrome, wet glass, juicy glossy gradients',
  },
  sombre: {
    eclairage: 'low-key dramatic lighting, hard rim light carving the mark out of black',
    matieres: 'aged gold on black, gunmetal, smoked glass',
  },
  luxe: {
    eclairage: 'soft studio key with a warm golden rim, controlled speculars',
    matieres: 'polished gold, black lacquer, marble accents',
  },
  neon: {
    eclairage: 'saturated neon glow with realistic falloff, night-blue ambient',
    matieres: 'neon tubes, glossy acrylic, chrome accents',
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
export const LOGO_ETAPE_A_LINE =
  'DELIVERABLE (step A): the mark ALONE on a flat neutral #F2F2F2 cutout background — the real background is a SEPARATE later step (own layer), never rendered here. Relief and glow belong to the logo itself, not to a background.'

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
const LOGO_AMBIANCES: LogoAmbiance[] = ['ete', 'sombre', 'luxe', 'neon', 'retro', 'propre']
const LOGO_FONDS: LogoFond[] = ['transparent', 'plein', 'degrade_motifs']

// Accepte le v3 complet ET les réponses v2 ({ type }) des assets existants —
// les champs manquants retombent sur le comportement v2 (palette mapping,
// fond transparent, pas de sujet).
export function parseLogoAnswersV3(raw: unknown): LogoAnswersV3 | null {
  const input = raw as {
    type?: unknown
    sujet?: unknown
    ambiance?: unknown
    couleurs?: unknown
    fond?: unknown
    interdits?: unknown
  } | null
  if (!input) return null
  const type = LOGO_TYPES.includes(input.type as LogoType) ? (input.type as LogoType) : null
  if (!type) return null

  return {
    version: 3,
    type,
    sujet: sanitizeText(input.sujet, 80),
    ambiance: LOGO_AMBIANCES.includes(input.ambiance as LogoAmbiance) ? (input.ambiance as LogoAmbiance) : null,
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
      ? `LOGO MOOD (distinct from the server universe): ${LOGO_AMBIANCE_PROMPTS[answers.ambiance]}. This mood DRIVES section 2 of the template — lighting: ${LOGO_AMBIANCE_DA[answers.ambiance].eclairage}; materials: ${LOGO_AMBIANCE_DA[answers.ambiance].matieres}.`
      : '',
    couleursBriefLine(answers.couleurs, opts.mappingPalette),
    LOGO_ETAPE_A_LINE,
    answers.interdits ? `USER FORBIDS (verbatim, must be respected): "${answers.interdits}".` : '',
  ].filter(Boolean).join('\n')
}
