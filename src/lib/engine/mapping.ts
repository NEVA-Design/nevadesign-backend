// ── Le mapping réponses → direction artistique (run 5.2, LOT 2) ──────────────
// L'utilisateur ne voit JAMAIS les mots « chrome » ou « graffiti » : il parle
// de son serveur (univers, énergie, époque, couleur), le moteur traduit ici en
// direction artistique interne — lettrage, matières, lumière, étalonnage et
// cluster de références d'entraînement à joindre aux appels.
// Ce tableau EST la documentation versionnée du mapping ; toute évolution se
// fait ici et nulle part ailleurs.

export type StyleUniverse =
  | 'rp_urbain'
  | 'cartel'
  | 'luxe'
  | 'ete_plage'
  | 'sombre_hardcore'
  | 'chill'

export type StyleAnswers = {
  universe: StyleUniverse
  // 0 = élégant/calme, 100 = agressif/percutant
  energie: number
  // 0 = classique/héritage, 100 = moderne/futuriste
  modernite: number
  // hex #RRGGBB, ou 'surprise' → le mapping choisit dans les couleurs du cluster
  couleur: string | 'surprise'
}

// Langages de construction du logo — choisis par le mapping, jamais par
// l'utilisateur (lui ne répond qu'à « Ton logo idéal ? » : lettre/nom/emblème).
export type LogoConstruction = 'embleme_lettre' | 'lettrage_silhouette' | 'esport_italique' | 'badge'

export type ArtDirection = {
  universe: StyleUniverse
  // description du traitement de lettrage injectée dans les prompts héro/logo
  lettering: string
  // matières et finitions dominantes
  matieres: string
  lumiere: string
  etalonnage: string
  // tags de cluster pour sélectionner reverse-prompts + références jointes
  clusterTags: string[]
  // construction logo par type demandé
  logoConstruction: Record<'lettre' | 'nom' | 'embleme', LogoConstruction>
  // palette dérivée : dominante choisie + accents du cluster
  palette: string[]
}

type UniverseRecipe = {
  clusterTags: string[]
  // [pôle élégant (énergie 0), pôle agressif (énergie 100)]
  lettering: [string, string]
  matieres: [string, string]
  lumiere: string
  etalonnage: string
  // couleurs candidates pour « Surprends-moi » et accents
  couleurs: string[]
  logoConstruction: Record<'lettre' | 'nom' | 'embleme', LogoConstruction>
}

