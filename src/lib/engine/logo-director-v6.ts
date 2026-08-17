/*
 * Run 6 — LE DIRECTEUR ARTISTIQUE v6 : le DA n'écrit plus qu'UNE PHRASE.
 *
 * Point de départ non négociable (§0 du document v6) : la seule formulation
 * qui ait jamais produit le niveau cible est le transfert minimal du test
 * plafond — 52 mots, 3 phrases, zéro hex, zéro négation, un seul matériau
 * avec une alternative, le fond en 4 mots. Ce prompt ÉCHOUE le validateur du
 * run 5.10 (pas de hex verbatim, 0 clause « no … »). Tout ce module découle
 * de ce constat : c'est le validateur qui avait tort.
 *
 *   S1  Design a premium logo for a FiveM/GTA RP server named "<MOT>", spelled
 *       <M-O-T>, at the same production quality as the attached reference logos.
 *   S2  <LA SEULE PHRASE ÉCRITE PAR LE DA — 15 à 25 mots>
 *   S3  The word must read exactly "<MOT>" with perfectly formed letters.
 *
 * S1 et S3 sont des CONSTANTES concaténées par le code. Le DA ne les écrit
 * pas : il ne peut donc plus les abîmer, et l'orthographe est verrouillée par
 * construction. Son travail créatif tient entier dans S2.
 *
 * Le run 5.10 n'est PAS supprimé : logo-director.ts continue de tourner. Ce
 * module est la branche v6, activée par expérience (E3/E4) — une variable à
 * la fois, comme exigé.
 */

import { geminiJson, type GeminiUsage } from '../ai/gemini'
import { ENGINE_MODELS, LOGO_THINKING_LEVEL } from './generation'
import { renderLogoBrief, LOGO_AMBIANCE_TAG, type LogoAnswersV3 } from './logo-brief'
import { listReferenceCatalogue, idiomeParSlug } from './exemplars'
import { logGeneration } from './guards'
import { UNIVERSE_LABELS, type ArtDirection } from './mapping'
import { detecteFrancais, demandeInterdite, spellOut } from './logo-stack'
import {
  validateBlockout,
  verifieContratBlockout,
  plancherOverlap,
  BLOCKOUT_FONT,
  BLOCKOUT_SHAPES,
  type BlockoutSpec,
} from './logo-blockout'
import { DEBORDEMENT_MAX, DEBORDEMENT_MIN } from './overlap'
import { directWithClaude, claudeDisponible } from '../ai/claude'
import type { ProjectLike } from './compiler'

// ── §2 — LE VOCABULAIRE DE CONSTRUCTIONS, liste FERMÉE ───────────────────────
// Extrait des pièces gold. Les 3 concepts d'un trio = 3 archétypes DIFFÉRENTS.

/*
 * PATCH v6 P1 — GLYPH_FUSION SORT DE LA ROTATION.
 *
 * Mesuré à E1 : FLASH MOOD (pièce gold, GLYPH_FUSION) sort à 0,292 ; integ1,
 * rejeté par l'opérateur, sort à 0,217. Écart 0,075, un point contre un point.
 * L'overlap discrimine sur CONTAINER / ENTWINED (1,000 · 1,000 · 0,488 contre
 * 0,097-0,217) et NULLE PART AILLEURS. Les trois prompts du 5.10 étaient tous
 * en GLYPH_FUSION, les trois ont été rejetés, et c'est le seul archétype pour
 * lequel on n'a AUCUNE garde. À rouvrir quand une garde existera pour lui.
 */
/*
 * PIVOT IDIOME (17/08) — HERO_MONOGRAM PASSE EN TÊTE.
 *
 * Mandat opérateur, sur relecture des vraies références : l'idiome FiveM est
 * majoritairement fait de MONOGRAMMES de 1 à 3 lettres, pas de wordmarks à
 * emblème. HERO_MONOGRAM devient l'archétype par défaut, et l'overlap cesse
 * d'être le critère principal — il ne s'y applique pas (voir
 * ARCHETYPES_SANS_EMBLEME dans overlap.ts, mesuré à E1).
 *
 * Conséquence à ne pas masquer : l'archétype par défaut n'a PLUS de garde de
 * composition en code. C'est exactement le motif pour lequel GLYPH_FUSION est
 * sorti de la rotation au patch P1. La différence est assumée et documentée :
 * ici c'est une décision de cible, pas un oubli — la garde qui reste applicable
 * est l'échelle (le monogramme doit être massif), et elle est vérifiée §5.
 */
export const ARCHETYPES = ['HERO_MONOGRAM', 'WORDMARK_PUR', 'CONTAINER', 'ENTWINED', 'CREST', 'SCENE'] as const
export type Archetype = (typeof ARCHETYPES)[number]
export const ARCHETYPE_DEFAUT: Archetype = 'HERO_MONOGRAM'

/*
 * HERO_MONOGRAM A UNE LIMITE DE LONGUEUR (correction opérateur du 17/08).
 *
 * Un monogramme héros, ce sont une à trois lettres à échelle massive. Au-delà,
 * le modèle empile : AZURE est sorti en A géant surmontant « ZURE » — deux
 * lignes, deux tailles, ce n'est plus un monogramme, c'est un lockup qui n'ose
 * pas dire son nom. Un nom long part en wordmark ou en construction enlacée.
 */
export const HERO_MONOGRAM_MAX_LETTRES = 3

/** Les lettres du mot, espaces et ponctuation exclus. « Northside RP » = 11. */
export function compteLettres(mot: string): number {
  return (mot.match(/\p{L}/gu) ?? []).length
}

/** La rotation RÉELLEMENT proposable pour ce mot. */
export function rotationPourMot(mot: string | null): readonly Archetype[] {
  if (!mot) return ARCHETYPES
  return compteLettres(mot) <= HERO_MONOGRAM_MAX_LETTRES
    ? ARCHETYPES.filter((a) => a !== 'WORDMARK_PUR')
    : ARCHETYPES.filter((a) => a !== 'HERO_MONOGRAM')
}

/** L'archétype qu'au moins un concept du trio doit porter, pour ce mot. */
export function archetypesPivotPourMot(mot: string | null): readonly Archetype[] {
  if (!mot) return []
  return compteLettres(mot) <= HERO_MONOGRAM_MAX_LETTRES ? ['HERO_MONOGRAM'] : ['WORDMARK_PUR', 'ENTWINED']
}

// ── PIVOT IDIOME — LES FAMILLES DE RENDU, liste FERMÉE ───────────────────────
/*
 * Elles REMPLACENT le « chrome ou satin » par défaut. Le trio
 * plat_premium/semi_flat_biseau/dimensionnelle du manifest décrivait un degré
 * de RELIEF ; ces quatre-là décrivent la LANGUE : ce qui remplit les formes et
 * ce qui se pose par-dessus.
 */
export const FAMILLES_RENDU = ['flat_vector_texture', 'texture_fill', 'scene_composite', 'chrome_3d'] as const
export type FamilleRendu = (typeof FAMILLES_RENDU)[number]
export const FAMILLE_RENDU_DEFAUT: FamilleRendu = 'flat_vector_texture'
/** chrome_3d est MINORITAIRE : au plus 1 concept sur 3 (mandat opérateur). */
export const MAX_CHROME_3D = 1

export const FAMILLE_RENDU_DEFINITIONS: Record<FamilleRendu, { quoi: string; matiere: string; gold: string }> = {
  flat_vector_texture: {
    quoi: 'flat vector shapes with a thick black keyline, a texture laid OVER them (halftone dot screen, grain, scanlines, technical grid), two colours and no third',
    matiere: '"flat vector or duotone surfaces", "screenprint or halftone finish", "matte vinyl or paper-grain surfaces"',
    gold: 'TBN (scanline-filled letters under a halftone sky), the winged V (halftone dots in the fill), the white B',
  },
  texture_fill: {
    quoi: 'the glyph itself is a window: a matter is cut to its silhouette — city lights, fire, smoke, mountains — and fills the letterform',
    matiere: '"city-light or ember fill materials", "photographic or painted fill surfaces"',
    gold: 'the W filled with light behind a chain-link fence, FLASH MOOD over palms',
  },
  scene_composite: {
    quoi: 'the flat mark stands inside a dark, LOW-CONTRAST photographic scene — Los Santos street, palms, chain-link, night skyline',
    matiere: '"flat paint or matte vinyl surfaces"',
    gold: 'the chrome S on a GTA street, BLACK Story under palms, the red ML over a skyline',
  },
  chrome_3d: {
    quoi: 'reflective metal and real relief',
    matiere: '"chrome or satin materials", "brushed steel or gold materials"',
    gold: 'the fractured gold R, the chrome S',
  },
}

