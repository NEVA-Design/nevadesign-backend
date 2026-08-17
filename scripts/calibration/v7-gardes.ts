/*
 * Run 7 — LES GARDES de la phase 3, dans un module PUR.
 *
 * Pourquoi un module séparé : `v7-svg.ts` est un script, pas une bibliothèque —
 * l'importer EXÉCUTE la boucle de tracé. Les tests l'ont importé pour vérifier
 * ses gardes et ont lancé un vrai tour de phase 3, payé 0,0116 € au grand livre
 * avant d'être interrompu. Une fonction qu'on veut tester ne vit pas dans un
 * fichier qui fait quelque chose au chargement.
 *
 * Tout ici est pur et déterministe, hors les appels sharp/librsvg de mesure.
 */

import {
  boiteMasque,
  estNeutre,
  familleTeinte,
  masqueOpacite,
  renduSvg,
  type MesureSvg,
} from './v7-lib'

/** L'avis du juge de forme — un type pur, la décision reste au code. */
export type Critique = {
  courbes_propres: boolean | null
  epaisseur_constante: boolean | null
  nb_elements: number | null
  nb_couleurs: number | null
  lisible_a_64px: boolean | null
  ecart_principal_en_une_phrase: string
}

// ─── Normalisation : la marque cadrée comme elle sera composée ────────────────

/**
 * Réécrit le SVG avec la marque recentrée et mise à l'échelle pour que son plus
 * grand côté couvre `cote` du viewBox 512. La boîte vient du RENDU (donc des
 * vraies courbes, pas des attributs déclarés) ; les coordonnées reviennent en
 * unités utilisateur par simple homothétie, le viewBox faisant 512 pour 512.
 */
export async function normalise(svg: string, cote: number): Promise<string | null> {
  const png = await renduSvg(svg, 512).catch(() => null)
  if (!png) return null
  const boite = boiteMasque(await masqueOpacite(png, 512))
  if (!boite) return null
  const bw = (boite.x1 - boite.x0) * 512
  const bh = (boite.y1 - boite.y0) * 512
  if (bw < 1 || bh < 1) return null
  const s = (cote * 512) / Math.max(bw, bh)
  const cx = ((boite.x0 + boite.x1) / 2) * 512
  const cy = ((boite.y0 + boite.y1) / 2) * 512
  const tx = 256 - s * cx
  const ty = 256 - s * cy
  const interieur = svg.replace(/^[\s\S]*?<svg[^>]*>/i, '').replace(/<\/svg>\s*$/i, '')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${s.toFixed(5)})">${interieur}</g></svg>`
}

// ─── Les gardes, EN CODE ─────────────────────────────────────────────────────

export type Garde = { nom: string; passe: boolean; mesure: string; attendu: string }

/*
 * La conformité de palette au corpus, mesurée. « Couleurs mal choisies » est le
 * reproche littéral du dernier verdict opérateur : la borne y répond par la
 * distribution plutôt que par un goût. Deux conditions, toutes deux tirées des
 * 98 entrées de palette du sous-ensemble marque :
 *   - au moins une couleur NEUTRE (41 pièces sur 55 portent du blanc pur) ;
 *   - toute couleur saturée dans une famille de teinte que le corpus porte au
 *     moins 4 fois. Une famille à 1 occurrence n'est pas une famille du corpus,
 *     c'est une pièce du corpus.
 */
export function paletteConforme(
  palette: string[],
  pm: { familles_retenues: number[] }
): { passe: boolean; detail: string } {
  const neutres = palette.filter((c) => estNeutre(c))
  const accents = palette.filter((c) => !estNeutre(c))
  const horsFamille = accents.filter((c) => {
    const f = familleTeinte(c)
    return f === null || !pm.familles_retenues.includes(f)
  })
  const passe = neutres.length >= 1 && horsFamille.length === 0
  const familles = accents.map((c) => `${c} → ${familleTeinte(c)}°`).join(', ')
  return {
    passe,
    detail: neutres.length
      ? horsFamille.length
        ? `accent hors familles du corpus : ${horsFamille.join(', ')}`
        : `neutre ${neutres.join(', ')}${familles ? ` + accent ${familles}` : ''}`
      : `aucune couleur neutre (${palette.join(', ')})`,
  }
}