// ══ LE TABLEAU DU MAPPING — versionné, cité au rapport ═══════════════════════
// Exemples de lecture :
//   Cartel + Agressif + Rouge  → lettrage condensé agressif à empattements
//     tranchés, chrome sombre, étalonnage rouge/noir, refs cluster « cartel ».
//   Été + Élégant + Teal       → typo display dégradé sunset, lumière solaire,
//     étalonnage chaud saturé, refs cluster « ete ».
export const MAPPING: Record<StyleUniverse, UniverseRecipe> = {
  rp_urbain: {
    clusterTags: ['urbain', 'neutre'],
    lettering: [
      'clean extended sans-serif display lettering with subtle metallic edge lighting',
      'heavy condensed block lettering with hard bevel cuts and street-poster impact',
    ],
    matieres: [
      'brushed steel and glass, fine concrete textures',
      'raw concrete, matte black metal, scratched street surfaces',
    ],
    lumiere: 'city practicals and motivated street lighting, cool ambient with warm accents',
    etalonnage: 'desaturated urban base with one saturated accent family, crushed blacks',
    couleurs: ['#00D2FF', '#F2B035', '#8B5CF6', '#E2E8F0'],
    logoConstruction: { lettre: 'embleme_lettre', nom: 'esport_italique', embleme: 'badge' },
  },
  cartel: {
    clusterTags: ['cartel', 'sombre', 'urbain'],
    lettering: [
      'sharp engraved serif lettering with gold inlay, discreet and menacing',
      'aggressive condensed slab lettering with razor-cut edges and dark chrome finish',
    ],
    matieres: [
      'dark leather, aged gold, smoked glass',
      'dark chrome, gunmetal, cracked lacquer',
    ],
    lumiere: 'low-key dramatic lighting, hard rim light, deep shadows with warm practicals',
    etalonnage: 'red and black dominance, desaturated skin tones, high contrast crushed shadows',
    couleurs: ['#E63946', '#D4A017', '#8B0000', '#0F0F0F'],
    logoConstruction: { lettre: 'embleme_lettre', nom: 'lettrage_silhouette', embleme: 'badge' },
  },
  luxe: {
    clusterTags: ['luxe', 'neutre'],
    lettering: [
      'thin elegant serif lettering with polished gold-foil edges and generous spacing',
      'bold high-contrast fashion serif lettering with liquid gold highlights',
    ],
    matieres: [
      'polished marble, champagne gold, silk',
      'black lacquer, molten gold, faceted glass',
    ],
    lumiere: 'soft studio key light with warm golden rim, controlled speculars',
    etalonnage: 'ink black and warm gold palette, low saturation elsewhere, velvet contrast',
    couleurs: ['#C9A227', '#F5F0E8', '#0A0A0A', '#3D2B1F'],
    logoConstruction: { lettre: 'embleme_lettre', nom: 'lettrage_silhouette', embleme: 'badge' },
  },
  ete_plage: {
    clusterTags: ['ete', 'chill'],
    lettering: [
      'smooth rounded display lettering with sunset gradient fill and soft white outline',
      'chunky beach-club lettering with juicy 3D depth and dripping gradient shine',
    ],
    matieres: [
      'wet glass, chrome water reflections, warm sand textures',
      'glossy vinyl, neon acrylic, splashing water',
    ],
    lumiere: 'bright golden-hour sun, strong warm rim light, sparkling water bounces',
    etalonnage: 'saturated sunset palette — teal, coral, gold — with clean bright whites',
    couleurs: ['#118AB2', '#FF6B4A', '#FFD166', '#06D6A0'],
    logoConstruction: { lettre: 'esport_italique', nom: 'esport_italique', embleme: 'badge' },
  },
  sombre_hardcore: {
    clusterTags: ['sombre', 'militaire'],
    lettering: [
      'stencil-cut industrial lettering with worn metal texture, tight tracking',
      'brutal fractured block lettering with glitch slices and hazard energy',
    ],
    matieres: [
      'gunmetal, carbon fiber, worn kevlar',
      'rusted steel, shattered glass, burnt textures',
    ],
    lumiere: 'harsh single-source key light, cold ambient, smoke-filled beams',
    etalonnage: 'near-monochrome dark grade with one toxic accent (green or red), heavy grain',
    couleurs: ['#00FF66', '#B4443C', '#94A3B8', '#101010'],
    logoConstruction: { lettre: 'embleme_lettre', nom: 'lettrage_silhouette', embleme: 'badge' },
  },
  chill: {
    clusterTags: ['chill', 'retro', 'neutre'],
    lettering: [
      'soft rounded lettering with pastel gradient and gentle outline glow',
      'bold playful bubble lettering with candy 3D depth and sticker outline',
    ],
    matieres: [
      'frosted glass, soft plastic, paper grain',
      'glossy toy plastic, inflatable vinyl, holographic foil',
    ],
    lumiere: 'even soft daylight, pastel ambient bounce, gentle bloom',
    etalonnage: 'pastel palette with airy whites, lifted shadows, low contrast warmth',
    couleurs: ['#8B5CF6', '#22D3EE', '#FFB4E1', '#FFD166'],
    logoConstruction: { lettre: 'esport_italique', nom: 'esport_italique', embleme: 'badge' },
  },
}

// Libellés produit (français, montrés dans le wizard) — le mapping reste interne.
export const UNIVERSE_LABELS: Record<StyleUniverse, string> = {
  rp_urbain: 'RP urbain',
  cartel: 'Cartel',
  luxe: 'Luxe',
  ete_plage: 'Été / plage',
  sombre_hardcore: 'Sombre / hardcore',
  chill: 'Chill communautaire',
}