/** Les trois familles PLATES : le métal réfléchissant et le relief y sont des
 *  fautes de langue, pas des variantes de goût. */
const FAMILLES_PLATES = new Set<FamilleRendu>(['flat_vector_texture', 'texture_fill', 'scene_composite'])

/*
 * LA CLAUSE DE FAMILLE — écrite par le CODE, comme S1 et S3.
 *
 * Correction opérateur du 17/08 : le contour noir épais et le duotone sont sur
 * TOUTES ses références, et sur aucun des trois prompts de la phase 1. « Ce ne
 * sont pas des options, c'est la définition de la famille » — donc ils ne
 * dépendent plus de ce que le DA pense à écrire. Le prompt assemblé devient
 * S1 + S2 + CLAUSE + S3, et le budget de mots du DA reste entier pour la
 * construction et la scène.
 */
/*
 * Ajout opérateur du 17/08 (fin de session), sur le rendu `vulcain` : « trop de
 * détail. Ma référence vulcainlogo c'est DEUX AILES, rien d'autre. »
 *
 * ⚠ RÉSERVE À LEVER AVANT DE JUGER CETTE VERSION. Ces quatre « no … » sont les
 * PREMIÈRES clauses négatives réintroduites dans un prompt image depuis le run
 * 5.9, qui les avait toutes retirées sur une preuve : au 5.8, « contour blanc
 * épais » écrit en négation a été exécuté À LA LETTRE par le modèle. Le risque
 * ici est nommé : « no rivets, no gears » peut faire apparaître des rivets et
 * des engrenages. La formulation positive équivalente, à essayer si le rendu
 * régresse, tient dans la même place :
 *     « Every shape is one closed silhouette, cut from a single flat area. »
 * Non appliquée d'office : c'est le texte de l'opérateur, verbatim, et le
 * `vulcain` de contrôle n'est pas rejoué cette session — la comparaison se fera
 * à la prochaine, sur image.
 */
export const CLAUSE_FAMILLE: Partial<Record<FamilleRendu, string>> = {
  flat_vector_texture:
    'Flat vector shapes with a thick black outline and a strict two-color palette. No inner paneling, no rivets, no gears, no secondary shapes. The mark is one silhouette.',
}

/*
 * LA CLAUSE DE CADRAGE — toutes familles (correction opérateur du 17/08, 2e passe).
 *
 * « Mes références ont un fond ENFONCÉ, pas une scène en vitrine. » Le tir
 * précédent a nommé de vraies scènes — c'était la correction demandée — mais
 * elles se sont mises à jouer leur propre rôle, à égalité avec la marque. La
 * seconde phrase (« lisible à 64 pixels ») porte l'anti-micro-détail : elle
 * l'obtient en DEMANDANT quelque chose, jamais en interdisant — la règle du
 * plafond, où aucune négation ne figurait.
 */
export const CLAUSE_CADRAGE =
  'The background is dark, desaturated and low in contrast so the mark dominates the frame. The mark is simple and bold enough to stay readable at 64 pixels.'

/** Ce que le code écrit déjà : si le DA le réécrit, le prompt le dit deux fois. */
const DEJA_DIT_PAR_LE_CODE = /\b(thick black outline|two-colou?r palette|readable at 64|dominates the frame)\b/i

/*
 * LE MICRO-DÉTAIL — un sujet, une silhouette.
 *
 * Relevé sur le rendu `vulcain` : engrenages, rivets, façade de casino détaillée
 * derrière l'emblème. Rien de tout cela n'était demandé — mais rien ne
 * l'empêchait non plus. La garde porte sur ce que le DA DEMANDE ; la clause de
 * cadrage porte sur ce que le modèle DESSINE. Il faut les deux.
 */
const MICRO_DETAIL =
  /\b(gears?|cogs?|cogwheels?|sprockets?|rivets?|bolts?|screws?|studs?|filigree|ornaments?|ornate|intricate|intricately|detailed|highly[-\s]detailed|engrav\w+|embellish\w+|greebl\w+|panell?ing|circuitry|scrollwork|flourishes?)\b/i

/** Les marqueurs de chrome / relief — interdits hors chrome_3d. */
const MOTS_RELIEF =
  /\b(chrome|chromed|metallic|reflective|polished\s+metal|extruded|extrusion|bevell?ed|bevels?|three-dimensional|3d|glass|iridescent|holographic)\b/i

/** flat_vector_texture DOIT nommer sa texture : c'est le cœur de la famille. */
const MOTS_TEXTURE = /\b(halftone|half-tone|screen(?:print|ed|tone)?|scanlines?|grain|grainy|grid|dot\s+screen|dots|risograph|stipple|noise)\b/i

/** texture_fill DOIT dire que la matière REMPLIT le glyphe. */
const MOTS_REMPLISSAGE = /\b(fill|filled|filling|fills|cut\s+out\s+of|carved\s+out\s+of|window)\b/i

/*
 * LE FOND DOIT NOMMER UNE SCÈNE (correction opérateur du 17/08).
 *
 * « on a dark atmospheric background » ne décrit rien : c'est le défaut exact
 * de northside, la pièce la plus faible d'E3 — fond noir presque vide, et le
 * reproche client d'origine du 5.6. Toutes les pièces de référence portent une
 * VRAIE scène : ville violette, grillage, palmiers, casino de nuit.
 *
 * La garde vérifie qu'un lieu ou un objet de scène est NOMMÉ. Elle ne mesure
 * pas la longueur de la clause de fond isolément : découper la phrase à la
 * dernière préposition marcherait la plupart du temps et se tromperait sur les
 * constructions qui en contiennent déjà — mieux vaut une garde qui dit vrai sur
 * ce qu'elle regarde. Les 5-8 mots sont demandés au DA, la scène est exigée ici.
 */
const SCENE_NOMMEE =
  /\b(city|cityscape|skyline|skyscrapers?|downtown|street|streets|alley|boulevard|avenue|road|highway|freeway|overpass|underpass|bridge|tunnel|fence|chain-link|chainlink|wire|palm|palms|palm-lined|beach|shore|pier|dock|docks|harbou?r|marina|casino|club|bar|motel|diner|station|subway|train|garage|parking|lot|warehouse|factory|refinery|forge|foundry|arena|stadium|court|rooftop|roofs?|balcony|desert|dunes|mountains?|ridge|canyon|forest|woods|swamp|field|farm|storm|rain|fog|mist|smoke|dust|asphalt|pavement|sidewalk|kerb|curb|traffic|headlights|taillights|streetlights?|lamppost|neon|billboard|signage|graffiti|mural|barbed|scaffolding|crane|pylons?|antenna|helipad|freight|containers?|hangar|airstrip|bunker|vault|yard|alleyway|projects|suburb|hills?)\b/i

/** Les fonds vides, nommés pour être cités dans le message de rejet. */
const FOND_VIDE =
  /\bon\s+a\s+(?:dark|deep|moody|atmospheric|low-contrast|simple|plain|clean|neutral|abstract|blurred|soft)[\w\s-]{0,30}?(background|backdrop)\b/i

/** Hors rotation — nommés pour MESURER des pièces héritées (gold set, rendus
 *  du 5.10), jamais proposables au DA. WORDMARK_PUR en est sorti le 17/08 :
 *  c'est la construction des noms de plus de trois lettres. */
export const ARCHETYPES_HORS_ROTATION = ['GLYPH_FUSION', 'LOCKUP_EMPILE'] as const

/** Le brief sans lettrage (« emblème seul ») : aucun des archétypes de la
 *  rotation ne s'applique — ils décrivent tous une relation à un mot. */
export const ARCHETYPE_SANS_LETTRAGE = 'EMBLEM_ONLY'