export function gardes(
  m: MesureSvg,
  palette: string[],
  nbElementsMax: number,
  nbCouleursMax: number,
  pm: { familles_retenues: number[] },
  contourAttendu = 'none',
  masseMin = 0,
  accentMin = 0,
  regions: Array<{ hex: string; part: number; touche_le_bord: boolean }> = []
): Garde[] {
  const a = m.analyse
  const paletteBasse = palette.map((c) => c.toLowerCase())
  const fillsHorsPalette = a.fills.filter((f) => f !== 'none' && !paletteBasse.includes(f))
  const conf = paletteConforme(palette, pm)
  const g: Garde[] = [
    { nom: 'rendu', passe: m.parse, mesure: m.parse ? 'le SVG se rasterise' : `échec : ${m.erreurRendu}`, attendu: 'un SVG que librsvg trace' },
    { nom: 'viewBox', passe: (a.viewBox ?? '').replace(/\s+/g, ' ').trim() === '0 0 512 512', mesure: a.viewBox ?? 'absent', attendu: '0 0 512 512' },
    { nom: 'chemins_seuls', passe: a.nbFormesPrimitives === 0 && a.nbPaths > 0, mesure: `${a.nbPaths} <path>, ${a.nbFormesPrimitives} primitive(s)`, attendu: 'des <path>, aucune primitive' },
    { nom: 'aucun_texte', passe: !a.aText, mesure: a.aText ? '<text>/font-family présent' : 'aucun', attendu: 'les lettres sont des chemins tracés' },
    { nom: 'aucun_degrade', passe: !a.aGradient, mesure: a.aGradient ? 'dégradé ou url(#) présent' : 'aucun', attendu: 'aplats seulement' },
    { nom: 'aucun_filtre', passe: !a.aFilter, mesure: a.aFilter ? 'filtre/flou/ombre présent' : 'aucun', attendu: 'aucun filtre' },
    { nom: 'aucune_image', passe: !a.aImage, mesure: a.aImage ? '<image> présent' : 'aucune', attendu: 'du vecteur, pas du raster' },
    { nom: 'aucune_opacite', passe: !a.aOpacite, mesure: a.aOpacite ? 'opacity < 1 présent' : 'aucune', attendu: 'opacité pleine' },
    {
      nom: 'contour',
      passe: a.strokes.length === 0,
      mesure: a.strokes.length ? `contour(s) ${a.strokes.join(', ')}` : 'aucun contour',
      attendu: `aucun contour — médiane du corpus « ${contourAttendu} » (38 pièces sur 55)`,
    },
    { nom: 'palette', passe: fillsHorsPalette.length === 0, mesure: fillsHorsPalette.length ? `hors palette : ${fillsHorsPalette.join(', ')}` : `${a.fills.length} fill(s) conformes`, attendu: palette.join(' + ') },
    { nom: 'palette_corpus', passe: conf.passe, mesure: conf.detail, attendu: `>= 1 neutre + accents dans les familles de teinte du corpus (${pm.familles_retenues.map((f) => `${f}°`).join(', ')})` },
    { nom: 'nb_elements', passe: m.nbElements >= 1 && m.nbElements <= nbElementsMax, mesure: `${m.nbElements} composante(s) connexe(s)`, attendu: `1 à ${nbElementsMax}` },
    { nom: 'nb_couleurs', passe: m.nbCouleursRendu >= 1 && m.nbCouleursRendu <= nbCouleursMax, mesure: `${m.nbCouleursRendu} au rendu (${m.couleursRendu.map((c) => `${c.hex} ${Math.round(c.part * 100)}%`).join(', ')})`, attendu: `1 à ${nbCouleursMax}` },
    { nom: 'encre', passe: m.encre512 >= 0.04 && m.encre512 <= 0.62, mesure: `${m.encre512} du cadre`, attendu: '0,04 à 0,62 — ni vide, ni pâté' },
    { nom: 'lisible_64px_structure', passe: m.nbElements64 === m.nbElements, mesure: `${m.nbElements64} composante(s) à 64 px contre ${m.nbElements} à 512`, attendu: 'la structure survit' },
    { nom: 'lisible_64px_iou', passe: m.iou64 >= 0.8, mesure: `IoU ${m.iou64}`, attendu: '>= 0,80 — rien d\'essentiel ne disparaît' },
    /*
     * LA MASSE. Ajoutée après avoir vu la boucle converger au tour 1 : toutes
     * les autres gardes sont des gardes d'HYGIÈNE, elles vérifient qu'un SVG est
     * conforme et bien tracé, pas qu'il ressemble au corpus. La masse est le
     * trait structurel que ce corpus partage — des formes lourdes qui portent
     * leur cadre.
     * Plancher = p25 du corpus (0,334) : moins compact que le quart le plus aéré
     * du corpus, ce n'est plus le corpus. Borne UNILATÉRALE et c'est assumé —
     * plus lourd que la médiane reste dans l'idiome, plus aéré en sort.
     *
     * ⚠ À ne pas surinterpréter : mesuré APRÈS coup, le candidat du tour 1 qui a
     * motivé cette garde vaut 0,595 de masse — au-dessus de la médiane du corpus
     * et de `black-world1`. **Cette garde ne l'aurait pas attrapé.** Elle est
     * justifiée par la distribution du corpus, pas par ce cas-là.
     */
    /*
     * ACCENT SIGNIFICATIF. Une marque à deux couleurs dont la seconde couvre 4 %
     * de l'encre n'a pas deux couleurs, elle a une couleur et un confetti. Mesuré
     * sur les 36 pièces du corpus à deux couleurs ou plus : la part de l'accent
     * fait 0,466 en médiane, 0,203 au p25, 0,088 au p10.
     *
     * Plancher retenu : le p10, PAS le p25 — et c'est calibré sur la cible du
     * mandat. `black-world1` porte un accent de 0,136, sous le p25. Un plancher
     * au p25 refuserait la pièce même qu'on doit égaler. On prend donc le
     * quantile le plus lâche qui garde la cible dedans, et qui refuse quand même
     * les 0,046 du candidat qui a motivé la borne.
     */
    {
      nom: 'accent_significatif',
      passe:
        accentMin <= 0 ||
        regions.length < 2 ||
        Math.min(...regions.map((r) => r.part)) >= accentMin,
      mesure: regions.length < 2 ? `${regions.length} couleur — sans objet` : `parts ${regions.map((r) => `${r.hex} ${r.part}`).join(' · ')}`,
      attendu: `si 2 couleurs, la plus petite >= ${accentMin} (p10 du corpus ; black-world1 = 0,136)`,
    },
    /*
     * AUCUNE COULEUR ENCLAVÉE. La borne qui attrape réellement l'aplat orange
     * percé d'un trou gris, là où une borne de proportion échouait.
     *
     * Historique de cette borne, parce qu'il compte : j'ai d'abord posé « le
     * neutre doit dominer, plancher p25 = 0,424 ». Elle refusait le candidat
     * fautif (0,249), mais la mesure a montré qu'elle refusait aussi TROIS
     * exemplaires canoniques du corpus — `welllogo` (W tout en or, 2 % de neutre),
     * `goldenlogo` (0 %) et `logo2` (25 %). Aucun plancher sur la part de neutre
     * ne peut à la fois admettre une marque monochrome dorée et refuser un aplat
     * orange. La proportion n'était pas le bon axe.
     *
     * Le bon axe est la TOPOLOGIE. Dans le corpus, une seconde couleur est soit
     * toute la marque, soit une zone qui AFFLEURE le bord de la silhouette — le
     * lobe cyan de `black-world1` mord le bord bas-droite. Jamais un îlot posé au
     * milieu d'un champ de l'autre couleur. Le trou gris de l'aplat orange est
     * exactement cet îlot.
     */
    {
      nom: 'aucune_couleur_enclavee',
      passe: regions.length < 2 || regions.every((r) => r.touche_le_bord),
      mesure: regions.length < 2
        ? `${regions.length} couleur — sans objet`
        : regions.map((r) => `${r.hex} ${r.touche_le_bord ? 'affleure' : 'ENCLAVÉE'}`).join(' · '),
      attendu: 'chaque couleur affleure le bord de la silhouette (aucun îlot au centre d\'un champ)',
    },
    {
      nom: 'masse',
      passe: m.masse !== null && m.masse >= masseMin,
      mesure: m.masse === null ? 'non mesurable' : `${m.masse} d'encre dans sa boîte`,
      attendu: `>= ${masseMin} (p25 du corpus · médiane 0,439 · black-world1 0,513 · vulcainlogo 0,240)`,
    },
  ]
  return g
}

