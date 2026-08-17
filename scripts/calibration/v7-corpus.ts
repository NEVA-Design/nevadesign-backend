/*
 * Run 7 — PHASE 1 : extraire les règles du corpus.
 *
 * Le moteur v6 joignait 3 images par appel. Il y en a 212 dans le dossier de
 * l'opérateur. Cette phase les passe TOUTES, par lots de 10, sur
 * gemini-3.5-flash à température 0, et en sort des médianes qui deviennent des
 * BORNES DURES pour les phases suivantes — elles remplacent toutes les consignes
 * rédigées des sessions précédentes.
 *
 *   bun run scripts/calibration/v7-corpus.ts --dry        # inventaire, 0 €
 *   bun run scripts/calibration/v7-corpus.ts              # la passe complète
 *   bun run scripts/calibration/v7-corpus.ts --agrege     # agrège le JSONL existant
 *
 * Deux choses sont mesurées EN CODE, pas demandées au modèle :
 *  - `ratio_marque_cadre` : dérivé de la boîte box_2d (piège n°12 — jamais de
 *    [x,y,w,h] en 0..1) ; une estimation de surface au jugé est du bruit ;
 *  - `luminance_fond` / `contraste_fond` réels : sharp, sur les pixels HORS de
 *    la boîte de la marque. Le champ du modèle est conservé à côté, sous un
 *    autre nom, pour qu'on voie l'écart entre les deux instruments.
 *
 * Le JSONL est écrit APRÈS CHAQUE LOT (piège n°22, version texte) : une passe
 * interrompue au lot 18 ne repaie pas les 17 premiers.
 */