export const ARCHETYPE_DEFINITIONS: Record<Archetype, { relation: string; gold: string }> = {
  HERO_MONOGRAM: {
    relation:
      'ONE to THREE letters at massive scale carry the whole mark — the letterform IS the emblem. Cuts, notches and a fused shape do the work; nothing is placed beside it',
    gold: 'the winged V, the white B, the fractured gold R, the chrome S',
  },
  WORDMARK_PUR: {
    relation:
      'the full word IS the mark: one custom-drawn line of lettering, cut and joined so the word reads as a single shape. No emblem beside it, no second line',
    gold: 'FLASH MOOD, the BLACK Story brush wordmark',
  },
  CONTAINER: {
    relation: 'the lettering lives INSIDE an emblem larger than the word, and breaks out of its silhouette at the ends',
    gold: 'NEXT LAND inside its red triangle',
  },
  ENTWINED: {
    relation: 'the subject coils around the lettering, in front of some letters, behind others',
    gold: 'TBN woven through the Statue of Liberty, the A + dolphin, BLACK crossed by its script',
  },
  CREST: {
    relation: 'a full badge carries the lettering across its center band',
    // P1 : la planche South District, seul gold cité pour CREST, mesure 0,000 —
    // elle est en réalité LOCKUP_EMPILE. Elle est depuis sortie du corpus de
    // références (pivot idiome) : CREST reste en rotation au seuil 0,20 mais
    // n'a AUCUNE pièce gold pour l'ancrer.
    gold: 'aucune pièce gold ne l’ancre — construction la moins sûre de la rotation',
  },
  SCENE: {
    relation: 'the mark stands as a physical object inside a dark, low-contrast GTA-style scene',
    gold: 'the chrome S on a street, the red ML over a skyline, GTA/NEW under palms',
  },
}

// ── §1 — LES BORNES DURES DE S2 ──────────────────────────────────────────────
/*
 * Le fond passe de 3-5 mots à 5-8 (correction opérateur du 17/08 : « dark
 * atmospheric background » est VIDE, c'est le défaut de northside). S2 gagne
 * les trois mots correspondants.
 */
export const S2_MIN_MOTS = 18
export const S2_MAX_MOTS = 28
export const PROMPT_MIN_MOTS = 45
/*
 * 75 → 80 → 105. Les clauses de code (famille 13 mots, cadrage 28) s'ajoutent
 * au prompt assemblé sans venir du budget créatif du DA — la borne qui compte
 * reste S2, plafonnée à 28 mots.
 *
 * À DIRE QUAND MÊME, et c'est de pire en pire : le prompt total est passé de
 * ~70 à ~100 puis ~115 mots, alors que la leçon du test plafond était « moins
 * de prompt = plus de qualité quand les références portent le style » — 52 mots
 * pour les deux gagnants. La méthode change en même temps (REFERENCE 1 devient
 * une cible de COPIE, ce qui va dans le sens du plafond) mais l'allongement est
 * réel, cumulatif, et n'a jamais été testé isolément. Chaque clause ajoutée est
 * défendable une par une ; leur somme ne l'a pas été.
 */
export const PROMPT_MAX_MOTS = 120

/** PIVOT IDIOME — « massive scale » est la définition de HERO_MONOGRAM, donc
 *  elle se vérifie : si le DA joint un blockout, le mot doit couvrir au moins
 *  cette part de la largeur du canevas. Mesuré sur les pièces gold de
 *  l'archétype (V ailé, B blanc, R or) : toutes au-delà de 0,55. */
export const HERO_LARGEUR_MIN = 0.45

export type ConceptRef = { slug: string; label: string }

export type LogoConceptV6 = {
  archetype: Archetype | typeof ARCHETYPE_SANS_LETTRAGE
  /** pivot idiome — la langue de rendu visée, liste fermée */
  famille_rendu: FamilleRendu
  /** LA phrase — tout le travail créatif du DA */
  s2: string
  /** le prompt complet S1+S2+S3, assemblé PAR LE CODE */
  prompt: string
  /** une ligne française pour le journal opérateur */
  why: string
  refs: ConceptRef[]
  /** null pour un brief sans lettrage : un squelette de composition sans mot
   *  n'a rien à contraindre */
  blockout: BlockoutSpec | null
  /** P2 : mesuré en code sur le blockout, jamais déclaré par le DA */
  debordement: number | null
}

export type LogoDirectorV6Result = {
  concepts: LogoConceptV6[]
  usage: GeminiUsage
  durationMs: number
  modele: string
}

// ── LE SQUELETTE — S1 et S3 écrits par le CODE, jamais par le modèle ─────────

/*
 * PIVOT IDIOME (17/08) — « premium » sort de S1.
 *
 * Le mot tirait le modèle vers le luxe chromé : c'est le vocabulaire des
 * marques de parfum, pas celui des serveurs FiveM. Et « at the same production
 * quality as » ne demandait qu'une QUALITÉ D'EXÉCUTION — le modèle pouvait la
 * servir dans n'importe quelle langue visuelle, ce qu'il a fait. La formule
 * demande maintenant l'IDIOME lui-même : la langue visuelle des références,
 * pas seulement leur niveau de finition.
 */
export function phraseS1(mot: string | null): string {
  if (!mot) {
    return 'Design an emblem for a FiveM/GTA RP server, with no text and no lettering, in the exact visual idiom of the attached reference logos.'
  }
  return `Design a logo for a FiveM/GTA RP server named "${mot}", spelled ${spellOut(mot)}, in the exact visual idiom of the attached reference logos.`
}

export function phraseS3(mot: string | null): string {
  if (!mot) return 'The image contains no text and no lettering of any kind.'
  return `The word must read exactly "${mot}" with perfectly formed letters.`
}

/** Le prompt intégral : S1, la phrase du DA, la clause de sa famille quand elle
 *  en a une, S3. Rien de plus. */