const HEX = /^#[0-9a-fA-F]{6}$/

function clamp01to100(value: unknown, fallback = 50): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(100, Math.round(n)))
}

export function parseStyleAnswers(raw: unknown): StyleAnswers | null {
  const input = raw as { universe?: unknown; energie?: unknown; modernite?: unknown; couleur?: unknown } | null
  if (!input) return null
  const universe = typeof input.universe === 'string' && input.universe in MAPPING ? (input.universe as StyleUniverse) : null
  if (!universe) return null
  const couleur =
    input.couleur === 'surprise' ? 'surprise' as const
    : typeof input.couleur === 'string' && HEX.test(input.couleur) ? input.couleur
    : 'surprise' as const
  return {
    universe,
    energie: clamp01to100(input.energie),
    modernite: clamp01to100(input.modernite),
    couleur,
  }
}

// Interpolation binaire lisible : sous 50 on parle le pôle élégant, au-dessus
// le pôle agressif — le curseur module aussi les adverbes du prompt final.
function pick([elegant, aggressive]: [string, string], energie: number): string {
  return energie < 50 ? elegant : aggressive
}

function modernityClause(modernite: number): string {
  if (modernite >= 70) return 'resolutely modern, sleek and current'
  if (modernite <= 30) return 'classic, heritage-inspired craftsmanship'
  return 'contemporary balance of classic craft and modern edge'
}

// Choix « Surprends-moi » : déterministe par nom de projet (pas de re-tirage
// à chaque génération — la DA d'un projet est stable).
function surpriseColor(couleurs: string[], seedText: string): string {
  let hash = 0
  for (const char of seedText) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return couleurs[hash % couleurs.length] ?? couleurs[0] ?? '#00D2FF'
}

export function resolveArtDirection(answers: StyleAnswers, projectName: string): ArtDirection {
  const recipe = MAPPING[answers.universe]
  const dominant = answers.couleur === 'surprise' ? surpriseColor(recipe.couleurs, projectName) : answers.couleur
  const accents = recipe.couleurs.filter((c) => c.toLowerCase() !== dominant.toLowerCase()).slice(0, 2)

  return {
    universe: answers.universe,
    lettering: `${pick(recipe.lettering, answers.energie)} — ${modernityClause(answers.modernite)}`,
    matieres: pick(recipe.matieres, answers.energie),
    lumiere: recipe.lumiere,
    etalonnage: `${recipe.etalonnage}, graded toward dominant ${dominant}`,
    clusterTags: recipe.clusterTags,
    logoConstruction: recipe.logoConstruction,
    palette: [dominant, ...accents],
  }
}

// Point d'entrée des routes : DA + curseurs d'un projet, avec repli propre
// pour les projets d'avant le run 5.2 (pas de styleAnswers).
export function artDirectionForProject(project: {
  name: string
  palette?: string[] | null
  ambiance?: { styleAnswers?: unknown } | null
}): { da: ArtDirection; energie: number; modernite: number } {
  const answers = parseStyleAnswers(project.ambiance?.styleAnswers)
  if (answers) {
    return { da: resolveArtDirection(answers, project.name), energie: answers.energie, modernite: answers.modernite }
  }
  return { da: fallbackArtDirection(project.name, project.palette ?? []), energie: 50, modernite: 60 }
}

// DA de repli pour les projets créés avant le run 5.2 (ambiance en phrase
// libre, sans styleAnswers) : urbain neutre, énergie médiane.
export function fallbackArtDirection(projectName: string, palette: string[]): ArtDirection {
  const da = resolveArtDirection(
    { universe: 'rp_urbain', energie: 50, modernite: 60, couleur: palette[0] && HEX.test(palette[0]) ? palette[0] : 'surprise' },
    projectName
  )
  return palette.length >= 2 ? { ...da, palette: palette.slice(0, 3) } : da
}
