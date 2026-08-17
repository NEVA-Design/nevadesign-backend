import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { TrainingRequiredError } from './adn'
import type { ArtDirection } from './mapping'

// ── Sélection des exemplaires d'entraînement (run 5.2 → 5.4) ─────────────────
// Le compilateur est few-shot : chaque génération embarque 1-2 reverse-prompts
// exemplaires de sa catégorie comme gabarits de structure, et 2-3 images de
// référence JOINTES à l'appel. La sélection se fait ici, par recouvrement des
// tags de cluster du mapping puis proximité énergie/modernité.
// Les fichiers viennent de scripts/train-fivem-v4.ts (lancé par le client).
// Run 5.4, LOT 0 : le mode dégradé est SUPPRIMÉ — une catégorie sans
// exemplaires installés JETTE TrainingRequiredError, aucun chemin ne compile
// un prompt sans few-shot ni référence.

const EXEMPLARS_DIR = resolve(import.meta.dir, '../../engine/exemplars/fivem')

// Les 3 familles de rendu mesurées — dupliquées ici en type local pour ne pas
// créer de cycle d'import avec logo-director.ts (qui importe ce module).
export type ExemplarFamille = 'plat_premium' | 'semi_flat_biseau' | 'dimensionnelle'

export type ExemplarEntry = {
  slug: string
  tags: string[]
  energie: number
  modernite: number
  couleurs: string[]
  // run 5.3 : 'humaine' = recette écrite par le client (fichiers .txt du
  // dossier d'entraînement) — passe TOUJOURS avant les reverse-prompts
  priorite?: 'humaine' | 'reverse'
  // description de la typographie générée (manifest v2/v3) — sert aux notes
  // de référence transmises au directeur artistique logo
  typographie_generee?: string
  // run 5.8 : famille de rendu (scripts/classify-familles-exemplars.ts) —
  // le filtre garantit que les références jointes montrent la MÊME famille
  // que le concept, sinon le transfert de style est faible.
  famille?: ExemplarFamille
  // run 5.8 : l'exemplaire montre un lettrage travaillé — privilégié pour le
  // lockup fusionné (c'est le traitement typographique qu'on transfère)
  lettrage_riche?: boolean
  // run 5.9 : côté long de l'IMAGE SOURCE (recompile-exemplars-hq.ts).
  // L'audit du chantier 0 a montré que 25 exemplaires sont des vignettes
  // Discord 96-128 px : jointes en référence, le modèle imitait des pâtés de
  // pixels (candy gloss, sticker, fond délavé). En dessous de ce plancher,
  // l'exemplaire reste dans le corpus (reverse-prompts, notes, ADN) mais son
  // IMAGE n'est plus jamais jointe à une génération.
  resolution_native?: number
  // run 5.9 : étiquettes de style écrites par label-exemplars.ts (vision
  // raisonnement haut sur les images recompilées HQ)
  style?: {
    famille?: ExemplarFamille
    traitement_lettrage?: string
    matiere?: string
    embleme?: { present: boolean; type: string | null }
    ambiance?: string
    fond_sombre?: boolean
  }
}

// Plancher de résolution pour qu'une image serve de référence de rendu.
export const MIN_REFERENCE_NATIVE_PX = 512

// Run 5.9 : matière du brief wizard → étiquettes de style recherchées dans le
// corpus (label-exemplars.ts). La sélection montre au modèle des exemplaires
// qui exécutent EXACTEMENT le traitement demandé.
export function styleQueryForMatiere(matiere: string | null | undefined): { traitements: string[]; matiereMotsCles: string[] } {
  switch (matiere) {
    case 'neon':
      return { traitements: ['neon'], matiereMotsCles: ['neon', 'glow'] }
    case 'chrome':
      return { traitements: ['chrome', 'extrusion_3d'], matiereMotsCles: ['chrome', 'metal', 'steel', 'silver', 'brushed'] }
    case 'or':
      return { traitements: ['or', 'extrusion_3d'], matiereMotsCles: ['gold', 'golden'] }
    case 'verre':
      return { traitements: ['extrusion_3d', 'chrome'], matiereMotsCles: ['glass', 'frosted', 'crystal'] }
    default:
      return { traitements: [], matiereMotsCles: [] }
  }
}

type Manifest = { exemplaires: Array<ExemplarEntry & { categories?: string[] }> }

type CategoryCache = {
  entries: ExemplarEntry[]
  prompts: Map<string, string>
  images: Map<string, { data: string; mimeType: string }>
}