// ─── La lecture des glyphes ──────────────────────────────────────────────────

/**
 * La garde qui manquait vraiment. Le premier candidat NOX passait les quinze
 * gardes d'hygiène et la critique de forme, et son « N » était illisible : la
 * marque se lisait comme un panneau d'interdiction. Aucune mesure de conformité
 * ne voit ça — mais une TRANSCRIPTION le voit.
 *
 * C'est la leçon la plus chère du run 5.9, réappliquée : au run 5.8 l'OCR lisait
 * le mot ATTENDU au lieu des lettres DESSINÉES, et « FRU VTZ » est passé pour
 * « FRUITZ » avec un journal disant « orthographe parfaite ». Ici le modèle ne
 * reçoit jamais le mot attendu : on lui demande ce qu'il lit, et le CODE compare.
 *
 * Monogramme : l'ensemble des lettres lues doit être exactement l'ensemble
 * attendu. Emblème pur : zéro lettre lue — le mandat dit « ZÉRO lettrage ».
 */
export function decisionGlyphes(
  lues: string[],
  attendu: string | null
): { passe: boolean; detail: string } {
  const propres = [...new Set(lues.map((c) => String(c).trim().toUpperCase()).filter((c) => /^[A-Z]$/.test(c)))].sort()
  if (attendu === null) {
    /*
     * ZÉRO LETTRAGE, pas zéro forme-de-lettre. La version stricte (« aucune
     * lettre lue ») a été REFUTÉE en jouant, et par la cible elle-même :
     *
     *  - au calibrage, le même instrument nomme `vulcainlogo` « letter V ». La
     *    garde stricte refuse donc la pièce que le mandat désigne comme cible.
     *  - au tour 2 de VULCAIN, la boucle a produit un V ailé d'UNE seule
     *    silhouette — le « DEUX AILES, rien d'autre » que l'opérateur demandait
     *    à la fin du run 6. Refusé pour un « V » lu. Aux tours 3 et 4 la boucle
     *    s'est éloignée de la cible (un U, puis un écusson à étoile) et a
     *    convergé sur le pire des trois.
     *
     * Une garde mal calibrée ne fait pas que refuser : elle PILOTE le design
     * loin de la cible, et elle le fait en silence. Le mandat dit « zéro
     * lettrage » — un mot, un nom. Une silhouette qui évoque une lettre unique
     * n'est pas du lettrage : c'est ce que fait la cible. Le seuil est donc 2.
     */
    return {
      passe: propres.length <= 1,
      detail: propres.length
        ? `${propres.length} lettre(s) lue(s) : ${propres.join('')}${propres.length <= 1 ? ' — une forme-de-lettre unique, toléré (la cible en est une)' : " — c'est du LETTRAGE, l'emblème doit être muet"}`
        : 'aucune lettre lue',
    }
  }
  const cible = [...new Set(attendu.toUpperCase().split(''))].sort()
  const manquantes = cible.filter((c) => !propres.includes(c))
  const enTrop = propres.filter((c) => !cible.includes(c))
  return {
    passe: manquantes.length === 0 && enTrop.length === 0,
    detail:
      manquantes.length || enTrop.length
        ? `lu « ${propres.join('') || 'rien'} » pour « ${cible.join('')} »${manquantes.length ? ` · manque ${manquantes.join('')}` : ''}${enTrop.length ? ` · en trop ${enTrop.join('')}` : ''}`
        : `lu « ${propres.join('')} », conforme`,
  }
}

