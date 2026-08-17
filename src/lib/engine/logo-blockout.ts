/*
 * Run 6 (§5) — LE BLOCKOUT DE COMPOSITION : conditionner la CONSTRUCTION.
 *
 * Le §4.1 de la passation prouve que le modèle image COPIE presque parfaitement
 * une image jointe. On n'exploitait ça que pour le style. Ici on l'exploite
 * aussi pour la construction — exactement la dimension qui manque aux trois
 * candidats rejetés (« mot + petite tranche posée sur le Z » là où les gagnants
 * du plafond ont un emblème majeur DANS lequel le lettrage vit).
 *
 * Le blockout est une image À PLAT dessinée localement en SVG/sharp, ZÉRO
 * appel API : canevas 1024², fond #808080, l'emblème en primitive pleine
 * #303030, le mot en vraie police du catalogue #E8E8E8. Rien d'autre : pas de
 * matière, pas de lumière, pas de couleur.
 *
 * CE N'EST PAS le pipeline calques du run 5.7. En 5.7 le lettrage local était
 * COMPOSITÉ DANS LA SORTIE — d'où l'effet sticker structurel. Ici le blockout
 * est une ENTRÉE que le modèle redessine intégralement ; rien de local
 * n'atterrit dans l'image finale. Bénéfice secondaire attendu : l'orthographe
 * est ancrée par la forme, donc le taux de rejet OCR devrait chuter.
 */

import sharp from 'sharp'
import { renderLettrage, resolveFont } from './lettrage'
import {
  contratComposition,
  overlapRatio,
  tauxDebordement,
  DEBORDEMENT_MAX,
  DEBORDEMENT_MIN,
  OVERLAP_BLOCKOUT_AUTRES,
  OVERLAP_BLOCKOUT_CONTENANT,
  type Bbox,
  type Masque,
} from './overlap'

export const BLOCKOUT_COTE = 1024
const FOND_HEX = '#808080'
const EMBLEME_HEX = '#303030'
const MOT_HEX = '#E8E8E8'

export const BLOCKOUT_SHAPES = ['circle', 'crescent', 'arc_band', 'shield', 'wedge', 'polygon'] as const
export type BlockoutShape = (typeof BLOCKOUT_SHAPES)[number]

/*
 * PATCH v6 P3 — LA POLICE DU BLOCKOUT N'EST PAS UNE VARIABLE.
 *
 * La planche `blockout-crescent.png` était composée dans une anglaise : les
 * glyphes se lisaient « FRUJTZ ». Or l'un des deux bénéfices annoncés du
 * blockout est d'ANCRER L'ORTHOGRAPHE PAR LA FORME. Une police à glyphes
 * ambigus annule ce bénéfice et risque d'injecter la faute dans le rendu.
 *
 * Le style typographique vient des références 1-3, jamais du blockout — le
 * blockout ne porte que la GÉOMÉTRIE. La police sort donc de la sortie du DA :
 * c'est une constante de code. Archivo Black : grotesque grasse, large, aucun
 * glyphe ambigu (I/J/l distincts), déjà embarquée dans le catalogue.
 */
export const BLOCKOUT_FONT = 'Archivo Black'

export type BlockoutSpec = {
  emblem_shape: BlockoutShape
  emblem_bbox: Bbox
  word_bbox: Bbox
}

/** L'étiquette de REFERENCE 4 — dit au modèle que c'est un SQUELETTE à
 *  redessiner, jamais un rendu à imiter. */
export const BLOCKOUT_LABEL =
  'REFERENCE 4 — COMPOSITION BLOCKOUT: follow this layout — the position, the relative scale and the overlap of the emblem and the lettering. Redraw everything as custom display type and finished artwork in the style, materials and quality of references 1 to 3:'

/** Le plancher d'overlap imposé au blockout, par archétype (§5). */
export function plancherOverlap(archetype: string): number {
  return archetype === 'CONTAINER' || archetype === 'ENTWINED'
    ? OVERLAP_BLOCKOUT_CONTENANT
    : OVERLAP_BLOCKOUT_AUTRES
}

// ── validation : le blockout est une CONTRAINTE, pas une suggestion ──────────

function bboxValide(raw: unknown): Bbox | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null
  const nums = raw.map((v) => Number(v))
  if (nums.some((n) => !Number.isFinite(n) || n < -0.5 || n > 1.5)) return null
  const [x, y, w, h] = nums as Bbox
  if (w <= 0.02 || h <= 0.02) return null
  return [x, y, w, h]
}