const cache = new Map<string, CategoryCache>()

// Pool partagé des recettes humaines (run 5.3, LOT 3) : les .txt du dossier
// d'entraînement, parsés par train-fivem-v3.ts. Chaque recette liste les
// catégories héro où elle est éligible — elle y passe AVANT les
// reverse-prompts (boost dans scoreEntry).
const RECETTES_HUMAINES_DIR = '_recettes-humaines'

function loadManifestInto(result: CategoryCache, dir: string, filterCategory?: string) {
  const manifestPath = join(dir, '_manifest.json')
  if (!existsSync(manifestPath)) return
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest
    for (const entry of manifest.exemplaires ?? []) {
      if (filterCategory && !(entry.categories ?? []).includes(filterCategory)) continue
      const promptPath = join(dir, `${entry.slug}.txt`)
      if (!existsSync(promptPath)) continue
      result.entries.push(entry)
      result.prompts.set(entry.slug, readFileSync(promptPath, 'utf-8').trim())
      const imagePath = join(dir, `${entry.slug}.jpg`)
      if (existsSync(imagePath)) {
        result.images.set(entry.slug, {
          data: readFileSync(imagePath).toString('base64'),
          mimeType: 'image/jpeg',
        })
      }
    }
  } catch (error) {
    console.warn(`[exemplars] manifest illisible (${dir}) :`, (error as Error).message)
  }
}

function loadCategory(category: string): CategoryCache {
  const cached = cache.get(category)
  if (cached) return cached

  const result: CategoryCache = { entries: [], prompts: new Map(), images: new Map() }
  loadManifestInto(result, join(EXEMPLARS_DIR, category))
  // recettes humaines éligibles à cette catégorie — prompts sans images
  loadManifestInto(result, join(EXEMPLARS_DIR, RECETTES_HUMAINES_DIR), category)

  /*
   * Run 6 (pivot idiome) — LES PIÈCES SORTIES DU CORPUS DE RÉFÉRENCES.
   *
   * Même mécanique que le plancher 512 px, et pour la même raison : on retire
   * l'IMAGE de la jointure, jamais l'exemplaire du corpus. Fruitz, ALYA, Sweety
   * Life et la planche South District gardent leur reverse-prompt, leurs notes
   * et leur poids dans l'ADN — elles ne sont simplement plus jamais montrées au
   * modèle image, parce qu'elles enseignent une langue de marque hors gaming.
   * Le principe « on ne trie ni n'exclut rien du corpus » (passation §7) tient.
   */
  if (category === 'logo') {
    for (const slug of horsCorpusReferenceSlugs()) result.images.delete(slug)
  }

  cache.set(category, result)
  return result
}

export function invalidateExemplarsCache() {
  cache.clear()
}

function scoreEntry(entry: ExemplarEntry, da: ArtDirection, energie: number, modernite: number): number {
  const tagOverlap = entry.tags.filter((t) => da.clusterTags.includes(t)).length
  // le recouvrement de cluster domine ; l'écart énergie/modernité départage.
  // Run 5.3 : les recettes humaines (validées par le client) passent AVANT
  // tout reverse-prompt, à recouvrement de cluster égal ou non.
  const distance = Math.abs(entry.energie - energie) + Math.abs(entry.modernite - modernite)
  const humanBoost = entry.priorite === 'humaine' ? 1_000_000 : 0
  return humanBoost + tagOverlap * 1000 - distance
}

export type ExemplarSelection = {
  // reverse-prompts gabarits, du plus pertinent au moins pertinent
  reversePrompts: string[]
  // images de référence à joindre à l'appel de génération
  references: Array<{ data: string; mimeType: string }>
  // slugs retenus — cités dans compiled_prompts pour la traçabilité
  slugs: string[]
}