export function buildPromptV6(s2: string, mot: string | null, famille?: FamilleRendu): string {
  const corps = s2.trim().replace(/\s+/g, ' ')
  const ponctue = /[.!?]$/.test(corps) ? corps : `${corps}.`
  const clause = famille ? CLAUSE_FAMILLE[famille] : undefined
  return [phraseS1(mot), ponctue, clause, CLAUSE_CADRAGE, phraseS3(mot)].filter(Boolean).join(' ')
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

// ── §4 — LE VALIDATEUR v6 : ce qui était obligatoire devient interdit ────────

/** Les hex ne survivent pas au tokenizer et « exactly two colors » annule
 *  mécaniquement le chrome (une réflexion d'environnement a besoin d'un
 *  dégradé sombre→clair). Les couleurs passent en post-rendu (§6). */
const HEX = /#[0-9a-f]{3,8}\b/i

/** Toute clause négative dans S2 = rejet. La règle « >= 2 clauses no … » du
 *  run 5.10 est INVERSÉE : le prompt gagnant du plafond n'en portait aucune. */
const NEGATION = /\b(no|not|never|without|avoid|avoiding|nor|neither|free\s+of|instead\s+of|rather\s+than)\b/i

/** L'emblème doit CONTENIR, TRAVERSER, ENLACER ou PORTER le lettrage —
 *  jamais être posé à côté. C'est la faute de composition des trois rejets. */
const POSE_A_COTE = /\b(placed\s+on|next\s+to|beside|sitting\s+on|sits\s+on|perched\s+(on|above)|above\s+the\s+lettering|underneath\s+the\s+lettering|to\s+the\s+(left|right)\s+of)\b/i

/** La relation physique attendue : au moins un de ces verbes/prépositions.
 *  PIVOT IDIOME : les verbes du MONOGRAMME (cut, carved, notched, fused, split)
 *  y entrent — sur HERO_MONOGRAM il n'y a pas deux objets en relation, il y a
 *  une forme et ce qu'on en fait, et l'ancienne liste rejetait précisément la
 *  manière juste de le décrire. */
const RELATION = /\b(holds?|contains?|cradl\w+|encircl\w+|surround\w+|wrap\w+|coils?|winds?|weav\w+|crosses|crossing|through|across|inside|within|replaces?|pierc\w+|slic\w+|carr(?:y|ies)|dominat\w+|locked|stands?|frames?|houses?|nests?|passing|cut|carved?|notch\w+|fus\w+|split|overlap\w*|burst\w*|breaks?\s+out|spills?\s+over)\b/i

/** Les adjectifs de finition, à ne pas empiler (le §1 en interdit la pile). */
const FINITIONS = [
  'specular', 'speculars', 'frosted', 'glossy', 'gloss', 'candy', 'gel', 'iridescent',
  'holographic', 'bevel', 'bevels', 'beveled', 'extrusion', 'extruded', 'polished',
  'brushed', 'glow', 'glowing', 'grain', 'lacquer', 'lacquered', 'wet',
]
export const MAX_FINITIONS = 2

/** La matière : exactement une famille + une alternative, reliées par « or ».
 *  Chaque famille peut tenir en DEUX mots (« brushed steel or black lacquer
 *  materials ») — la règle porte sur « une famille + une alternative », pas
 *  sur un gabarit de cinq mots. Relevé E3 : trois concepts consécutifs
 *  rejetés pour avoir écrit une matière en deux mots ou terminé par
 *  « surfaces », alors que le contrat était tenu. */
const MATIERE =
  /\b([a-z][a-z-]+(?:\s+[a-z][a-z-]+)?)\s+or\s+([a-z][a-z-]+(?:\s+[a-z][a-z-]+)?)\s+(materials?|finish(?:es)?|surfaces?)\b/i

export type ValidationOpts = {
  answers: LogoAnswersV3
  projectName: string
  /** slugs joignables (image présente, >= 512 px) */
  slugsDisponibles: Set<string>
  slugsGold: Set<string>
  /** slugs portant l'idiome FiveM/GTA — seuls admis en REFERENCE 1 */
  slugsFivem: Set<string>
  /** famille de rendu OBSERVÉE de chaque pièce d'idiome (`_fivem-set.json`) —
   *  sert à exiger que REFERENCE 1 parle la langue du concept */
  familleParSlug?: Map<string, string | undefined>
}

export async function validateConceptsV6(
  raw: unknown,
  opts: ValidationOpts
): Promise<{ concepts: LogoConceptV6[] } | { errors: string[] }> {
  const parsed = raw as { concepts?: unknown } | null
  const list = Array.isArray(parsed?.concepts) ? parsed.concepts : null
  if (!list || list.length !== 3) return { errors: ['exactly 3 concepts required'] }

  const mot =
    opts.answers.type === 'nom'
      ? opts.projectName.trim().toUpperCase()
      : opts.answers.type === 'lettre'
        ? (opts.projectName.trim()[0] ?? 'N').toUpperCase()
        : null
  // brief « emblème seul » : aucun mot, donc aucune relation emblème/lettrage
  // à exiger, aucun blockout à contraindre, aucune mesure applicable.
  const sansLettrage = mot === null

  const errors: string[] = []
  const concepts: LogoConceptV6[] = []

  // La CITATION du fragment fautif est une loi depuis le 5.9 : sans elle, le
  // modèle réécrit la même phrase au second essai et l'appel est perdu. Elle
  // sert aussi aux règles de trio (§12-13), d'où sa portée de fonction.
  const cite = (frag: string) => ` — offending fragment: "${frag.slice(0, 200)}"`

  for (const [i, item] of list.entries()) {
    const c = item as Partial<LogoConceptV6>
    const label = `concept ${i + 1}`

    const rotation = rotationPourMot(mot)
    const archetypeVoulu = String(c.archetype)
    const archetype: Archetype | typeof ARCHETYPE_SANS_LETTRAGE | null = sansLettrage
      ? archetypeVoulu === ARCHETYPE_SANS_LETTRAGE
        ? ARCHETYPE_SANS_LETTRAGE
        : null
      : (rotation as readonly string[]).includes(archetypeVoulu)
        ? (archetypeVoulu as Archetype)
        : null
    if (!archetype) {
      if (sansLettrage) {
        errors.push(`${label}: this brief carries NO lettering — "archetype" must be "${ARCHETYPE_SANS_LETTRAGE}" (got "${archetypeVoulu}")`)
      } else if (archetypeVoulu === 'HERO_MONOGRAM') {
        // le cas le plus fréquent, et il mérite sa propre explication
        errors.push(
          `${label}: "${mot}" is ${compteLettres(mot ?? '')} letters — HERO_MONOGRAM is for ${HERO_MONOGRAM_MAX_LETTRES} letters or fewer. Past that the model stacks the word on two lines and it stops being a monogram. Pick one of ${rotation.join(' / ')}`
        )
      } else if (archetypeVoulu === 'WORDMARK_PUR') {
        errors.push(
          `${label}: "${mot}" is only ${compteLettres(mot ?? '')} letters — a word that short carries better as a monogram. Pick one of ${rotation.join(' / ')}`
        )
      } else if ((ARCHETYPES_HORS_ROTATION as readonly string[]).includes(archetypeVoulu)) {
        errors.push(
          `${label}: "${archetypeVoulu}" is OUT of the production rotation (no working guard exists for it) — pick one of ${rotation.join(' / ')}`
        )
      } else {
        errors.push(`${label}: "archetype" must be one of ${rotation.join(' / ')} (got "${archetypeVoulu}")`)
      }
      continue
    }

    // PIVOT IDIOME — la famille de rendu, liste fermée. Elle remplace le
    // « chrome ou satin » par défaut et conditionne les règles de matière.
    const familleVoulue = String((c as { famille_rendu?: unknown }).famille_rendu ?? '')
    const famille = (FAMILLES_RENDU as readonly string[]).includes(familleVoulue)
      ? (familleVoulue as FamilleRendu)
      : null
    if (!famille) {
      errors.push(
        `${label}: "famille_rendu" must be one of ${FAMILLES_RENDU.join(' / ')} (got "${familleVoulue}") — it is the visual language of the render, not a finish`
      )
      continue
    }

    const s2 = String(c.s2 ?? '').trim()
    if (!s2) {
      errors.push(`${label}: "s2" is missing — it is the ONLY sentence you write`)
      continue
    }

    // 1. la longueur — 15 à 25 mots, borne DURE
    const mots = wordCount(s2)
    if (mots < S2_MIN_MOTS || mots > S2_MAX_MOTS) {
      errors.push(
        `${label}: s2 is ${mots} words, the hard range is ${S2_MIN_MOTS}-${S2_MAX_MOTS} — it carries exactly three things: the construction, one material family plus an alternative, and a three-to-five-word background`
      )
    }
    // 2. anglais uniquement — S2 part verbatim au modèle image
    if (detecteFrancais(s2)) {
      errors.push(`${label}: s2 must be written ENTIRELY in English (French words or accents detected)${cite(s2)}`)
    }
    // 3. aucun hex — les couleurs sont traitées après le rendu (§6)
    const hex = s2.match(HEX)
    if (hex) {
      errors.push(
        `${label}: s2 carries a hex code${cite(hex[0])} — colors are handled after rendering, never in the prompt. Remove it; the references and the material carry the look`
      )
    }
    // 4. aucune clause négative — la règle du run 5.10 est inversée
    const neg = s2.match(NEGATION)
    if (neg) {
      errors.push(
        `${label}: s2 carries a negative clause${cite(neg[0])} — the winning ceiling prompt had none. State what the image SHOWS, never what it must avoid`
      )
    }
    // 5 et 6 ne s'appliquent qu'aux marques AVEC lettrage : sans mot, il n'y a
    // ni « posé à côté » ni relation emblème/lettrage à décrire.
    if (!sansLettrage) {
      // 5. l'emblème ne se pose pas à côté du lettrage
      const pose = s2.match(POSE_A_COTE)
      if (pose) {
        errors.push(
          `${label}: s2 places the emblem beside the lettering${cite(pose[0])} — the emblem must contain, cross, wrap or carry the word. Rewrite the construction`
        )
      }
      /*
       * 6. la construction décrit une relation physique.
       *
       * WORDMARK_PUR en est exempt : le mot EST la marque, il n'y a pas de
       * second objet avec lequel entrer en relation. La règle l'a recalé au
       * premier tir sur « The full word is one custom-drawn line of lettering
       * reading as a single shape » — une description parfaitement juste de
       * l'archétype. Une règle écrite pour les constructions à emblème ne
       * s'applique pas à celle qui n'en a pas.
       */
      if (archetype !== 'WORDMARK_PUR' && !RELATION.test(s2)) {
        errors.push(
          `${label}: s2 states no physical relationship between the emblem and the lettering — say what contains what, what passes in front of what, what is larger than what${cite(s2)}`
        )
      }
    }
    // 7. une seule famille de matière + une alternative, reliées par « or »
    if (!MATIERE.test(s2)) {
      // La CITATION est obligatoire (loi du 5.9) : sans le fragment fautif, le
      // modèle réécrit la même phrase au second essai et l'appel est perdu.
      errors.push(
        `${label}: s2 must name exactly ONE material family plus one alternative joined by "or", and the pair must be followed by the word "materials", "finish" or "surfaces" — e.g. "chrome or satin materials", "brushed steel or black lacquer surfaces"${cite(s2)}`
      )
    }
    // 7bis. PIVOT IDIOME — la matière doit parler la langue de la famille.
    //       Sans cette règle, « flat_vector_texture » était une étiquette que
    //       le DA posait sur une phrase au chrome : la famille ne changeait
    //       rien au rendu.
    if (FAMILLES_PLATES.has(famille)) {
      const relief = s2.match(MOTS_RELIEF)
      if (relief) {
        errors.push(
          `${label}: famille_rendu is "${famille}" but s2 names reflective metal or relief${cite(relief[0])} — those belong to chrome_3d only. Flat families use flat paint, vinyl, screenprint, duotone. Suggested: ${FAMILLE_RENDU_DEFINITIONS[famille].matiere}`
        )
      }
    }
    if (famille === 'flat_vector_texture' && !MOTS_TEXTURE.test(s2)) {
      errors.push(
        `${label}: famille_rendu is "flat_vector_texture" but s2 names no texture — this family IS the texture laid over the flat shapes. Name one: halftone dot screen, grain, scanlines, technical grid${cite(s2)}`
      )
    }
    if (famille === 'texture_fill' && !MOTS_REMPLISSAGE.test(s2)) {
      errors.push(
        `${label}: famille_rendu is "texture_fill" but s2 never says the matter FILLS the glyph — say what is cut to the letterform's silhouette (city lights, fire, smoke) and that it fills it${cite(s2)}`
      )
    }
    // 7ter. le code écrit déjà les clauses : les répéter les dit deux fois
    const doublon = s2.match(DEJA_DIT_PAR_LE_CODE)
    if (doublon) {
      errors.push(
        `${label}: s2 repeats what the code already appends${cite(doublon[0])} — the outline, the two-colour palette and the framing sentence are added automatically. Spend those words on the construction or the scene`
      )
    }
    // 7ter-bis. UN SUJET, UNE SILHOUETTE — pas d'inventaire de petits éléments
    const detail = s2.match(MICRO_DETAIL)
    if (detail) {
      errors.push(
        `${label}: s2 asks for micro-detail${cite(detail[0])} — one subject, one silhouette. Gears, rivets, ornaments and detailed façades break the mark at small size and are not part of this idiom`
      )
    }
    // 7quater. LE FOND NOMME UNE SCÈNE — jamais « dark atmospheric background »
    const vide = s2.match(FOND_VIDE)
    if (vide && !SCENE_NOMMEE.test(s2)) {
      errors.push(
        `${label}: the background says nothing${cite(vide[0])} — five to eight words naming a REAL scene, the way every reference does. For instance "on a purple night city skyline", "behind a chain-link fence", "on a palm-lined street at night"`
      )
    } else if (!SCENE_NOMMEE.test(s2)) {
      errors.push(
        `${label}: no scene is named in s2 — the background must be a place, not a mood. Five to eight words: a street, a skyline, a fence, palms, a casino, a rooftop, rain on asphalt${cite(s2)}`
      )
    }
    // 8. pas de pile d'adjectifs de finition
    const finitionsVues = [...new Set(FINITIONS.filter((f) => new RegExp(`\\b${f}\\b`, 'i').test(s2)))]
    if (finitionsVues.length > MAX_FINITIONS) {
      errors.push(
        `${label}: s2 stacks ${finitionsVues.length} finish adjectives (${finitionsVues.join(', ')}) — keep at most ${MAX_FINITIONS}`
      )
    }
    // 9. le garde-fou sticker/candy reste (run 5.9) : il n'est plus DEMANDÉ au
    //    prompt sous forme de négations, mais une demande POSITIVE d'un contour
    //    autour du lockup entier reste l'interdit n°1 du corpus.
    const interdit = demandeInterdite(s2)
    if (interdit) errors.push(`${label}: s2 ${interdit}`)

    // 10. les références : 3 slugs, >= 2 gold, tous joignables
    const refsBrutes = Array.isArray(c.refs) ? c.refs : []
    const refs: ConceptRef[] = []
    for (const r of refsBrutes.slice(0, 3)) {
      const slug = String((r as ConceptRef)?.slug ?? '').trim()
      const texte = String((r as ConceptRef)?.label ?? '').trim()
      if (!opts.slugsDisponibles.has(slug)) {
        errors.push(`${label}: reference slug "${slug}" is not in the attachable catalog (unknown, or under the 512 px floor)`)
        continue
      }
      if (refs.some((x) => x.slug === slug)) {
        errors.push(`${label}: reference slug "${slug}" is picked twice — three DIFFERENT references`)
        continue
      }
      if (!texte) {
        errors.push(`${label}: reference "${slug}" has no role label — one English line describing what it is`)
        continue
      }
      refs.push({ slug, label: texte.slice(0, 200) })
    }
    if (refs.length !== 3) {
      errors.push(`${label}: exactly 3 references required, got ${refs.length}`)
    }
    const nbGold = refs.filter((r) => opts.slugsGold.has(r.slug)).length
    if (refs.length === 3 && nbGold < 2) {
      errors.push(
        `${label}: only ${nbGold} of the 3 references are flagged gold — at least 2 must be gold (they carry the quality bar). Gold slugs available: ${[...opts.slugsGold].join(', ')}`
      )
    }
    // REFERENCE 1 porte l'IDIOME : elle est toujours une pièce FiveM/GTA du
    // corpus. E3 a montré ce que coûte l'inverse — quatre concepts sur cinq
    // ont ouvert sur une marque de fruits, et les rendus ont hérité de sa
    // langue au lieu de celle d'un serveur.
    const premier = refs[0]
    if (premier && !opts.slugsFivem.has(premier.slug)) {
      errors.push(
        `${label}: REFERENCE 1 is "${premier.slug}", which is not a FiveM/GTA server piece — reference 1 always carries the idiom (Los Santos street, neon, palms, wet asphalt) and the render inherits its visual language. Pick reference 1 from: ${[...opts.slugsFivem].join(', ')}. "${premier.slug}" may still be used in slot 2 or 3`
      )
    }
    /*
     * REFERENCE 1 parle la LANGUE du concept, pas seulement l'idiome.
     *
     * Correction opérateur du 17/08 : sur `vulcain`, le DA a dessiné une
     * enclume de forgeron — l'objet que le NOM désigne — au lieu de la
     * construction de sa référence, qui n'est QUE des ailes formant un V.
     * L'emblème doit venir de l'image, pas de l'étymologie. On ne sait pas
     * coder « déduit du nom » sans recaler des briefs légitimes ; on peut, et
     * on doit, exiger que la première image montre la famille visée : c'est
     * elle que le rendu copie.
     */
    if (premier && opts.familleParSlug) {
      const familleRef = opts.familleParSlug.get(premier.slug)
      if (familleRef && familleRef !== famille) {
        const eligibles = [...opts.familleParSlug.entries()]
          .filter(([, f]) => f === famille)
          .map(([slug]) => slug)
        errors.push(
          `${label}: REFERENCE 1 "${premier.slug}" is a ${familleRef} piece but the concept is ${famille} — the render copies the FIRST image, so slot 1 must already speak the language you are aiming at. Pick reference 1 from: ${eligibles.join(', ')}`
        )
      }
    }

    /*
     * 11. le blockout — la contrainte de composition, vérifiée en code.
     *
     * Sans lettrage : rien à contraindre, le squelette n'existe pas.
     *
     * PIVOT IDIOME : HERO_MONOGRAM non plus. L'archétype n'a pas d'emblème
     * séparé du lettrage — la lettre EST l'emblème — donc ni l'overlap ni le
     * débordement ne s'y appliquent (E1 l'a mesuré sur le gold set : trois
     * pièces de la barre sortent à 0,000 pour cette raison exacte). Poser un
     * squelette emblème/mot sur un monogramme héros reviendrait à lui demander
     * de cesser d'en être un. La seule garde applicable, et elle l'est : le
     * monogramme doit être MASSIF.
     */
    let blockout: BlockoutSpec | null = null
    let debordement: number | null = null
    // WORDMARK_PUR n'a pas plus d'emblème séparé que HERO_MONOGRAM : le mot EST
    // la marque (E1 l'a mesuré à 0,000 sur le script Sweety Life).
    const blockoutAttendu = !sansLettrage && archetype !== 'HERO_MONOGRAM' && archetype !== 'WORDMARK_PUR'
    if (blockoutAttendu) {
      const blockoutVerdict = validateBlockout((c as { blockout?: unknown }).blockout, { archetype })
      if ('errors' in blockoutVerdict) {
        errors.push(...blockoutVerdict.errors.map((e) => `${label}: ${e}`))
        continue
      }
      blockout = blockoutVerdict.spec
      // P2 : le SECOND critère, mesuré sur les silhouettes rastérisées. Le
      // badge (mot entièrement dans la forme) est recalé ici — l'overlap de
      // bbox, lui, le note au maximum.
      const contrat = await verifieContratBlockout(blockout, mot ?? '', archetype)
      debordement = contrat.mesure.debordement
      if (contrat.errors.length) {
        errors.push(...contrat.errors.map((e) => `${label}: ${e}`))
        continue
      }
    } else if (archetype === 'HERO_MONOGRAM' || archetype === 'WORDMARK_PUR') {
      const brut = (c as { blockout?: unknown }).blockout as Partial<BlockoutSpec> | undefined
      const boite = Array.isArray(brut?.word_bbox) ? (brut.word_bbox as number[]) : null
      // Garde d'ÉCHELLE, la seule qui ait un sens ici : « massive scale » est
      // la définition de l'archétype, donc elle se vérifie.
      if (boite && Number.isFinite(boite[2]) && (boite[2] as number) < HERO_LARGEUR_MIN) {
        errors.push(
          `${label}: ${archetype} means the lettering carries the whole mark — your word_bbox is ${(
            boite[2] as number
          ).toFixed(2)} of the canvas width, under the ${HERO_LARGEUR_MIN} floor. Make it massive, or pick another archetype`
        )
        continue
      }
    }

    const prompt = buildPromptV6(s2, mot, famille)
    const totalMots = wordCount(prompt)
    if (totalMots < PROMPT_MIN_MOTS || totalMots > PROMPT_MAX_MOTS) {
      errors.push(
        `${label}: the assembled prompt is ${totalMots} words, the range is ${PROMPT_MIN_MOTS}-${PROMPT_MAX_MOTS} — shorten or lengthen s2 accordingly`
      )
    }

    concepts.push({
      archetype,
      famille_rendu: famille,
      s2,
      prompt,
      why: String(c.why ?? '').slice(0, 240),
      refs,
      blockout,
      debordement,
    })
  }

  /*
   * 12. DIVERSITÉ (§2). Sans lettrage, les trois concepts partagent le même
   *     archétype : la diversité se joue sur le sujet.
   *
   *     PIVOT IDIOME : la règle « au moins un CONTAINER ou ENTWINED » est
   *     REMPLACÉE par « au moins un HERO_MONOGRAM ». Elle disait, en creux,
   *     que la valeur d'un trio se juge à l'overlap ; c'est précisément ce que
   *     l'opérateur retire. L'idiome réel est majoritairement monogramme.
   */
  if (concepts.length === 3 && !sansLettrage) {
    const vus = concepts.map((c) => c.archetype)
    if (new Set(vus).size !== 3) {
      errors.push(`the 3 concepts must use 3 DIFFERENT archetypes (got ${vus.join(', ')})`)
    }
    const pivots = archetypesPivotPourMot(mot)
    if (pivots.length && !vus.some((a) => (pivots as readonly string[]).includes(a))) {
      errors.push(
        pivots.length === 1
          ? `at least one concept must be ${pivots[0]} — it is the default construction of the FiveM idiom (one to three letters carrying the whole mark)`
          : `"${mot}" is ${compteLettres(mot ?? '')} letters, too long for a monogram: at least one concept must be ${pivots.join(' or ')} — the word itself has to carry the mark`
      )
    }
  }

  // 13. PIVOT IDIOME — chrome_3d est MINORITAIRE, dans tous les cas de figure
  //     (y compris sur un brief sans lettrage, où les archétypes se répètent).
  if (concepts.length === 3) {
    const chrome = concepts.filter((c) => c.famille_rendu === 'chrome_3d').length
    if (chrome > MAX_CHROME_3D) {
      errors.push(
        `${chrome} of the 3 concepts use famille_rendu "chrome_3d" — at most ${MAX_CHROME_3D}. Chrome is a minority register in the FiveM idiom; the majority is flat vector with a texture over it`
      )
    }
    /*
     * Le concept par défaut ne porte pas le registre minoritaire.
     *
     * Relevé sur le premier tir du pivot : sur les deux briefs avec lettrage,
     * le DA a mis chrome_3d sur HERO_MONOGRAM **deux fois sur deux** — le
     * monogramme appelle le métal. Le trio restait conforme (un seul chrome),
     * mais la construction que l'opérateur a désignée comme la cible arrivait
     * systématiquement dans la seule langue qu'il a déclarée minoritaire.
     * Le chrome garde sa place : il va sur une autre construction.
     */
    const pivotsChrome = archetypesPivotPourMot(mot) as readonly string[]
    const pivot = concepts.find((c) => pivotsChrome.includes(c.archetype))
    if (pivot && pivot.famille_rendu === 'chrome_3d') {
      errors.push(
        `the ${pivot.archetype} concept uses famille_rendu "chrome_3d" — that construction carries the idiom for this name and must be shown in its majority language (flat vector with a texture, or a filled glyph). Move chrome_3d onto one of the other two concepts${cite(pivot.s2)}`
      )
    }
    const famillesVues = new Set(concepts.map((c) => c.famille_rendu))
    if (famillesVues.size < 2) {
      errors.push(
        `the 3 concepts all use famille_rendu "${[...famillesVues][0]}" — use at least two different rendering families so the client sees real alternatives`
      )
    }
  }

  return errors.length ? { errors } : { concepts }
}

// ── §3 — LE SYSTÈME PROMPT ───────────────────────────────────────────────────

export function buildDirectorSystemV6(mot: string | null): string {
  const motAffiche = mot ?? 'WORD'
  const sansLettrage = mot === null
  const rotation = rotationPourMot(mot)
  const pivots = archetypesPivotPourMot(mot)
  const vocabulaire = rotation
    .map((nom) => `  ${nom.padEnd(14)}${ARCHETYPE_DEFINITIONS[nom].relation}`)
    .join('\n')

  // ── Brief SANS LETTRAGE : les archétypes décrivent tous une relation à un
  //    mot. Sans mot, la seule construction est l'emblème lui-même, et la
  //    diversité se joue sur le SUJET, pas sur la géométrie du lockup.
  const blocConstruction = sansLettrage
    ? `## Construction
This brief carries NO lettering at all: the image is a pure pictorial emblem.
Set "archetype" to "${ARCHETYPE_SANS_LETTRAGE}" on all three concepts.
The three concepts must differ by their SUBJECT and their silhouette — three genuinely
different emblems, not three finishes of the same shape. Sentence S2 describes the emblem
itself: what it depicts, how the forms interlock, what the silhouette reads as at small size.`
    : `## Construction vocabulary — pick from this closed list
${vocabulaire}

The three concepts MUST use three DIFFERENT archetypes.
At least one concept must be ${pivots.join(' or ')}.
"${motAffiche}" is ${compteLettres(mot ?? '')} letters. ${
        compteLettres(mot ?? '') <= HERO_MONOGRAM_MAX_LETTRES
          ? `Short enough for a monogram, which is the DEFAULT construction of this idiom: real FiveM marks are mostly one to three letters carrying the whole thing.`
          : `Too long for a monogram — HERO_MONOGRAM is capped at ${HERO_MONOGRAM_MAX_LETTRES} letters, because past that the model stacks the word on two lines and it stops being one. The word itself has to carry the mark.`
      }`

  const blocBlockout = sansLettrage
    ? `## Blockout
None. There is no lettering, so there is no composition skeleton to constrain.
Omit the "blockout" field entirely.`
    : `## Blockout
Omit the "blockout" field entirely on a HERO_MONOGRAM or WORDMARK_PUR concept: there the
lettering IS the mark, so there is no emblem-versus-word geometry to lay out. For the other
archetypes, output the geometry of a composition skeleton that code will draw locally.
Normalized coordinates on a 1:1 canvas, origin top-left.
  emblem_shape: ${BLOCKOUT_SHAPES.join(' | ')}
  emblem_bbox:  [x, y, w, h]
  word_bbox:    [x, y, w, h]
The typeface is NOT yours to choose — code always draws the blockout in one fixed
grotesque (${BLOCKOUT_FONT}). The blockout carries geometry only; the typographic style comes
from references 1-3.
TWO measurements are computed on it, in code, and both must pass:
  1. overlap = intersection of the two boxes divided by word_bbox area
     >= ${plancherOverlap('CONTAINER')} for CONTAINER and ENTWINED, >= ${plancherOverlap('CREST')} for the others.
  2. overflow = the share of the WORD's silhouette that falls OUTSIDE the emblem's filled
     silhouette. For CONTAINER and ENTWINED it must land between ${DEBORDEMENT_MIN} and ${DEBORDEMENT_MAX}.
     Overflow 0 means the word sits entirely on the shape — that is a badge, a sticker plate,
     and it is rejected. The lettering must BREAK the emblem's silhouette: it runs past the
     contour at the ends, or occupies a hollow the shape frames — like NEXT LAND crossing its
     red triangle, and unlike a word laid on a disc.`

  return `You are the art director of a logo engine for FiveM / GTA RP servers.
Your entire creative output is ONE SENTENCE per concept. Everything else is fixed by code.

## What you are given
- BRIEF: the customer's own words, verbatim (server name, theme, mood, material, colors, bans).
- GOLD PIECES: the reference logos that define the quality bar.
- REFERENCE CATALOG: available reference images with their style labels and gold flag.

## The only thing you write
For each of 3 concepts, sentence S2 of this fixed skeleton:

  S1  ${phraseS1(mot)}
  S2  <YOUR SENTENCE>
  S3  ${phraseS3(mot)}

S2 must be ${S2_MIN_MOTS} to ${S2_MAX_MOTS} words and contain exactly three things, in this order:
  1. THE CONSTRUCTION — how the shapes hold together. On ${ARCHETYPE_DEFAUT}: what the
     letterform is cut from, what it fuses with, what its silhouette reads as. On the other
     archetypes: what contains what, what passes in front of what, what is larger than what.
  2. THE MATERIAL — exactly one material family plus one alternative, joined by "or",
     and the pair MUST be followed by the word "materials", "finish" or "surfaces".
     It must belong to the rendering family you picked (see below). Each family may be one
     or two words. Never stack three finishes.
  3. THE BACKGROUND — five to eight words, and it must NAME A PLACE.
     "on a dark atmospheric background" says nothing: it is the weakest piece this engine has
     produced. Every reference has a real scene. Write one:
       "on a purple night city skyline"   "behind a chain-link fence"
       "on a palm-lined street at night"  "outside a neon casino in the rain"
     A place, not a mood. The LOOK of that scene still comes from REFERENCE 1 — you name it,
     the image renders it.

## The idiom you are writing in — read this before anything else
Real FiveM server logos are NOT loading-screen artwork. They are:
  - monograms of ONE to THREE letters, far more often than wordmarks;
  - FLAT vector, with a thick black keyline, very little 3D chrome;
  - a texture laid over the flat shapes: halftone dot screen, grain, scanlines, grid;
  - or a glyph FILLED with a matter cut to its silhouette (city, light, mountains);
  - duotone — two colours, no third;
  - a full-bleed background that is dark and LOW-CONTRAST (palms, city, chain-link).
Anything that reads as polished chrome floating over neon palms is a GTA V loading screen,
not a server logo. That register is available as one concept out of three, never more.

## Rendering families — pick ONE per concept, closed list
${(Object.entries(FAMILLE_RENDU_DEFINITIONS) as Array<[FamilleRendu, { quoi: string; matiere: string; gold: string }]>)
  .map(([nom, d]) => `  ${nom}\n     ${d.quoi}\n     material phrasing: ${d.matiere}\n     gold: ${d.gold}`)
  .join('\n')}

  - use at least TWO different families across the 3 concepts;
  - "chrome_3d" at most ${MAX_CHROME_3D} concept out of 3, and NEVER on the ${ARCHETYPE_DEFAUT}
    concept: that construction is the default of the idiom and must be shown in its majority
    language. Put the chrome one on another construction;
  - on "flat_vector_texture", code AUTOMATICALLY appends this sentence to the prompt:
      "${CLAUSE_FAMILLE.flat_vector_texture}"
    The thick black outline and the two-colour palette are the definition of the family, not
    options — do NOT write them yourself, they would be said twice. Use those words for the
    construction and the scene instead;
  - on EVERY concept, code also appends:
      "${CLAUSE_CADRAGE}"
    Same rule: do not write it yourself. It also means your scene is a SETTING, not a subject —
    it sits back, dark and desaturated, and the mark owns the frame.
  - on a flat family, naming chrome, metallic, reflective, bevel, extrusion, glass or 3D
    invalidates the concept — those words belong to chrome_3d alone;
  - "flat_vector_texture" must NAME its texture (halftone, grain, scanlines, grid);
  - "texture_fill" must say the matter FILLS the glyph.

${blocConstruction}

## The emblem comes from the REFERENCE, never from the name
Do not translate the server's name into the object it denotes, and do not stage a little scene
of the brief's nouns. A server called Vulcain does not get a blacksmith's anvil; the reference
that carries that name is nothing but a pair of wings cut into a V, one single silhouette. A
server called Nox does not get a moon-and-owl tableau.
  - ONE fused shape, not two objects meeting. "wings wrapping around an anvil" is two objects,
    and so is "an anvil whose sides stretch into wings" — the anvil is still the base form.
    "a V whose arms open into wings" is one shape.
  - ONE subject, ONE silhouette. No gears, rivets, bolts, ornaments, scrollwork, detailed
    façades, no inventory of small parts. Those shatter the mark at small size, and the idiom
    has none of them.
  - when the brief lists several subject words, S2 keeps EXACTLY ONE of them: the one that
    gives a silhouette. "wings, forge" gives WINGS — a forge is a mood, not a shape. Drop the
    rest. The dropped words still live in the render through the material and the scene.
  - the brief's subject words tell you WHAT it evokes; REFERENCE 1 tells you HOW it is built.
    When they disagree, the image wins — it is the thing the render actually copies.

## Absolute bans on S2
- No hex codes. No color names taken from the customer picker. Colors are handled after rendering.
- No negative clause of any kind. Never write "no", "without", "avoid", "not".
- No stacked finish adjectives (speculars, frosted, matte extrusion, bevels, polished edges).
- No French. English only. A single French word invalidates the concept.
- No background texture inventory. Three to five words, never a list of motifs.
- Never describe the emblem as "placed on", "next to", "beside", "sitting on" a letter.
  The emblem must contain, cross, wrap or carry the lettering.

## Reference selection — the order of the slots is a rule, not a preference
The render learns its visual language from the FIRST attached reference.

  REFERENCE 1  ALWAYS a piece flagged FIVEM in the catalog, and its famille_rendu MUST MATCH
               the family of the concept — this is checked in code. It is no longer an
               inspiration: the render is told to MATCH IT EXACTLY — same construction, same
               texture, same background treatment, same level of detail, only the glyph
               changes. Pick it accordingly: the piece you would be happy to see copied.
               Your label for it is replaced by that instruction, so keep your own wording
               short.
  REFERENCE 2  the construction or the material you are aiming at.
  REFERENCE 3  free.

  - at least 2 of the 3 must be flagged GOLD (they carry the quality bar)
  - a piece that is not flagged FIVEM is fine in slot 2 or 3 — never in slot 1,
    whatever its quality. A brand from outside gaming teaches another language.
  - each gets a one-line role label describing what it is, in English

${blocBlockout}

## Output — JSON only, no prose, no markdown fence, no comments inside the JSON
"concepts" is an array of EXACTLY THREE objects. The shape of one is shown below; ship three.
${sansLettrage ? '' : `Concepts whose archetype is ${ARCHETYPE_DEFAUT} carry NO "blockout" field at all.\n`}
{
  "concepts": [
    {
      "archetype": "${sansLettrage ? ARCHETYPE_SANS_LETTRAGE : ARCHETYPE_DEFAUT}",
      "famille_rendu": "${FAMILLE_RENDU_DEFAUT}",
      "s2": "...",
      "why": "one short line, French, for the operator log",
      "refs": [{"slug": "...", "label": "REFERENCE 1 — ..."}, {"slug": "...", "label": "REFERENCE 2 — ..."}, {"slug": "...", "label": "REFERENCE 3 — ..."}]${
        sansLettrage
          ? ''
          : ',\n      "blockout": {"emblem_shape": "circle", "emblem_bbox": [0.12, 0.12, 0.76, 0.76], "word_bbox": [0.06, 0.42, 0.88, 0.16]}'
      }
    }
  ]
}
${
  sansLettrage
    ? 'There is NO word: the image carries no text of any kind. Sentences S1 and S3 already state it.'
    : `The word is "${motAffiche}" — do not repeat it in S2, sentences S1 and S3 already carry it.`
}`
}

// Le contrat de sortie en JSON Schema — utilisé par l'adaptateur Claude
// (sorties structurées : plus jamais de JSON tronqué). Les bornes fines
// (longueurs, cardinalités) restent au validateur, qui sait les CITER.
export const CONCEPTS_SCHEMA_V6: Record<string, unknown> = {
  type: 'object',
  properties: {
    concepts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          archetype: { type: 'string', enum: [...ARCHETYPES, ARCHETYPE_SANS_LETTRAGE] },
          famille_rendu: { type: 'string', enum: [...FAMILLES_RENDU] },
          s2: { type: 'string' },
          why: { type: 'string' },
          refs: {
            type: 'array',
            items: {
              type: 'object',
              properties: { slug: { type: 'string' }, label: { type: 'string' } },
              required: ['slug', 'label'],
              additionalProperties: false,
            },
          },
          // P3 : word_font n'est plus une variable — le blockout ne porte que
          // la géométrie, la police est une constante de code.
          blockout: {
            type: 'object',
            properties: {
              emblem_shape: { type: 'string', enum: [...BLOCKOUT_SHAPES] },
              emblem_bbox: { type: 'array', items: { type: 'number' } },
              word_bbox: { type: 'array', items: { type: 'number' } },
            },
            required: ['emblem_shape', 'emblem_bbox', 'word_bbox'],
            additionalProperties: false,
          },
        },
        // blockout absent = brief sans lettrage, ou concept HERO_MONOGRAM
        // (le letterform EST l'emblème : aucune géométrie à poser)
        required: ['archetype', 'famille_rendu', 's2', 'why', 'refs'],
        additionalProperties: false,
      },
    },
  },
  required: ['concepts'],
  additionalProperties: false,
}