export function validateBlockout(
  raw: unknown,
  opts: { archetype: string }
): { spec: BlockoutSpec } | { errors: string[] } {
  const b = raw as Partial<BlockoutSpec> | null
  const errors: string[] = []
  if (!b || typeof b !== 'object') return { errors: ['blockout missing — every concept ships a composition skeleton'] }

  const shape = (BLOCKOUT_SHAPES as readonly string[]).includes(String(b.emblem_shape))
    ? (b.emblem_shape as BlockoutShape)
    : null
  if (!shape) {
    errors.push(`blockout.emblem_shape is "${String(b.emblem_shape)}" — must be one of ${BLOCKOUT_SHAPES.join(' / ')}`)
  }
  const emblem = bboxValide(b.emblem_bbox)
  if (!emblem) errors.push(`blockout.emblem_bbox is invalid (${JSON.stringify(b.emblem_bbox)}) — expected [x, y, w, h] normalized 0..1`)
  const word = bboxValide(b.word_bbox)
  if (!word) errors.push(`blockout.word_bbox is invalid (${JSON.stringify(b.word_bbox)}) — expected [x, y, w, h] normalized 0..1`)

  if (emblem && word) {
    const ratio = overlapRatio(emblem, word)
    const plancher = plancherOverlap(opts.archetype)
    if (ratio < plancher) {
      errors.push(
        `blockout overlap ratio is ${ratio.toFixed(2)} but ${opts.archetype} requires at least ${plancher} — the emblem must CONTAIN, CROSS or CARRY the lettering, not sit next to it. Enlarge emblem_bbox around word_bbox, or move it so it crosses the word`
      )
    }
  }

  if (errors.length) return { errors }
  return {
    spec: {
      emblem_shape: shape!,
      emblem_bbox: emblem!,
      word_bbox: word!,
    },
  }
}

// ── dessin : primitives SVG pleines, zéro fioriture ─────────────────────────

function px(bbox: Bbox): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.round(bbox[0] * BLOCKOUT_COTE),
    y: Math.round(bbox[1] * BLOCKOUT_COTE),
    w: Math.max(2, Math.round(bbox[2] * BLOCKOUT_COTE)),
    h: Math.max(2, Math.round(bbox[3] * BLOCKOUT_COTE)),
  }
}

/*
 * PATCH v6 P2 — RÈGLES DE GÉNÉRATION : quatre formes sur six étaient des badges.
 *
 * `circle`, `polygon` et `shield` étaient des plaques pleines : mot posé
 * dessus, overlap de bbox ≈ 1,00, mesure au maximum — et construction
 * exactement identique à la signature sticker combattue depuis le 5.7.
 *
 * Elles sont désormais ÉVIDÉES (anneau, cadre) : le lettrage occupe le creux
 * et FRANCHIT le contour au lieu de reposer sur un aplat. `crescent`,
 * `arc_band` et `wedge` sont les gabarits de référence : ils portaient déjà la
 * bonne relation.
 */
export const FORMES_EVIDEES_PAR_P2 = new Set<BlockoutShape>(['circle', 'polygon', 'shield'])

/** Les deux primitives d'une forme : son contour extérieur PLEIN (la
 *  silhouette, sur laquelle se mesure le débordement) et son creux éventuel. */