// ─── « Est-ce que ça VEUT DIRE quelque chose » ────────────────────────────────

/*
 * Le mot de la fin de cette session, et il a été payé pour être compris.
 *
 * Le premier VULCAIN conforme passait DIX-HUIT gardes sur dix-huit : une seule
 * forme, deux couleurs, aucun contour, masse 0,771, IoU à 64 px 0,968, courbes
 * propres, épaisseur constante, zéro lettre lue. C'était un aplat orange percé
 * d'un trou gris octogonal. Il ne représente rien.
 *
 * Aucune mesure de CONFORMITÉ ne peut attraper ça, parce que le défaut n'est pas
 * une non-conformité. La question est sémantique : un inconnu voit-il QUELQUE
 * CHOSE. On la pose donc comme la garde de glyphes pose la sienne — le modèle
 * NOMME ce qu'il voit, sans jamais recevoir la réponse attendue, et le code
 * tranche sur le nom.
 *
 * Le code tranche avec un lexique de mots qui ne désignent AUCUN sujet : de la
 * géométrie pure, du vide, ou le mot « logo » lui-même. Si tous les mots
 * porteurs du nom sont dans ce lexique, la marque ne représente rien. « winged V »
 * passe (« winged » n'y est pas), « octagon inside a circle » échoue.
 *
 * Ce que ce lexique ne contient PAS, délibérément : diamond, star, shield, wing,
 * hammer, anvil, flame, mountain, crown, bolt. Ce sont des sujets de logo, pas
 * de la géométrie — les y mettre transformerait la garde en juge de goût.
 */