// ── l'appel ──────────────────────────────────────────────────────────────────

export async function directLogoConceptsV6(opts: {
  project: ProjectLike
  da: ArtDirection
  answers: LogoAnswersV3
  energie?: number
  modernite?: number
  /** §8 : bascule le DA sur Claude Opus 5 quand la clé est configurée */
  moteur?: 'gemini' | 'claude'
  log: { userId: string; projectId?: string | null; assetId?: string | null }
}): Promise<LogoDirectorV6Result> {
  const startedAt = Date.now()
  const { project, da, answers } = opts

  const brief = renderLogoBrief({
    projectName: project.name,
    answers,
    mappingPalette: da.palette,
    universeLabel: UNIVERSE_LABELS[da.universe],
  })

  const catalogue = listReferenceCatalogue('logo')
  const slugsDisponibles = new Set(catalogue.map((c) => c.slug))
  const slugsGold = new Set(catalogue.filter((c) => c.gold).map((c) => c.slug))
  const slugsFivem = new Set(catalogue.filter((c) => c.fivem).map((c) => c.slug))

  const mot =
    answers.type === 'nom'
      ? project.name.trim().toUpperCase()
      : answers.type === 'lettre'
        ? (project.name.trim()[0] ?? 'N').toUpperCase()
        : null

  const catalogueBlock = [
    'REFERENCE CATALOG — every image below is attachable (>= 512 px native). Pick 3 slugs per concept: slot 1 MUST be flagged FIVEM, and at least 2 of the 3 must be flagged GOLD.',
    ...catalogue.map((c) => {
      const morceaux = [
        c.fivem ? 'FIVEM' : null,
        c.gold ? 'GOLD' : null,
        c.famille_rendu,
        c.construction,
        c.traitement,
        c.matiere,
        c.embleme ? `emblem: ${c.embleme}` : null,
        c.ambiance,
      ].filter(Boolean)
      return `- ${c.slug} [${morceaux.join(' · ')}]`
    }),
  ].join('\n')

  /*
   * PIVOT IDIOME — le bloc GOLD est DÉRIVÉ des fichiers, plus jamais écrit en
   * dur. La version précédente citait nommément Fruitz, ALYA, South District et
   * Sweety Life : elles sont sorties du corpus de références le 17/08, et un
   * texte figé les aurait fait vivre dans le prompt après leur retrait des
   * données. Une seule source de vérité : `_gold-set.json` + `_fivem-set.json`.
   */
  const idiome = idiomeParSlug()
  const goldBlock = [
    'GOLD PIECES — the quality bar. Every one of them is a real FiveM/GTA server mark:',
    ...catalogue
      .filter((c) => c.gold)
      .map((c) => {
        const info = idiome.get(c.slug)
        const morceaux = [
          c.fivem ? 'FIVEM' : null,
          info?.famille_rendu,
          info?.construction,
          c.matiere,
          c.embleme ? `emblem: ${c.embleme}` : null,
        ].filter(Boolean)
        return `- ${c.slug} [${morceaux.join(' · ')}]`
      }),
  ].join('\n')

  const ambianceTag = answers.ambiance ? LOGO_AMBIANCE_TAG[answers.ambiance] : null
  const prompt = [
    'LOGO BRIEF (from the client wizard — verbatim user words included):',
    brief,
    ambianceTag ? `MOOD TAG: ${ambianceTag}` : '',
    goldBlock,
    catalogueBlock,
    'Now think, then deliver the 3 concepts as specified. JSON only.',
  ]
    .filter(Boolean)
    .join('\n\n')

  const systemInstruction = buildDirectorSystemV6(mot)
  const moteur = opts.moteur ?? (claudeDisponible() ? 'claude' : 'gemini')
  const modele = moteur === 'claude' ? 'claude-opus-5' : ENGINE_MODELS.logoDirector

  let usage: GeminiUsage = { tokensIn: 0, tokensOut: 0 }
  const track = (u: GeminiUsage) => {
    usage = { tokensIn: usage.tokensIn + u.tokensIn, tokensOut: usage.tokensOut + u.tokensOut }
  }

  let lastErrors: string[] = []
  let dernierBrut = ''
  let dernierFinish = ''

  // 2 tentatives : la seconde reçoit les erreurs du validateur, CITÉES.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const demande =
      attempt === 0
        ? prompt
        : `${prompt}\n\nYOUR PREVIOUS ANSWER WAS REJECTED BY THE STRUCTURAL VALIDATOR: ${lastErrors.join('; ')}. Fix precisely these points and answer again with the full JSON.`

    const raw =
      moteur === 'claude'
        ? await directWithClaude<unknown>({
            prompt: demande,
            systemInstruction,
            schema: CONCEPTS_SCHEMA_V6,
            onUsage: track,
          })
        : await geminiJson<unknown>({
            model: ENGINE_MODELS.logoDirector,
            prompt: demande,
            systemInstruction,
            temperature: 0.8,
            /*
             * Le thinking mange le MÊME budget que la sortie (piège n°5).
             * 6000 → 9000 → 14000 au fil des runs ; 14000 a lâché le 17/08 sur
             * le système du pivot, plus long d'un tiers (familles de rendu +
             * bloc idiome) : `candidatesTokenCount` à 843 et un JSON coupé net
             * au milieu d'un slug. Le compteur de sortie ne voit PAS le
             * raisonnement — il ne peut donc pas servir d'alerte, et c'est
             * `finishReason: MAX_TOKENS` qui le dit (câblé ci-dessous).
             */
            maxOutputTokens: 32000,
            thinkingLevel: LOGO_THINKING_LEVEL,
            onUsage: track,
            onParseError: (brut) => {
              dernierBrut = brut
            },
            onFinishReason: (r) => {
              dernierFinish = r
            },
          })

    // Le JSON n'a pas parsé : on le DIT, avec le début de la réponse. Sinon
    // l'appelant ne voit qu'un « exactly 3 concepts required » qui accuse le
    // modèle d'avoir mal compté alors qu'il a rendu du texte illisible.
    if (raw === null && dernierBrut) {
      console.warn(
        `[DA v6] réponse non parsable (tentative ${attempt + 1}, finishReason ${
          dernierFinish || 'absent'
        }, sortie ${usage.tokensOut} tokens) — début brut : ${dernierBrut.slice(0, 300)}`
      )
    }

    const verdict = await validateConceptsV6(raw, {
      answers,
      projectName: project.name,
      slugsDisponibles,
      slugsGold,
      slugsFivem,
      familleParSlug: new Map([...idiome].map(([slug, info]) => [slug, info.famille_rendu])),
    })
    if ('concepts' in verdict) {
      void logGeneration({
        userId: opts.log.userId,
        projectId: opts.log.projectId ?? null,
        assetId: opts.log.assetId ?? null,
        kind: 'logo_director_v6',
        model: modele,
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        retried: attempt > 0,
        durationMs: Date.now() - startedAt,
      })
      return { concepts: verdict.concepts, usage, durationMs: Date.now() - startedAt, modele }
    }
    lastErrors = verdict.errors
  }

  void logGeneration({
    userId: opts.log.userId,
    projectId: opts.log.projectId ?? null,
    assetId: opts.log.assetId ?? null,
    kind: 'logo_director_v6_failed',
    model: modele,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    retried: true,
    durationMs: Date.now() - startedAt,
  })
  throw new Error(
    `Le directeur artistique v6 n'a pas produit 3 concepts valides (${lastErrors.slice(0, 6).join('; ')}) — relance la génération.${
      dernierBrut ? `\nDernière réponse brute, non parsable : ${dernierBrut.slice(0, 600)}` : ''
    }`
  )
}