function primitives(shape: BlockoutShape, bbox: Bbox): { plein: string; creux: string | null } {
  const { x, y, w, h } = px(bbox)
  const cx = x + w / 2
  const cy = y + h / 2
  const rx = w / 2
  const ry = h / 2
  const ellipse = (r1: number, r2: number, dx = 0) => `<ellipse cx="${cx + dx}" cy="${cy}" rx="${r1}" ry="${r2}" fill="white"/>`
  const hexagone = (facteur: number) =>
    `<polygon points="${Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 3) * i - Math.PI / 2
      return `${(cx + rx * facteur * Math.cos(a)).toFixed(1)},${(cy + ry * facteur * Math.sin(a)).toFixed(1)}`
    }).join(' ')}" fill="white"/>`
  const ecusson = (facteur: number) => {
    const ww = w * facteur
    const hh = h * facteur
    const xx = cx - ww / 2
    const yy = cy - hh / 2
    const d = [
      `M ${xx} ${yy}`,
      `L ${xx + ww} ${yy}`,
      `L ${xx + ww} ${yy + hh * 0.58}`,
      `Q ${xx + ww} ${yy + hh * 0.86} ${cx} ${yy + hh}`,
      `Q ${xx} ${yy + hh * 0.86} ${xx} ${yy + hh * 0.58}`,
      'Z',
    ].join(' ')
    return `<path d="${d}" fill="white"/>`
  }

  switch (shape) {
    case 'circle':
      // anneau épais : le mot vit dans le creux et traverse la bande
      return { plein: ellipse(rx, ry), creux: ellipse(rx * 0.66, ry * 0.66) }
    case 'crescent': {
      // disque plein moins un disque décalé — le croissant du gagnant B
      return { plein: ellipse(rx, ry), creux: ellipse(rx * 0.82, ry * 0.82, rx * 0.42) }
    }
    case 'arc_band': {
      // anneau fin : le lettrage le traverse (ENLACEMENT)
      const epaisseur = Math.max(6, Math.min(rx, ry) * 0.28)
      return { plein: ellipse(rx, ry), creux: ellipse(Math.max(1, rx - epaisseur), Math.max(1, ry - epaisseur)) }
    }
    case 'shield':
      // cadre d'écusson : la bande centrale porte le mot, qui sort aux flancs
      return { plein: ecusson(1), creux: ecusson(0.72) }
    case 'wedge': {
      // quartier : secteur plein, pointe au centre bas — gabarit de référence
      const d = [
        `M ${cx} ${y + h}`,
        `L ${x} ${y + h * 0.25}`,
        `Q ${cx} ${y - h * 0.12} ${x + w} ${y + h * 0.25}`,
        'Z',
      ].join(' ')
      return { plein: `<path d="${d}" fill="white"/>`, creux: null }
    }
    case 'polygon':
      // cadre hexagonal
      return { plein: hexagone(1), creux: hexagone(0.66) }
  }
}

function svgCadre(contenu: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BLOCKOUT_COTE}" height="${BLOCKOUT_COTE}">${contenu}</svg>`
}

/** L'emblème TEL QU'IL EST DESSINÉ : creusé pour les formes évidées. */
export function emblemeSvg(shape: BlockoutShape, bbox: Bbox, couleur = EMBLEME_HEX): string {
  const { plein, creux } = primitives(shape, bbox)
  if (!creux) return svgCadre(plein.replace('fill="white"', `fill="${couleur}"`))
  return svgCadre(
    `<mask id="m"><rect width="${BLOCKOUT_COTE}" height="${BLOCKOUT_COTE}" fill="black"/>${plein}${creux.replace(
      'fill="white"',
      'fill="black"'
    )}</mask><rect width="${BLOCKOUT_COTE}" height="${BLOCKOUT_COTE}" fill="${couleur}" mask="url(#m)"/>`
  )
}

/** La SILHOUETTE PLEINE — contour extérieur, trous bouchés. C'est le masque
 *  contre lequel le débordement se mesure (voir la convention dans overlap.ts :
 *  un mot dans le creux d'un anneau n'est pas « posé à côté »). */
export function emblemeSilhouetteSvg(shape: BlockoutShape, bbox: Bbox): string {
  return svgCadre(primitives(shape, bbox).plein.replace('fill="white"', 'fill="#ffffff"'))
}

/** Le lettrage du blockout, découpé à la boîte exacte de word_bbox. La police
 *  est la CONSTANTE P3 : le blockout ne porte que la géométrie. */
async function motRaster(spec: BlockoutSpec, mot: string, couleur: string): Promise<Buffer> {
  const cible = px(spec.word_bbox)
  const lettrage = await renderLettrage(mot, { famille: BLOCKOUT_FONT, taillePx: 220, couleur })
  return sharp(lettrage.png)
    .extract({
      left: lettrage.textBox.left,
      top: lettrage.textBox.top,
      width: Math.min(lettrage.textBox.width, lettrage.width - lettrage.textBox.left),
      height: Math.min(lettrage.textBox.height, lettrage.height - lettrage.textBox.top),
    })
    .resize({ width: cible.w, height: cible.h, fit: 'fill' })
    .png()
    .toBuffer()
}

/**
 * Le blockout complet : fond gris, emblème (évidé si forme fermée), mot en
 * police constante par dessus. Aucun effet — c'est un squelette de position,
 * pas un rendu.
 */