import { existsSync, appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { installBudgetGuard, setBudgetLabel, setPhase, spentForPhase, PLAFONDS_PHASE, V7_DIR, PhaseBudgetError } from './budget7'
import {
  arrondi,
  box2dValide,
  dimensionne,
  distribution,
  estNeutre,
  familleTeinte,
  inventaireCorpus,
  jointure,
  mediane,
  mesureFond,
  mesureMasseMarque,
  modalite,
  partTransparente,
  quantile,
  ratiosBox,
  resume,
  type Box2d,
  type PieceCorpus,
  type Resume,
} from './v7-lib'
import { geminiMultimodal, type GeminiPart } from '../../src/lib/ai/gemini'

installBudgetGuard()
setPhase('p1-corpus')
setBudgetLabel('p1-corpus')

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const agregeSeul = args.includes('--agrege')
const valeur = (nom: string): string | null => {
  const i = args.indexOf(nom)
  return i >= 0 ? (args[i + 1] ?? null) : null
}
const TAILLE_LOT = Number(valeur('--lot') ?? '10')
/*
 * Deux planchers différents, et c'est délibéré.
 *
 * MIN_PX_ANALYSE = 64 : on analyse TOUT, même les 23 vignettes Discord de 96 et
 * 128 px que le run 5.9 avait identifiées comme la source de la dérive
 * candy/sticker. Elles ne coûtent que trois lots de flash.
 *
 * PLANCHER_BORNES = 200 : mais les BORNES ne se calculent que sur ce qui est
 * observable. À 96 px, la différence entre un contour fin et un contour épais,
 * ou la présence d'une trame halftone, n'existe pas dans l'image — la relever
 * revient à inventer une valeur puis à la faire voter. Les deux jeux de bornes
 * sont publiés côte à côte dans corpus-regles.json : le choix se lit sur l'écart
 * mesuré, il ne se plaide pas.
 */
const MIN_PX_ANALYSE = 64
const PLANCHER_BORNES = 200

const RACINE_CORPUS = resolve(import.meta.dir, '../../../entrainement IA fivem')
const JSONL = join(V7_DIR, 'corpus-analyse.jsonl')
const REGLES = join(V7_DIR, 'corpus-regles.json')
const MODELE = 'gemini-3.5-flash'

/*
 * Les trois dossiers qui portent une marque ISOLÉE. Ce n'est pas un tri de
 * goût : c'est le fait, côté code, qu'une bannière Discord ou un character
 * design ne se mesure pas sur les mêmes axes qu'un logo. Le ratio marque/cadre
 * d'un logo carré tourne autour de 30-40 % ; celui d'une bannière 16:9 autour
 * de 5 %. Mélanger les deux produit une médiane qui ne décrit aucune des deux
 * populations — et cette médiane est justement ce qui va piloter l'échelle de
 * composition de la phase 5.
 * Les 212 pièces sont TOUTES analysées et TOUTES publiées ; ce sous-ensemble ne
 * décide que des BORNES.
 */
const DOSSIERS_MARQUE = new Set(['logo serveur fivem gtarp', 'icon', 'PackPsd'])

mkdirSync(V7_DIR, { recursive: true })

// ─── Inventaire ──────────────────────────────────────────────────────────────

const inv = inventaireCorpus(RACINE_CORPUS, ['logo serveur fivem gtarp', 'icon', 'PackPsd'])
const { gardees, ecartees: tropPetites } = await dimensionne(inv.pieces, MIN_PX_ANALYSE)
const ecartees = [...inv.ecartees, ...tropPetites]

console.log(`\n═══ PHASE 1 — corpus « entrainement IA fivem » ═══`)
console.log(`  fichiers trouvés      : ${inv.pieces.length + inv.ecartees.length}`)
console.log(`  écartés               : ${ecartees.length}`)
for (const [raison, n] of Object.entries(distribution(ecartees.map((e) => e.raison.split(' de ')[0]!.split(' :')[0]!)))) {
  console.log(`      ${raison} : ${n}`)
}
console.log(`  ANALYSABLES           : ${gardees.length}`)
console.log(`  dont porteuses d'une marque isolée : ${gardees.filter((p) => DOSSIERS_MARQUE.has(p.categorie)).length}`)
for (const [cat, n] of Object.entries(distribution(gardees.map((p) => p.categorie)))) {
  console.log(`      ${cat} : ${n}`)
}

// ─── Le relevé du modèle ─────────────────────────────────────────────────────

type ReleveModele = {
  piece: number
  type: string | null
  nb_elements_distincts: number | null
  nb_couleurs: number | null
  contour: string | null
  contour_couleur: string | null
  trame: string | null
  luminance_fond: number | null
  contraste_fond: number | null
  marque_box_2d: unknown
  palette: unknown
  fond_type: string | null
}

export type PieceMesuree = {
  slug: string
  chemin: string
  categorie: string
  largeur: number
  hauteur: number
  porte_une_marque: boolean
  type: string
  nb_elements_distincts: number | null
  nb_couleurs: number | null
  contour: string
  contour_couleur: string | null
  trame: string
  fond_type: string
  palette: string[]
  // déclaré par le modèle, 0-100
  luminance_fond_declaree: number | null
  contraste_fond_declare: number | null
  // MESURÉ en code, 0..1, hors boîte de la marque
  luminance_fond: number
  contraste_fond: number
  saturation_fond: number
  // dérivé en code de la boîte
  box_2d: Box2d | null
  ratio_marque_cadre: number | null
  cote_marque_cadre: number | null
  box_invalide: boolean
  /** Ajouté à l'agrégation, en local : > 0,5 = la pièce n'a pas de fond. */
  part_transparente?: number
  /** Ajouté à l'agrégation, en local : la compacité de la marque. */
  taux_remplissage_boite?: number | null
  masse_mesurable?: boolean
  /** Ajouté à l'agrégation, en local : part NEUTRE de l'encre de la marque. */
  part_neutre_marque?: number | null
}

const TYPES = new Set(['monogramme', 'wordmark', 'emblem_only', 'lockup', 'aucune_marque'])
const CONTOURS = new Set(['none', 'fin', 'epais'])
const TRAMES = new Set(['none', 'halftone', 'grain', 'scanlines', 'grille'])
const FONDS = new Set(['uni', 'scene_floue', 'scene_nette', 'texture', 'degrade'])

const CONSIGNE = `You are a measuring instrument, not a critic. Each image below is a piece from a corpus of FiveM / GTA RP server graphics. For EACH image, report objective measurements about THE MARK it carries — the logo, emblem or lettering that identifies the server.

Return ONE JSON object: {"pieces": [ ... ]} with exactly one entry per image, in the order given, each entry holding:

"piece": integer — the PIECE number written immediately before the image.
"type": "monogramme" | "wordmark" | "emblem_only" | "lockup" | "aucune_marque"
    monogramme  = 1 to 3 letters used as the whole mark
    wordmark    = the full name drawn as lettering, no separate emblem
    emblem_only = a symbol, zero lettering
    lockup      = an emblem AND lettering together
    aucune_marque = no identifying mark at all (plain background, character art, screenshot)
"nb_elements_distincts": integer — how many SEPARATED shapes compose the mark. A letter B is 1. A moon plus a word plus a halftone panel is 3. Shapes that touch, overlap or are cut out of one another count as ONE.
"nb_couleurs": integer — distinct colours of the mark itself, background excluded, outline colour excluded. A flat white mark is 1. A white mark with one cyan accent is 2.
"contour": "none" | "fin" | "epais" — outline drawn around the mark: none, thin hairline, thick heavy keyline.
"contour_couleur": hex string of that outline, or null when contour is "none".
"trame": "none" | "halftone" | "grain" | "scanlines" | "grille" — texture laid over or inside the mark.
"luminance_fond": integer 0-100 — how bright the background is (0 = pure black, 100 = pure white).
"contraste_fond": integer 0-100 — how much the background varies (0 = one perfectly flat tone, 100 = harsh black to white).
"marque_box_2d": [ymin, xmin, ymax, xmax] as INTEGERS between 0 and 1000, the tight bounding box of the mark. Use null when type is "aucune_marque".
"palette": array of 2 or 3 hex strings — the dominant colours of the mark.
"fond_type": "uni" | "scene_floue" | "scene_nette" | "texture" | "degrade"

Rules: measure what is drawn, never what would look good. Use null for a field you cannot measure. JSON only, no prose, no markdown.`

async function analyseLot(lot: PieceCorpus[]): Promise<ReleveModele[] | null> {
  const parts: GeminiPart[] = [{ text: CONSIGNE }]
  for (let i = 0; i < lot.length; i += 1) {
    parts.push({ text: `PIECE ${i + 1} — file "${lot[i]!.slug}", native ${lot[i]!.largeur}x${lot[i]!.hauteur}:` })
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: await jointure(lot[i]!.chemin, 512, 82) } })
  }
  parts.push({ text: `Now return the JSON object with exactly ${lot.length} entries.` })

  let finish = ''
  const texte = await geminiMultimodal({
    model: MODELE,
    parts,
    temperature: 0,
    maxOutputTokens: 12000,
    json: true,
    thinkingBudget: 0,
    onFinishReason: (r) => {
      finish = r
    },
  })
  try {
    const parsed = JSON.parse(texte) as { pieces?: ReleveModele[] }
    if (!Array.isArray(parsed.pieces)) throw new Error('champ pieces absent')
    return parsed.pieces
  } catch (err) {
    console.log(
      `      ⚠ JSON illisible (${(err as Error).message})${finish === 'MAX_TOKENS' ? ' — TRONQUÉ, finishReason MAX_TOKENS' : ` — finishReason ${finish}`} : ${texte.slice(0, 200)}`
    )
    return null
  }
}