export function pickExemplars(opts: {
  category: string
  da: ArtDirection
  energie?: number
  modernite?: number
  maxPrompts?: number
  maxReferences?: number
  /** run 5.8 : ne joindre que des références de CETTE famille de rendu
   *  (complétées par les autres familles seulement si la sienne s'épuise) */
  famille?: ExemplarFamille
  /** run 5.8 (lockup) : privilégier les références au lettrage travaillé */
  prefereLettrage?: boolean
  /** run 5.9 : recouvrement de style demandé par le concept — traitements de
   *  lettrage acceptés (ex. ['chrome','extrusion_3d']) et mots-clés matière.
   *  La famille reste le filtre DUR ; le style départage dedans. */
  traitements?: string[]
  matiereMotsCles?: string[]
}): ExemplarSelection {
  const { category, da } = opts
  const energie = opts.energie ?? 50
  const modernite = opts.modernite ?? 50
  const maxPrompts = opts.maxPrompts ?? 2
  const maxReferences = opts.maxReferences ?? 3

  const { entries, prompts, images } = loadCategory(category)
  if (!entries.length) throw new TrainingRequiredError(`exemplaires ${category} absents`)

  let ranked = [...entries].sort(
    (a, b) => scoreEntry(b, da, energie, modernite) - scoreEntry(a, da, energie, modernite)
  )
  // Le filtre famille est DUR en tête de liste ; à l'intérieur d'une famille,
  // le recouvrement de style (traitement du lettrage, matière) passe avant le
  // lettrage riche, qui reste un départage.
  if (opts.famille || opts.prefereLettrage || opts.traitements?.length || opts.matiereMotsCles?.length) {
    const styleScore = (e: ExemplarEntry): number => {
      let s = 0
      if (opts.traitements?.length && e.style?.traitement_lettrage && opts.traitements.includes(e.style.traitement_lettrage)) s += 2
      if (opts.matiereMotsCles?.length && e.style?.matiere) {
        const matiere = e.style.matiere.toLowerCase()
        if (opts.matiereMotsCles.some((m) => matiere.includes(m.toLowerCase()))) s += 1
      }
      return s
    }
    const group = (e: ExemplarEntry) =>
      (opts.famille && e.famille === opts.famille ? 0 : 100) +
      (10 - Math.min(10, styleScore(e) * 3)) +
      (opts.prefereLettrage && e.lettrage_riche ? 0 : 1)
    ranked = ranked
      .map((e, i) => ({ e, i }))
      .sort((a, b) => group(a.e) - group(b.e) || a.i - b.i)
      .map((x) => x.e)
  }

  const slugs: string[] = []
  const reversePrompts: string[] = []
  const references: Array<{ data: string; mimeType: string }> = []

  // La meilleure recette humaine ouvre le few-shot (boost de score) ; on en
  // limite UNE par sélection pour que les reverse-prompts spécifiques à la
  // catégorie (format, construction) gardent leur place.
  let humanPicked = 0
  for (const entry of ranked) {
    if (references.length >= maxReferences && reversePrompts.length >= maxPrompts) break
    if (entry.priorite === 'humaine' && humanPicked >= 1) continue
    const prompt = prompts.get(entry.slug)
    let used = false
    if (reversePrompts.length < maxPrompts && prompt) {
      reversePrompts.push(prompt)
      if (entry.priorite === 'humaine') humanPicked += 1
      used = true
    }
    // Run 5.9 : une vignette (< 512 px natif) n'est JAMAIS jointe en image —
    // l'audit du chantier 0 a prouvé qu'elle tire le rendu vers le pâté de
    // pixels. Elle garde sa place de reverse-prompt/note.
    const image = images.get(entry.slug)
    const hautRes = (entry.resolution_native ?? 0) >= MIN_REFERENCE_NATIVE_PX
    if (references.length < maxReferences && image && hautRes) {
      references.push(image)
      used = true
    }
    if (used) slugs.push(entry.slug)
  }

  return { reversePrompts, references, slugs }
}

// ── Run 5.10 (pivot rendu intégral) : références ÉTIQUETÉES ──────────────────
// Le test plafond du 5.9 (_plafond-run59/) a prouvé le format de transfert
// gagnant : références HQ jointes AVANT le texte, chacune décrite par une
// étiquette (« REFERENCE 1 — the real "fruitz" wordmark: chrome script fused
// inside a citrus slice »), prompt court. Cette sélection produit les 3-4
// références du rendu intégral avec leur étiquette construite depuis les
// étiquettes de style du manifest (label-exemplars.ts, vision sur les images
// recompilées HQ). Le plancher 512 px reste DUR : jamais de vignette jointe.

const TRAITEMENT_EN: Record<string, string> = {
  flat_outline: 'flat outlined lettering',
  extrusion_3d: '3D extruded lettering',
  chrome: 'chrome lettering',
  or: 'gold lettering',
  neon: 'neon lettering',
  script: 'script lettering',
}

const FAMILLE_EN: Record<ExemplarFamille, string> = {
  plat_premium: 'flat premium',
  semi_flat_biseau: 'semi-flat beveled',
  dimensionnelle: 'dimensional',
}