export async function renderBlockout(spec: BlockoutSpec, mot: string): Promise<Buffer> {
  const fond = sharp({
    create: { width: BLOCKOUT_COTE, height: BLOCKOUT_COTE, channels: 4, background: FOND_HEX },
  })
  const cible = px(spec.word_bbox)
  return fond
    .composite([
      { input: Buffer.from(emblemeSvg(spec.emblem_shape, spec.emblem_bbox)), top: 0, left: 0 },
      { input: await motRaster(spec, mot, MOT_HEX), top: cible.y, left: cible.x },
    ])
    .png()
    .toBuffer()
}

// ── PATCH v6 P2 — la mesure du blockout, EN SHARP, zéro appel ───────────────

/** Un masque plein cadre 1024², un octet par pixel (0 = vide). */
async function masquePleinCadre(input: Buffer, top = 0, left = 0): Promise<Masque> {
  const canevas = await sharp({
    create: { width: BLOCKOUT_COTE, height: BLOCKOUT_COTE, channels: 4, background: '#00000000' },
  })
    .composite([{ input, top, left }])
    .png()
    .toBuffer()
  // le canal ALPHA : ce qui est peint, quelle que soit sa couleur
  const data = await sharp(canevas).extractChannel(3).raw().toBuffer()
  return { data: new Uint8Array(data), width: BLOCKOUT_COTE, height: BLOCKOUT_COTE }
}

export type MesureBlockout = {
  overlapBbox: number
  debordement: number
  contrat: ReturnType<typeof contratComposition>
}

/**
 * Les deux métriques du blockout, sur les MÊMES rasters que le dessin :
 *   - overlap de bbox (la géométrie que le DA a demandée) ;
 *   - débordement de silhouette (ce que le mot fait réellement à la forme).
 * Le mot est rastérisé une seule fois et le masque d'emblème est sa silhouette
 * PLEINE : voir la convention documentée dans overlap.ts.
 */
export async function mesureBlockout(spec: BlockoutSpec, mot: string, archetype: string): Promise<MesureBlockout> {
  const cible = px(spec.word_bbox)
  const [masqueMot, masqueEmbleme] = await Promise.all([
    masquePleinCadre(await motRaster(spec, mot, '#ffffff'), cible.y, cible.x),
    masquePleinCadre(Buffer.from(emblemeSilhouetteSvg(spec.emblem_shape, spec.emblem_bbox))),
  ])
  const debordement = tauxDebordement(masqueMot, masqueEmbleme)
  const overlapBbox = overlapRatio(spec.emblem_bbox, spec.word_bbox)
  return {
    overlapBbox,
    debordement,
    contrat: contratComposition({ archetype, overlap: overlapBbox, debordement }),
  }
}

/**
 * Le contrat P2 vérifié sur le blockout d'un concept — appelé par le DA v6
 * APRÈS la validation géométrique. Renvoie des messages CITABLES : le modèle
 * reçoit le chiffre mesuré et ce qu'il doit changer, jamais « invalide ».
 */
export async function verifieContratBlockout(
  spec: BlockoutSpec,
  mot: string,
  archetype: string
): Promise<{ mesure: MesureBlockout; errors: string[] }> {
  const mesure = await mesureBlockout(spec, mot, archetype)
  const errors: string[] = []
  if (archetype === 'CONTAINER' || archetype === 'ENTWINED') {
    if (mesure.debordement < DEBORDEMENT_MIN) {
      errors.push(
        `blockout: the word sits ENTIRELY inside the emblem silhouette (overflow ${mesure.debordement.toFixed(
          2
        )} < ${DEBORDEMENT_MIN}) — that is a badge, a word laid on a plate. Widen word_bbox past the emblem contour, or shift it so at least one letter breaks the silhouette (target ${DEBORDEMENT_MIN}-${DEBORDEMENT_MAX})`
      )
    } else if (mesure.debordement > DEBORDEMENT_MAX) {
      errors.push(
        `blockout: the word overflows the emblem silhouette by ${mesure.debordement.toFixed(
          2
        )} (max ${DEBORDEMENT_MAX}) — the emblem no longer contains it. Enlarge emblem_bbox or pull word_bbox back inside`
      )
    }
  }
  return { mesure, errors }
}

/** La police du blockout est embarquée — vérifié au démarrage plutôt qu'au
 *  premier rendu (P3 : c'est une constante, elle ne doit jamais manquer). */
export function policeBlockoutDisponible(): boolean {
  return Boolean(resolveFont(BLOCKOUT_FONT))
}