function normalise(r: ReleveModele, p: PieceCorpus): Omit<PieceMesuree, 'luminance_fond' | 'contraste_fond' | 'saturation_fond'> {
  const box = box2dValide(r.marque_box_2d) ? (r.marque_box_2d as Box2d) : null
  const boxDemandee = r.marque_box_2d !== null && r.marque_box_2d !== undefined
  const ratios = box ? ratiosBox(box) : null
  const type = TYPES.has(r.type ?? '') ? r.type! : 'inconnu'
  return {
    slug: p.slug,
    chemin: p.chemin,
    categorie: p.categorie,
    largeur: p.largeur,
    hauteur: p.hauteur,
    porte_une_marque: DOSSIERS_MARQUE.has(p.categorie) && type !== 'aucune_marque' && type !== 'inconnu',
    type,
    nb_elements_distincts: typeof r.nb_elements_distincts === 'number' ? Math.round(r.nb_elements_distincts) : null,
    nb_couleurs: typeof r.nb_couleurs === 'number' ? Math.round(r.nb_couleurs) : null,
    contour: CONTOURS.has(r.contour ?? '') ? r.contour! : 'inconnu',
    contour_couleur: typeof r.contour_couleur === 'string' ? r.contour_couleur.toLowerCase() : null,
    trame: TRAMES.has(r.trame ?? '') ? r.trame! : 'inconnu',
    fond_type: FONDS.has(r.fond_type ?? '') ? r.fond_type! : 'inconnu',
    palette: Array.isArray(r.palette) ? r.palette.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase()) : [],
    luminance_fond_declaree: typeof r.luminance_fond === 'number' ? r.luminance_fond : null,
    contraste_fond_declare: typeof r.contraste_fond === 'number' ? r.contraste_fond : null,
    box_2d: box,
    ratio_marque_cadre: ratios ? ratios.aire : null,
    cote_marque_cadre: ratios ? ratios.cote : null,
    box_invalide: boxDemandee && !box,
  }
}