function etiquetteFor(entry: ExemplarEntry, index: number): string {
  const s = entry.style
  const morceaux: string[] = []
  const traitement = s?.traitement_lettrage ? TRAITEMENT_EN[s.traitement_lettrage] : undefined
  if (traitement) morceaux.push(traitement)
  if (s?.matiere) morceaux.push(s.matiere)
  if (s?.embleme?.present && s.embleme.type) morceaux.push(`${s.embleme.type} emblem fused with the lettering`)
  if (s?.ambiance) morceaux.push(`${s.ambiance} mood`)
  const famille = entry.famille ? `${FAMILLE_EN[entry.famille]} family` : 'target family'
  const detail = morceaux.length ? `: ${morceaux.join(', ')}` : ''
  return `REFERENCE ${index + 1} — a real logo of the ${famille}${detail} — match its production quality and finish, never its shapes or words:`
}

export type ExemplarEtiquete = { slug: string; data: string; mimeType: string; label: string }

/** Les 3-4 références HQ du rendu intégral, au plus près du concept par les
 *  étiquettes de style (famille = filtre dur, traitement/matière départagent),
 *  chacune avec son étiquette. */
export function pickExemplarsEtiquetes(opts: {
  category: string
  da: ArtDirection
  energie?: number
  modernite?: number
  famille?: ExemplarFamille
  prefereLettrage?: boolean
  traitements?: string[]
  matiereMotsCles?: string[]
  max?: number
}): ExemplarEtiquete[] {
  const energie = opts.energie ?? 50
  const modernite = opts.modernite ?? 50
  const max = Math.min(4, Math.max(1, opts.max ?? 3))
  const { entries, images } = loadCategory(opts.category)
  if (!entries.length) throw new TrainingRequiredError(`exemplaires ${opts.category} absents`)

  const styleScore = (e: ExemplarEntry): number => {
    let s = 0
    if (opts.traitements?.length && e.style?.traitement_lettrage && opts.traitements.includes(e.style.traitement_lettrage)) s += 2
    if (opts.matiereMotsCles?.length && e.style?.matiere) {
      const matiere = e.style.matiere.toLowerCase()
      if (opts.matiereMotsCles.some((m) => matiere.includes(m.toLowerCase()))) s += 1
    }
    return s
  }
  const group = (e: ExemplarEntry) =>
    (opts.famille && e.famille === opts.famille ? 0 : 100) +
    (10 - Math.min(10, styleScore(e) * 3)) +
    ((opts.prefereLettrage ?? true) && e.lettrage_riche ? 0 : 1)

  const ranked = [...entries]
    .filter((e) => (e.resolution_native ?? 0) >= MIN_REFERENCE_NATIVE_PX && images.has(e.slug))
    .map((e, i) => ({ e, score: scoreEntry(e, opts.da, energie, modernite), i }))
    .sort((a, b) => group(a.e) - group(b.e) || b.score - a.score || a.i - b.i)
    .map((x) => x.e)

  return ranked.slice(0, max).map((entry, i) => {
    const image = images.get(entry.slug)!
    return { slug: entry.slug, data: image.data, mimeType: image.mimeType, label: etiquetteFor(entry, i) }
  })
}

// ── Run 6 (§3) : LE CATALOGUE DE RÉFÉRENCES, choisi PAR LE DA ────────────────
// Le run 5.10 sélectionnait les références en code, par filtre de famille dur.
// Hypothèse n°2 de la passation : ce filtre a écarté les pièces gold les plus
// fortes (les gagnants du plafond utilisaient `logo` + `logo2` scénique +
// `flashmood-rp2`, INTER-FAMILLES). En v6 le DA reçoit le catalogue des
// références joignables et choisit lui-même 3 slugs par concept, dont AU MOINS
// DEUX gold. Le plancher 512 px reste dur : une vignette n'est jamais jointe.

type GoldSetFichier = { pepites?: Array<{ slug?: string }> }

let goldCache: Set<string> | null = null

/** Les slugs du gold set (barre de notation ET pool prioritaire de références). */
export function goldSlugs(): Set<string> {
  if (goldCache) return goldCache
  const chemin = join(EXEMPLARS_DIR, 'logo', '_gold-set.json')
  try {
    const parsed = JSON.parse(readFileSync(chemin, 'utf-8')) as GoldSetFichier
    goldCache = new Set((parsed.pepites ?? []).map((p) => String(p.slug)).filter(Boolean))
  } catch (error) {
    console.warn('[exemplars] gold set illisible :', (error as Error).message)
    goldCache = new Set()
  }
  return goldCache
}