export const LEXIQUE_SANS_SUJET = new Set([
  // géométrie pure
  'circle', 'circles', 'circular', 'square', 'squares', 'rectangle', 'rectangular', 'triangle',
  'triangular', 'octagon', 'octagonal', 'hexagon', 'hexagonal', 'pentagon', 'heptagon', 'polygon',
  'polygonal', 'oval', 'ellipse', 'elliptical', 'semicircle', 'semi', 'circlehalf', 'half',
  'trapezoid', 'trapezoidal', 'quadrilateral', 'arc', 'arcs', 'ring', 'rings', 'dot', 'dots',
  'bar', 'bars', 'stripe', 'stripes', 'line', 'lines', 'curve', 'curves', 'angle', 'angles',
  'cutout', 'cutouts', 'hole', 'holes', 'notch', 'notches', 'wedge', 'blob', 'blobs',
  // vide et indétermination
  'nothing', 'none', 'unclear', 'unknown', 'unrecognizable', 'unrecognisable', 'indeterminate',
  'undefined', 'ambiguous', 'meaningless', 'generic', 'plain', 'simple', 'random',
  // qualificatifs sans sujet
  'abstract', 'geometric', 'geometrical', 'geometry', 'shape', 'shapes', 'form', 'forms',
  'figure', 'block', 'blocks', 'solid', 'rounded', 'curved', 'flat', 'area', 'areas', 'field',
  'patch', 'mass', 'object', 'thing',
  // les mots méta : nommer « un logo » ne nomme rien
  'logo', 'logos', 'icon', 'icons', 'emblem', 'emblems', 'badge', 'badges', 'mark', 'marks',
  'symbol', 'symbols', 'sign', 'signs', 'graphic', 'graphics', 'design', 'designs', 'image',
  // liaisons
  'a', 'an', 'the', 'of', 'in', 'on', 'with', 'and', 'or', 'inside', 'over', 'under', 'within',
  'two', 'three', 'four', 'one', 'large', 'small', 'big', 'thick', 'thin', 'white', 'grey',
  'gray', 'black', 'orange', 'red', 'blue', 'green', 'cyan', 'yellow', 'purple', 'pink',
])

/**
 * Le nom donné par le modèle désigne-t-il un SUJET ? Vrai dès qu'un mot porteur
 * sort du lexique des mots sans sujet.
 */
export function motsPorteurs(nom: string | null | undefined): string[] {
  return String(nom ?? '')
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((m) => m && !LEXIQUE_SANS_SUJET.has(m))
}