// ─── La passe ────────────────────────────────────────────────────────────────

function dejaFaites(): Set<string> {
  if (!existsSync(JSONL)) return new Set()
  const vus = new Set<string>()
  for (const l of readFileSync(JSONL, 'utf-8').split('\n')) {
    if (!l.trim()) continue
    try {
      vus.add((JSON.parse(l) as PieceMesuree).slug)
    } catch {
      /* ligne partielle en fin de fichier : on la réanalysera */
    }
  }
  return vus
}

if (!dry && !agregeSeul) {
  const vus = dejaFaites()
  const aFaire = gardees.filter((p) => !vus.has(p.slug))
  console.log(`\n  déjà analysées (JSONL) : ${vus.size} · à analyser : ${aFaire.length}`)
  console.log(`  plafond de phase : ${PLAFONDS_PHASE['p1-corpus']!.toFixed(2)} € · dépensé : ${spentForPhase('p1-corpus').toFixed(4)} €\n`)

  let lot = 0
  let echecs = 0
  for (let i = 0; i < aFaire.length; i += TAILLE_LOT) {
    const tranche = aFaire.slice(i, i + TAILLE_LOT)
    lot += 1
    process.stdout.write(`  lot ${lot} (${tranche.length} pièces)… `)
    let releves: ReleveModele[] | null = null
    try {
      releves = await analyseLot(tranche)
      // Un lot illisible se rejoue une fois, coupé en deux : la cause la plus
      // fréquente est une sortie trop longue, pas un gabarit fautif.
      if (!releves && tranche.length > 2) {
        const a = await analyseLot(tranche.slice(0, Math.ceil(tranche.length / 2)))
        const b = await analyseLot(tranche.slice(Math.ceil(tranche.length / 2)))
        if (a && b) {
          releves = [...a, ...b.map((r) => ({ ...r, piece: (r.piece ?? 0) + Math.ceil(tranche.length / 2) }))]
        }
      }
    } catch (err) {
      if (err instanceof PhaseBudgetError) {
        console.log(`\n  ⛔ ${err.message}`)
        break
      }
      console.log(`\n      ⚠ appel en échec : ${(err as Error).message}`)
    }
    if (!releves) {
      echecs += tranche.length
      console.log('ÉCHEC')
      continue
    }

    const lignes: string[] = []
    for (let k = 0; k < tranche.length; k += 1) {
      const p = tranche[k]!
      const r = releves.find((x) => x.piece === k + 1) ?? releves[k]
      if (!r) {
        echecs += 1
        continue
      }
      const base = normalise(r, p)
      const fond = await mesureFond(p.chemin, base.box_2d ?? undefined)
      const mesuree: PieceMesuree = {
        ...base,
        luminance_fond: fond.luminance,
        contraste_fond: fond.contraste,
        saturation_fond: fond.saturation,
      }
      lignes.push(JSON.stringify(mesuree))
    }
    appendFileSync(JSONL, `${lignes.join('\n')}\n`)
    console.log(`ok (${lignes.length}) · ${spentForPhase('p1-corpus').toFixed(4)} €`)
  }
  console.log(`\n  pièces sans relevé : ${echecs}`)
}

// ─── Agrégation ──────────────────────────────────────────────────────────────

if (dry) {
  console.log('\n  --dry : aucun appel, aucune dépense. Rien d\'autre à faire.')
  process.exit(0)
}