/*
 * Run 6 (correction opérateur post-E3) — L'IDIOME FiveM/GTA.
 *
 * Le rendu apprend sa langue visuelle de la première référence jointe : rue de
 * Los Santos, néons, palmiers, asphalte mouillé. E3 l'a montré à l'envers —
 * quatre concepts sur cinq ont mis le wordmark Fruitz (une marque de FRUITS)
 * en REFERENCE 1, et les rendus ont hérité d'une langue de marque, pas d'une
 * langue de serveur. REFERENCE 1 se prend donc TOUJOURS dans ce set ; les
 * slots 2 et 3 restent ouverts au catalogue entier, où une pièce hors idiome
 * garde toute sa valeur de référence de construction ou de matière.
 */
type FivemSetFichier = {
  fivem?: Array<{ slug?: string; famille_rendu?: string; construction?: string }>
  hors_corpus_reference?: Array<{ slug?: string }>
}

let fivemSetCache: FivemSetFichier | null = null

function fivemSet(): FivemSetFichier {
  if (fivemSetCache) return fivemSetCache
  const chemin = join(EXEMPLARS_DIR, 'logo', '_fivem-set.json')
  let parsed: FivemSetFichier
  try {
    parsed = JSON.parse(readFileSync(chemin, 'utf-8')) as FivemSetFichier
  } catch (error) {
    // Un `catch` qui renvoyait `{}` : le set vide se propageait en silence,
    // aucune pièce n'était plus éligible à REFERENCE 1 ni exclue du corpus, et
    // le DA échouait deux tentatives plus loin sur un message incompréhensible
    // — 0,06 € pour une virgule. Une erreur de syntaxe se dit ici.
    throw new Error(
      `_fivem-set.json est illisible (${(error as Error).message}) — c'est le fichier qui décide de REFERENCE 1 et des pièces sorties du corpus. Corrige le JSON avant toute génération.`
    )
  }
  if (!Array.isArray(parsed.fivem) || parsed.fivem.length === 0) {
    throw new Error('_fivem-set.json ne liste aucune pièce d’idiome — REFERENCE 1 n’aurait plus aucun choix valide.')
  }
  fivemSetCache = parsed
  return fivemSetCache
}

/** Les slugs qui peuvent occuper REFERENCE 1 (`_fivem-set.json`). */
export function fivemSlugs(): Set<string> {
  return new Set((fivemSet().fivem ?? []).map((p) => String(p.slug)).filter(Boolean))
}

/** Run 6 — les slugs dont l'IMAGE n'est plus jamais jointe, quel que soit le
 *  slot (marques hors gaming, planches de marque multi-cases). L'exemplaire
 *  reste au corpus : seule sa jointure est coupée. */
export function horsCorpusReferenceSlugs(): Set<string> {
  return new Set((fivemSet().hors_corpus_reference ?? []).map((p) => String(p.slug)).filter(Boolean))
}

/** La famille de rendu OBSERVÉE d'une pièce d'idiome (flat_vector_texture,
 *  texture_fill, scene_composite, chrome_3d) et sa construction — c'est ce que
 *  le DA lit dans le catalogue pour choisir des références cohérentes avec la
 *  famille qu'il vise. */
export function idiomeParSlug(): Map<string, { famille_rendu?: string; construction?: string }> {
  const map = new Map<string, { famille_rendu?: string; construction?: string }>()
  for (const p of fivemSet().fivem ?? []) {
    if (!p.slug) continue
    map.set(String(p.slug), { famille_rendu: p.famille_rendu, construction: p.construction })
  }
  return map
}

export type ReferenceCatalogueEntry = {
  slug: string
  gold: boolean
  /** éligible au slot REFERENCE 1 — porte l'idiome FiveM/GTA */
  fivem: boolean
  /** run 6 — famille de rendu OBSERVÉE sur la pièce (l'idiome, pas le manifest) */
  famille_rendu?: string
  /** run 6 — construction observée (CONTAINER, HERO_MONOGRAM…) */
  construction?: string
  famille?: ExemplarFamille
  traitement?: string
  matiere?: string
  embleme?: string | null
  ambiance?: string
  resolution_native?: number
}

/** Les références RÉELLEMENT joignables (image présente, >= 512 px natif),
 *  avec leurs étiquettes de style — c'est ce catalogue que le DA reçoit. */