export function decisionSujet(nom: string | null | undefined): { passe: boolean; detail: string } {
  const brut = String(nom ?? '').trim()
  if (!brut) return { passe: false, detail: 'aucun nom donné' }
  const mots = brut
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean)
  if (!mots.length) return { passe: false, detail: `nom vide de mots : « ${brut} »` }
  const porteurs = mots.filter((m) => !LEXIQUE_SANS_SUJET.has(m))
  return {
    passe: porteurs.length > 0,
    detail: porteurs.length
      ? `lu « ${brut} » — porte un sujet (${porteurs.join(', ')})`
      : `lu « ${brut} » — que de la géométrie, aucun sujet`,
  }
}

// ─── La sélection de piste du DA (phase 2) ───────────────────────────────────

/*
 * Ces types et ces fonctions vivent ici, dans le module pur, et pas dans
 * `v7-da.ts` : la règle de sélection est du CODE, et faire évoluer du code ne doit
 * pas coûter deux appels de DA. Les phases 3 et 7 RECALCULENT la piste retenue
 * depuis le JSON déjà sur le disque au lieu de lire le champ `choisie` — c'est la
 * leçon du run 6 (« le concept rendu est recalculé, jamais lu tel quel »).
 */

export type Reduction = {
  retire: string[]
  pourquoi: string
  forme_reduite: string
  nb_elements: number
  nb_couleurs: number
  palette_hex: string[]
  /** Ce que la forme REPRÉSENTE après réduction, en un ou deux mots. */
  sujet: string
}

export type Piste = {
  nom: string
  forme: string
  nb_elements: number
  nb_couleurs: number
  /** Ce que la forme REPRÉSENTE avant réduction, en un ou deux mots. */
  sujet: string
  construction_geometrique: string
  reduction: Reduction
}

export type Verdict = { index: number; motif: string; hors_bornes: string[] }

export function mots(phrase: string): number {
  return phrase.trim().split(/\s+/).filter(Boolean).length
}