const brutes: PieceMesuree[] = existsSync(JSONL)
  ? readFileSync(JSONL, 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as PieceMesuree)
  : []

// Enrichissement LOCAL, zéro appel : la transparence se mesure en sharp.
const mesurees: PieceMesuree[] = []
for (const p of brutes) {
  const dispo = existsSync(p.chemin)
  const masse = dispo ? await mesureMasseMarque(p.chemin, p.box_2d) : null
  mesurees.push({
    ...p,
    part_transparente: dispo ? await partTransparente(p.chemin) : 0,
    taux_remplissage_boite: masse?.mesurable ? masse.taux_remplissage_boite : null,
    masse_mesurable: masse?.mesurable ?? false,
    part_neutre_marque: masse?.mesurable ? masse.part_neutre_marque : null,
  })
}

if (!mesurees.length) {
  console.log('\n  aucun relevé — rien à agréger.')
  process.exit(1)
}

const NUM = ['nb_elements_distincts', 'nb_couleurs', 'taux_remplissage_boite', 'part_neutre_marque', 'luminance_fond', 'contraste_fond', 'saturation_fond', 'ratio_marque_cadre', 'cote_marque_cadre', 'luminance_fond_declaree', 'contraste_fond_declare'] as const
const CAT = ['type', 'contour', 'trame', 'fond_type', 'categorie'] as const