export function listReferenceCatalogue(category: string): ReferenceCatalogueEntry[] {
  const { entries, images } = loadCategory(category)
  if (!entries.length) throw new TrainingRequiredError(`exemplaires ${category} absents`)
  const gold = goldSlugs()
  const fivem = fivemSlugs()
  const idiome = idiomeParSlug()
  return entries
    .filter((e) => images.has(e.slug) && (e.resolution_native ?? 0) >= MIN_REFERENCE_NATIVE_PX)
    .map((e) => ({
      slug: e.slug,
      gold: gold.has(e.slug),
      fivem: fivem.has(e.slug),
      famille_rendu: idiome.get(e.slug)?.famille_rendu,
      construction: idiome.get(e.slug)?.construction,
      famille: e.famille,
      traitement: e.style?.traitement_lettrage,
      matiere: e.style?.matiere ?? undefined,
      embleme: e.style?.embleme?.present ? e.style.embleme.type : null,
      ambiance: e.style?.ambiance,
      resolution_native: e.resolution_native,
    }))
    // l'idiome FiveM en tête, puis les pièces gold : le DA lit le catalogue
    // dans l'ordre où il doit remplir ses slots (1 = idiome, 2-3 = barre)
    .sort(
      (a, b) =>
        Number(b.fivem) - Number(a.fivem) || Number(b.gold) - Number(a.gold) || a.slug.localeCompare(b.slug)
    )
}

/*
 * Run 6 (2e correction du 17/08) — REFERENCE 1 EST UNE CIBLE DE COPIE.
 *
 * « Transfert depuis UNE référence, plus description. » Le §4.1 de la passation
 * l'avait prouvé et on ne l'exploitait que pour le style : demandé de REPRODUIRE
 * une pièce, le modèle la reproduit presque parfaitement. Le slot 1 reçoit donc
 * l'instruction de copie, écrite EN CODE — le DA choisit quelle pièce copier,
 * jamais comment on la lui demande.
 */
export const LABEL_REFERENCE_1 =
  'REFERENCE 1 — match this piece exactly: same construction, same texture, same background treatment, same level of detail. Only the glyph changes:'

/** Les références choisies PAR SLUG par le DA. Le slot 1 porte l'instruction de
 *  copie ; les suivants gardent l'étiquette écrite par le DA. Un slug
 *  injoignable est ignoré (le validateur l'a déjà refusé). */
export function pickExemplarsParSlugs(opts: {
  category: string
  choix: Array<{ slug: string; label: string }>
}): ExemplarEtiquete[] {
  const { images } = loadCategory(opts.category)
  const sortie: ExemplarEtiquete[] = []
  opts.choix.forEach((c, i) => {
    const image = images.get(c.slug)
    if (!image) return
    const rang = sortie.length + 1
    const ecrit = c.label.trim() || `REFERENCE ${i + 1} — a real logo of the target family:`
    sortie.push({
      slug: c.slug,
      data: image.data,
      mimeType: image.mimeType,
      // le numéro est réécrit en code : le DA se trompe d'index, jamais le pipeline
      label: rang === 1 ? LABEL_REFERENCE_1 : ecrit.replace(/^REFERENCE\s*\d+/i, `REFERENCE ${rang}`),
    })
  })
  return sortie
}

// Notes descriptives des meilleures références du cluster — transmises au
// directeur artistique logo (étage 1) pour qu'il sache À QUOI ressemblent
// les références qui seront jointes à la génération. Zéro image ici : que
// les métadonnées du manifest (typo générée, couleurs, tags).
export function pickExemplarNotes(opts: {
  category: string
  da: ArtDirection
  energie?: number
  modernite?: number
  max?: number
}): string[] {
  const { entries } = loadCategory(opts.category)
  if (!entries.length) throw new TrainingRequiredError(`exemplaires ${opts.category} absents`)
  const energie = opts.energie ?? 50
  const modernite = opts.modernite ?? 50
  return [...entries]
    .sort((a, b) => scoreEntry(b, opts.da, energie, modernite) - scoreEntry(a, opts.da, energie, modernite))
    .slice(0, opts.max ?? 4)
    .map((e) => {
      const typo = e.typographie_generee && e.typographie_generee !== 'none' ? ` — lettering: ${e.typographie_generee}` : ''
      const couleurs = e.couleurs.length ? ` — colors ${e.couleurs.join(', ')}` : ''
      return `${e.slug} [${e.tags.join(', ')}]${typo}${couleurs}`
    })
}