/** Les violations de bornes d'une piste, nommées avec la valeur fautive. */
export function violations(
  p: Piste,
  nbElementsMax: number,
  nbCouleursMax: number,
  pm: { familles_retenues: number[] }
): string[] {
  const v: string[] = []
  const r = p.reduction
  if (!r) return ['aucune passe de réduction fournie']
  if (!Number.isInteger(r.nb_elements) || r.nb_elements < 1) v.push(`nb_elements après réduction invalide (${r.nb_elements})`)
  else if (r.nb_elements > nbElementsMax) v.push(`nb_elements ${r.nb_elements} > borne ${nbElementsMax}`)
  if (!Number.isInteger(r.nb_couleurs) || r.nb_couleurs < 1) v.push(`nb_couleurs après réduction invalide (${r.nb_couleurs})`)
  else if (r.nb_couleurs > nbCouleursMax) v.push(`nb_couleurs ${r.nb_couleurs} > borne ${nbCouleursMax}`)
  const pal = Array.isArray(r.palette_hex) ? r.palette_hex : []
  if (pal.length !== r.nb_couleurs) v.push(`palette_hex ${pal.length} entrée(s) pour nb_couleurs ${r.nb_couleurs}`)
  if (pal.some((c) => !/^#[0-9a-fA-F]{6}$/.test(c))) v.push(`palette_hex mal formée : ${pal.join(', ')}`)
  /*
   * La conformité de palette au corpus se juge ICI et pas en phase 3.
   * Constaté en jouant : le DA avait proposé `#FF4500 + #FF8C00` pour VULCAIN —
   * deux oranges saturés, aucune couleur neutre là où 49 % des entrées du corpus
   * le sont. La palette est fixée pour tout le sujet : la garde de phase 3
   * l'aurait refusée à chaque tour, sans qu'aucun tour puisse la corriger, soit
   * huit tours de traceur payés pour un échec inévitable. Une contrainte
   * irréparable en aval se vérifie en amont.
   */
  const conf = paletteConforme(pal, pm)
  if (!conf.passe) v.push(`palette hors idiome du corpus — ${conf.detail}`)
  /*
   * LE SUJET DOIT SURVIVRE À LA RÉDUCTION. Constaté en jouant : la piste
   * « Monolithic Volcano Cap » décrivait un volcan, et sa réduction a retiré
   * « les trois entailles au sommet » — c'est-à-dire la seule chose qui en
   * faisait un volcan. Il restait « un demi-cercle massif posé sur un trapèze »,
   * plus court, parfaitement conforme, et sans sujet. La marque rendue a été un
   * aplat orange percé d'un trou.
   * Un graphiste enlève, mais il n'enlève pas le sujet. C'est vérifiable :
   * le sujet déclaré avant et après doit rester le même, et désigner quelque
   * chose (même lexique que la garde de phase 3).
   */
  const sujetAvant = decisionSujet(p.sujet)
  const sujetApres = decisionSujet(r.sujet)
  if (!sujetApres.passe) v.push(`la réduction a effacé le sujet — ${sujetApres.detail}`)
  else if (!sujetAvant.passe) v.push(`la piste ne déclare aucun sujet avant réduction — ${sujetAvant.detail}`)
  else if (motsPorteurs(p.sujet).every((m) => !motsPorteurs(r.sujet).includes(m)))
    v.push(`le sujet a CHANGÉ à la réduction : « ${p.sujet} » puis « ${r.sujet} »`)
  if (!r.forme_reduite || r.forme_reduite.trim().length < 12) v.push('forme_reduite vide ou trop courte')
  if (!Array.isArray(r.retire) || r.retire.length === 0) v.push('la passe de réduction ne retire rien')
  return v
}

/**
 * « La piste qui respecte les bornes et dont la description contient le moins
 * d'éléments. En cas d'égalité, la première. » — mandat, littéralement.
 * Départage ensuite par nb_couleurs puis par longueur de la phrase réduite : deux
 * critères qui vont dans le même sens que le premier, et déterministes.
 */
export function choisis(
  pistes: Piste[],
  nbElementsMax: number,
  nbCouleursMax: number,
  pm: { familles_retenues: number[] }
): Verdict {
  const evaluees = pistes.map((p, index) => ({ p, index, v: violations(p, nbElementsMax, nbCouleursMax, pm) }))
  const dansLesBornes = evaluees.filter((e) => e.v.length === 0)

  if (dansLesBornes.length) {
    /*
     * Départage : nombre de formes, puis nombre de couleurs, puis ORDRE
     * D'APPARITION — le mandat dit « en cas d'égalité, la première ».
     *
     * Un départage par LONGUEUR DE PHRASE a été essayé et retiré. Il a
     * sélectionné, pour VULCAIN, la piste dont la réduction avait effacé le
     * sujet : elle était la plus courte parce qu'elle ne disait plus rien. La
     * brièveté n'est pas la simplicité — une phrase peut être courte parce que la
     * forme est simple, ou courte parce qu'on l'a vidée.
     */
    const gagnante = dansLesBornes.sort(
      (a, c) =>
        a.p.reduction.nb_elements - c.p.reduction.nb_elements ||
        a.p.reduction.nb_couleurs - c.p.reduction.nb_couleurs ||
        a.index - c.index
    )[0]!
    return {
      index: gagnante.index,
      motif: `dans les bornes · ${gagnante.p.reduction.nb_elements} élément(s), ${gagnante.p.reduction.nb_couleurs} couleur(s), sujet « ${gagnante.p.reduction.sujet} », ${mots(gagnante.p.reduction.forme_reduite)} mots`,
      hors_bornes: [],
    }
  }

  // Aucune piste dans les bornes : on prend la moins fautive et on le DIT.
  const moinsFautive = evaluees.sort((a, c) => a.v.length - c.v.length || a.index - c.index)[0]!
  return {
    index: moinsFautive.index,
    motif: `AUCUNE piste dans les bornes — retenue la moins fautive (${moinsFautive.v.length} violation(s))`,
    hors_bornes: moinsFautive.v,
  }
}

// ─── Score d'un tour ─────────────────────────────────────────────────────────

export function score(gardesTour: Garde[], c: Critique | null, m: MesureSvg): number {
  const passees = gardesTour.filter((g) => g.passe).length
  const formeOk = (c?.courbes_propres ? 1 : 0) + (c?.epaisseur_constante ? 1 : 0)
  return passees * 10 + formeOk * 3 + m.iou64
}