function agrege(sous: PieceMesuree[]) {
  const numeriques: Record<string, Resume> = {}
  for (const champ of NUM) {
    numeriques[champ] = resume(sous.map((p) => p[champ] as number).filter((x): x is number => typeof x === 'number'))
  }
  const categoriels: Record<string, Record<string, number>> = {}
  for (const champ of CAT) categoriels[champ] = distribution(sous.map((p) => String(p[champ])))
  const hex = sous.flatMap((p) => p.palette).filter((c) => /^#[0-9a-f]{6}$/.test(c))
  return { n: sous.length, numeriques, categoriels, palettes_top: Object.entries(distribution(hex)).slice(0, 20) }
}

const sousMarque = mesurees.filter((p) => p.porte_une_marque && Math.max(p.largeur, p.hauteur) >= PLANCHER_BORNES)
const sousMarqueVignettesIncluses = mesurees.filter((p) => p.porte_une_marque)
/*
 * Les bornes de FOND se prennent sur les seules pièces qui EN ONT un. Une icône
 * à fond transparent mesure luminance 0,000 et contraste 0,000 : compter ces
 * pièces tire la médiane de luminance vers le noir absolu sans qu'aucune pièce
 * du corpus n'ait été dessinée sur du noir absolu. C'est visible dans les
 * chiffres de la première passe : p25 de luminance ET de contraste tous deux
 * exactement à 0.
 */
const sousMarqueFond = sousMarque.filter((p) => (p.part_transparente ?? 0) < 0.5)
// La masse ne se mesure que là où la segmentation a réellement séparé quelque chose.
const sousMarqueMasse = sousMarque.filter((p) => p.masse_mesurable === true)
const global = agrege(mesurees)
const marque = agrege(sousMarque)
const marqueAvecVignettes = agrege(sousMarqueVignettesIncluses)
const marqueFond = agrege(sousMarqueFond)
const marqueMasse = agrege(sousMarqueMasse)

/*
 * LES BORNES DURES. Elles sortent du sous-ensemble « marque », pas du corpus
 * entier — voir DOSSIERS_MARQUE. `*_max` vaut la MÉDIANE arrondie : le mandat le
 * dit sans détour, « si la médiane nb_elements vaut 1, une marque à 2 éléments
 * est refusée par le code ».
 */
const bornes = {
  source: `sous-ensemble marque (dossiers logo/icon/PackPsd, type != aucune_marque, natif >= ${PLANCHER_BORNES} px)`,
  n: sousMarque.length,
  nb_elements_max: Math.round(marque.numeriques.nb_elements_distincts!.mediane),
  nb_couleurs_max: Math.round(marque.numeriques.nb_couleurs!.mediane),
  contour: modalite(sousMarque.map((p) => p.contour)),
  contour_couleur: modalite(sousMarque.filter((p) => p.contour !== 'none' && p.contour_couleur).map((p) => p.contour_couleur!)),
  trame: modalite(sousMarque.map((p) => p.trame)),
  type: modalite(sousMarque.map((p) => p.type)),
  // — à partir d'ici, sur les pièces qui ONT un fond (n renseigné ci-dessous)
  n_fond: sousMarqueFond.length,
  fond_type: modalite(sousMarqueFond.map((p) => p.fond_type)),
  luminance_fond: marqueFond.numeriques.luminance_fond!,
  contraste_fond: marqueFond.numeriques.contraste_fond!,
  saturation_fond: marqueFond.numeriques.saturation_fond!,
  ratio_marque_cadre: marque.numeriques.ratio_marque_cadre!,
  cote_marque_cadre: marque.numeriques.cote_marque_cadre!,
  palette_marque: paletteMarque(),
  /*
   * LA MASSE. Le p25 devient un PLANCHER dur : une marque moins compacte que le
   * quart le plus aéré du corpus n'appartient pas à ce corpus. C'est la seule
   * borne dont le plancher n'est pas la médiane, et c'est assumé — une marque
   * PLUS lourde que la médiane reste dans l'idiome (le B de black-world1 est au
   * -dessus), une marque plus aérée en sort. La borne est donc unilatérale.
   */
  taux_remplissage_boite: marqueMasse.numeriques.taux_remplissage_boite!,
  n_masse: sousMarqueMasse.length,
  /*
   * LA DOMINANCE DU NEUTRE dans la marque. La borne de palette dit qu'il FAUT
   * une couleur neutre ; elle ne disait pas laquelle domine. Un candidat de la
   * phase 3 est sorti en aplat orange percé d'un trou gris : palette conforme
   * (un neutre présent), proportion inversée. Le corpus tranche — plancher p25.
   */
  part_neutre_marque: marqueMasse.numeriques.part_neutre_marque!,
}

/*
 * La BORNE DE PALETTE, mesurée. « Couleurs mal choisies » est le reproche
 * littéral du dernier verdict opérateur ; le corpus en donne la réponse
 * chiffrée. 41 des 55 pièces portent du blanc pur, et 49 entrées de palette sur
 * 98 sont neutres : la couleur n°1 d'une marque de ce corpus est neutre, ce
 * n'est pas un goût, c'est la distribution. Les accents se rangent en familles
 * de teinte de 30°, et elles ne sont pas équiprobables — l'or/jaune (30-60°)
 * sort premier avec 11 occurrences, le cyan/azur (180-210°) second avec 9.
 * Une famille sous 4 occurrences n'est pas une famille, c'est une pièce.
 */
function paletteMarque() {
  const entrees = sousMarque.flatMap((p) => p.palette).filter((c) => /^#[0-9a-f]{6}$/.test(c))
  const neutres = entrees.filter((c) => estNeutre(c))
  const familles = new Map<number, number>()
  for (const c of entrees) {
    const f = familleTeinte(c)
    if (f !== null) familles.set(f, (familles.get(f) ?? 0) + 1)
  }
  const classees = [...familles.entries()].sort((a, c) => c[1] - a[1])
  return {
    entrees: entrees.length,
    part_neutre: arrondi(neutres.length / Math.max(1, entrees.length), 4),
    neutre_dominant: modalite(neutres) || '#ffffff',
    familles_accent: classees,
    /** Les familles qu'une marque de ce corpus peut porter : >= 4 occurrences. */
    familles_retenues: classees.filter(([, n]) => n >= 4).map(([f]) => f),
  }
}

/*
 * Les EXEMPLAIRES CANONIQUES : les 10 pièces les plus proches de la médiane sur
 * tous les axes à la fois. Distance robuste — chaque écart à la médiane est
 * divisé par l'écart interquartile de son axe, sinon la luminance (0..1)
 * pèserait cent fois moins que le nombre d'éléments. Un axe catégoriel vaut 0
 * si la pièce porte la modalité majoritaire, 1 sinon.
 * Filtre dur : >= 512 px natif. Ces pièces vont être JOINTES comme images aux
 * phases 2 et 3 — le plancher du run 5.9 s'applique, une vignette enseigne des
 * pâtés de pixels.
 */
const AXES_NUM = ['nb_elements_distincts', 'nb_couleurs', 'luminance_fond', 'contraste_fond', 'ratio_marque_cadre'] as const
const echelles = Object.fromEntries(
  AXES_NUM.map((a) => {
    const xs = sousMarque.map((p) => p[a] as number).filter((x): x is number => typeof x === 'number')
    const iqr = quantile(xs, 0.75) - quantile(xs, 0.25)
    return [a, iqr > 1e-6 ? iqr : Math.max(1e-6, Math.abs(mediane(xs)) || 1)]
  })
) as Record<string, number>

const canoniques = sousMarque
  .filter((p) => Math.max(p.largeur, p.hauteur) >= 512)
  .map((p) => {
    let d = 0
    const detail: Record<string, number> = {}
    for (const a of AXES_NUM) {
      const x = p[a] as number | null
      const med = marque.numeriques[a]!.mediane
      const e = typeof x === 'number' ? Math.abs(x - med) / echelles[a]! : 2
      detail[a] = arrondi(e, 3)
      d += e
    }
    for (const [champ, attendu] of [
      ['contour', bornes.contour],
      ['trame', bornes.trame],
      ['type', bornes.type],
      ['fond_type', bornes.fond_type],
    ] as const) {
      const e = String(p[champ as keyof PieceMesuree]) === attendu ? 0 : 1
      detail[champ] = e
      d += e
    }
    return { slug: p.slug, chemin: p.chemin, distance: arrondi(d, 3), detail, piece: p }
  })
  .sort((a, b) => a.distance - b.distance)
  .slice(0, 10)

const sortie = {
  genere_le: new Date().toISOString(),
  modele: MODELE,
  racine: RACINE_CORPUS,
  inventaire: {
    fichiers: inv.pieces.length + inv.ecartees.length,
    analysables: gardees.length,
    releves: mesurees.length,
    plancher_analyse_px: MIN_PX_ANALYSE,
    ecartees: ecartees.map((e) => ({ fichier: e.chemin.split(/[\\/]/).pop(), raison: e.raison })),
    boites_invalides: mesurees.filter((p) => p.box_invalide).length,
  },
  bornes,
  sous_ensemble_marque: marque,
  /* Le contrefactuel du plancher : les mêmes agrégats vignettes comprises.
   * S'il ne bouge pas, le plancher n'a rien coûté ; s'il bouge, l'écart est
   * chiffré et publié plutôt qu'affirmé. */
  sous_ensemble_marque_vignettes_incluses: marqueAvecVignettes,
  sous_ensemble_marque_avec_fond: marqueFond,
  sous_ensemble_marque_masse_mesurable: marqueMasse,
  corpus_global: global,
  canoniques: canoniques.map((c) => ({ slug: c.slug, chemin: c.chemin, distance: c.distance, detail: c.detail, resume: {
    type: c.piece.type,
    nb_elements: c.piece.nb_elements_distincts,
    nb_couleurs: c.piece.nb_couleurs,
    contour: c.piece.contour,
    trame: c.piece.trame,
    fond_type: c.piece.fond_type,
    luminance_fond: c.piece.luminance_fond,
    contraste_fond: c.piece.contraste_fond,
    ratio_marque_cadre: c.piece.ratio_marque_cadre,
    palette: c.piece.palette,
    natif: `${c.piece.largeur}x${c.piece.hauteur}`,
  } })),
  pieces: mesurees,
}

writeFileSync(REGLES, JSON.stringify(sortie, null, 2))

// ─── Restitution ─────────────────────────────────────────────────────────────

console.log(`\n═══ BORNES DURES (n=${bornes.n} pièces porteuses d'une marque) ═══`)
console.log(`  nb_elements_max        : ${bornes.nb_elements_max}   (médiane ${marque.numeriques.nb_elements_distincts!.mediane}, p25 ${marque.numeriques.nb_elements_distincts!.p25}, p75 ${marque.numeriques.nb_elements_distincts!.p75})`)
console.log(`  nb_couleurs_max        : ${bornes.nb_couleurs_max}   (médiane ${marque.numeriques.nb_couleurs!.mediane}, p25 ${marque.numeriques.nb_couleurs!.p25}, p75 ${marque.numeriques.nb_couleurs!.p75})`)
console.log(`  contour                : ${bornes.contour} (couleur majoritaire des pièces QUI en ont un : ${bornes.contour_couleur || 'aucune'})`)
console.log(`  trame                  : ${bornes.trame}`)
console.log(`  type                   : ${bornes.type}`)
console.log(`  fond_type              : ${bornes.fond_type}   (sur les ${bornes.n_fond} pièces qui ONT un fond ; ${bornes.n - bornes.n_fond} pièces à fond transparent écartées)`)
console.log(`  luminance_fond MESURÉE : médiane ${bornes.luminance_fond.mediane} [p25 ${bornes.luminance_fond.p25} · p75 ${bornes.luminance_fond.p75}]`)
console.log(`  contraste_fond MESURÉ  : médiane ${bornes.contraste_fond.mediane} [p25 ${bornes.contraste_fond.p25} · p75 ${bornes.contraste_fond.p75}]`)
console.log(`  saturation_fond        : médiane ${bornes.saturation_fond.mediane} [p25 ${bornes.saturation_fond.p25} · p75 ${bornes.saturation_fond.p75}]`)
console.log(`  ratio_marque_cadre     : médiane ${bornes.ratio_marque_cadre.mediane} [p25 ${bornes.ratio_marque_cadre.p25} · p75 ${bornes.ratio_marque_cadre.p75}]`)
console.log(`  cote_marque_cadre      : médiane ${bornes.cote_marque_cadre.mediane} [p25 ${bornes.cote_marque_cadre.p25} · p75 ${bornes.cote_marque_cadre.p75}]`)
console.log(`  NEUTRE dans la marque  : médiane ${bornes.part_neutre_marque.mediane} [p25 ${bornes.part_neutre_marque.p25} · p75 ${bornes.part_neutre_marque.p75}] — plancher dur = p25`)
console.log(`  MASSE (encre/boîte)    : médiane ${bornes.taux_remplissage_boite.mediane} [p25 ${bornes.taux_remplissage_boite.p25} · p75 ${bornes.taux_remplissage_boite.p75}] — plancher dur = p25, sur ${bornes.n_masse} pièces segmentables`)
console.log(`\n  déclaré par le modèle vs mesuré en code — luminance : ${marque.numeriques.luminance_fond_declaree!.mediane}/100 déclarée contre ${bornes.luminance_fond.mediane} mesurée`)
console.log(`  boîtes box_2d invalides : ${sortie.inventaire.boites_invalides}`)
console.log(
  `\n  contrefactuel du plancher ${PLANCHER_BORNES} px (n=${marque.n} → ${marqueAvecVignettes.n} vignettes comprises) :` +
    ` élém ${marque.numeriques.nb_elements_distincts!.mediane}→${marqueAvecVignettes.numeriques.nb_elements_distincts!.mediane}` +
    ` · coul ${marque.numeriques.nb_couleurs!.mediane}→${marqueAvecVignettes.numeriques.nb_couleurs!.mediane}` +
    ` · contour ${modalite(sousMarque.map((p) => p.contour))}→${modalite(sousMarqueVignettesIncluses.map((p) => p.contour))}` +
    ` · trame ${modalite(sousMarque.map((p) => p.trame))}→${modalite(sousMarqueVignettesIncluses.map((p) => p.trame))}`
)

console.log(`\n  distributions (sous-ensemble marque) :`)
for (const champ of CAT) {
  console.log(`    ${champ.padEnd(10)} : ${Object.entries(marque.categoriels[champ]!).map(([k, v]) => `${k} ${v}`).join(' · ')}`)
}

console.log(`\n═══ 10 EXEMPLAIRES CANONIQUES ═══`)
for (const c of canoniques) {
  console.log(`  ${c.distance.toFixed(2)}  ${c.slug}  [${c.piece.type} · ${c.piece.nb_elements_distincts} élém · ${c.piece.nb_couleurs} coul · contour ${c.piece.contour} · trame ${c.piece.trame} · fond ${c.piece.fond_type} L=${c.piece.luminance_fond}]`)
}

console.log(`\n  → ${REGLES}`)
console.log(`  dépensé phase 1 : ${spentForPhase('p1-corpus').toFixed(4)} € / ${PLAFONDS_PHASE['p1-corpus']!.toFixed(2)} €\n`)
