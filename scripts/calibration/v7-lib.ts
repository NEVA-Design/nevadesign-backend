/*
 * Run 7 — bibliothèque de MESURE. Tout ce qui tranche un passage/échec de la
 * session 7 est ici, et tout est déterministe : sharp, librsvg, arithmétique.
 * Le modèle mesure ce qu'un code ne sait pas voir (« est-ce que la courbe est
 * propre »), le code mesure tout le reste — et c'est le code qui décide.
 *
 * Trois choix de méthode, tranchés ici et reportés dans le rapport :
 *
 * 1. `nb_elements` se mesure en COMPOSANTES CONNEXES du rendu, pas en nombre de
 *    <path>. Le mandat définit lui-même l'unité : « combien de formes SÉPARÉES
 *    composent la marque (un B = 1) ». Or la cible `vulcainlogo` est UNE
 *    silhouette (un V ailé) qui demande 6 à 8 contours pour être tracée : une
 *    garde sur le nombre de chemins interdirait de dessiner la cible elle-même.
 *    Le nombre de chemins est mesuré et publié quand même — il n'est juste pas
 *    la garde.
 *
 * 2. `luminance` / `contraste` / `saturation` du fond se mesurent sur les pixels
 *    HORS de la boîte de la marque. Mesurer sur l'image entière fait compter la
 *    marque — blanche et pleine — dans la luminance du fond, et un fond bien
 *    enfoncé sort alors « trop clair ».
 *
 * 3. La lisibilité à 64 px se mesure par l'IoU entre le rendu 64 px remonté au
 *    nearest et le rendu 512 px. C'est exactement « qu'est-ce qui disparaît à
 *    64 px » : un détail trop fin s'évanouit sous le seuil d'alpha et l'IoU
 *    chute. Les composantes connexes à 64 doivent en plus égaler celles à 512
 *    (une forme qui fusionne avec sa voisine n'est plus lisible).
 */

import { createHash } from 'crypto'
import { readdirSync, readFileSync, statSync } from 'fs'
import { extname, join } from 'path'
import sharp from 'sharp'

// ─── Statistiques ────────────────────────────────────────────────────────────

/** Quantile par interpolation linéaire, sur une copie triée. */
export function quantile(xs: number[], q: number): number {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return NaN
  if (v.length === 1) return v[0]!
  const pos = (v.length - 1) * q
  const bas = Math.floor(pos)
  const haut = Math.ceil(pos)
  if (bas === haut) return v[bas]!
  return v[bas]! + (v[haut]! - v[bas]!) * (pos - bas)
}

export function mediane(xs: number[]): number {
  return quantile(xs, 0.5)
}

export type Resume = { n: number; p25: number; mediane: number; p75: number; min: number; max: number }

export function resume(xs: number[]): Resume {
  const v = xs.filter((x) => Number.isFinite(x))
  return {
    n: v.length,
    p25: arrondi(quantile(v, 0.25), 4),
    mediane: arrondi(quantile(v, 0.5), 4),
    p75: arrondi(quantile(v, 0.75), 4),
    min: v.length ? arrondi(Math.min(...v), 4) : NaN,
    max: v.length ? arrondi(Math.max(...v), 4) : NaN,
  }
}

export function distribution<T extends string>(xs: T[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const x of xs) out[x] = (out[x] ?? 0) + 1
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]))
}

/** La modalité majoritaire — la « médiane » d'un champ catégoriel. */
export function modalite(xs: string[]): string {
  const d = distribution(xs)
  return Object.keys(d)[0] ?? ''
}

export function arrondi(x: number, n: number): number {
  const f = 10 ** n
  return Math.round(x * f) / f
}

// ─── Inventaire du corpus ────────────────────────────────────────────────────

export const EXT_IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp'])

export type PieceCorpus = {
  slug: string
  chemin: string
  categorie: string
  largeur: number
  hauteur: number
  octets: number
  sha1: string
}

/**
 * Toutes les images joignables du dossier, récursif, dédupliquées par contenu.
 * Le dossier `PackPsd` reprend des pièces déjà présentes dans `logo serveur
 * fivem gtarp` : sans déduplication elles compteraient deux fois dans les
 * médianes, et ce sont justement les deux seules pièces halftone du corpus —
 * l'erreur serait pile sur le trait le plus discriminant.
 */
export function inventaireCorpus(
  racine: string,
  prioriteDossiers: string[] = []
): {
  pieces: PieceCorpus[]
  ecartees: Array<{ chemin: string; raison: string }>
} {
  const pieces: PieceCorpus[] = []
  const ecartees: Array<{ chemin: string; raison: string }> = []
  const vus = new Map<string, string>()

  /*
   * L'ordre de visite décide QUELLE copie d'un doublon survit. Sans priorité,
   * `PackPsd/vulcainlogo.png` (alphabétiquement premier) évinçait
   * `logo serveur fivem gtarp/vulcainlogo.png` — la pièce se retrouvait
   * rangée dans un dossier qui n'est pas une catégorie d'entraînement.
   */
  const rang = (nom: string) => {
    const i = prioriteDossiers.indexOf(nom)
    return i < 0 ? prioriteDossiers.length : i
  }

  const parcours = (dir: string, categorie: string) => {
    const noms = readdirSync(dir).sort()
    if (categorie === '') noms.sort((a, b) => rang(a) - rang(b) || a.localeCompare(b))
    for (const nom of noms) {
      const chemin = join(dir, nom)
      const st = statSync(chemin)
      if (st.isDirectory()) {
        parcours(chemin, categorie === '' ? nom : `${categorie}/${nom}`)
        continue
      }
      const ext = extname(nom).toLowerCase()
      if (!EXT_IMAGE.has(ext)) {
        ecartees.push({ chemin, raison: `extension ${ext || 'aucune'}` })
        continue
      }
      const buf = readFileSync(chemin)
      const sha1 = createHash('sha1').update(buf).digest('hex')
      const dejaVu = vus.get(sha1)
      if (dejaVu) {
        ecartees.push({ chemin, raison: `doublon exact de ${dejaVu}` })
        continue
      }
      vus.set(sha1, chemin)
      pieces.push({
        slug: `${categorie.replace(/[^a-zA-Z0-9]+/g, '-')}__${nom.replace(ext, '')}`.toLowerCase(),
        chemin,
        categorie: categorie || '(racine)',
        largeur: 0,
        hauteur: 0,
        octets: buf.length,
        sha1,
      })
    }
  }
  parcours(racine, '')
  return { pieces, ecartees }
}

/** Renseigne largeur/hauteur et écarte ce qui est sous le plancher d'analyse. */
export async function dimensionne(
  pieces: PieceCorpus[],
  minPx: number
): Promise<{ gardees: PieceCorpus[]; ecartees: Array<{ chemin: string; raison: string }> }> {
  const gardees: PieceCorpus[] = []
  const ecartees: Array<{ chemin: string; raison: string }> = []
  for (const p of pieces) {
    try {
      const meta = await sharp(p.chemin).metadata()
      const w = meta.width ?? 0
      const h = meta.height ?? 0
      if (Math.max(w, h) < minPx) {
        ecartees.push({ chemin: p.chemin, raison: `plus grand côté ${Math.max(w, h)} px < ${minPx}` })
        continue
      }
      gardees.push({ ...p, largeur: w, hauteur: h })
    } catch (err) {
      ecartees.push({ chemin: p.chemin, raison: `illisible : ${(err as Error).message}` })
    }
  }
  return { gardees, ecartees }
}

/** Une image prête à joindre : JPEG borné, base64. */
export async function jointure(chemin: string, maxPx: number, qualite = 85): Promise<string> {
  const buf = await sharp(chemin)
    .resize(maxPx, maxPx, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: qualite })
    .toBuffer()
  return buf.toString('base64')
}

export async function jointureBuffer(png: Buffer, maxPx: number, qualite = 88): Promise<string> {
  const buf = await sharp(png)
    .flatten({ background: '#1a1a1a' })
    .resize(maxPx, maxPx, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: qualite })
    .toBuffer()
  return buf.toString('base64')
}

// ─── Boîtes en box_2d (piège n°12) ───────────────────────────────────────────

/** box_2d Gemini : [ymin, xmin, ymax, xmax] en entiers 0-1000. */
export type Box2d = [number, number, number, number]

export function box2dValide(b: unknown): b is Box2d {
  if (!Array.isArray(b) || b.length !== 4) return false
  if (!b.every((x) => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 1000)) return false
  const [y0, x0, y1, x1] = b as Box2d
  return y1 > y0 && x1 > x0
}

/** Surface de la boîte rapportée au cadre, et son plus grand côté relatif. */
export function ratiosBox(b: Box2d): { aire: number; cote: number } {
  const [y0, x0, y1, x1] = b
  const h = (y1 - y0) / 1000
  const w = (x1 - x0) / 1000
  return { aire: arrondi(w * h, 4), cote: arrondi(Math.max(w, h), 4) }
}

// ─── Mesures photométriques ──────────────────────────────────────────────────

export type MesureFond = { luminance: number; contraste: number; saturation: number; pixels: number }

/**
 * Luminance moyenne, contraste (écart-type de la luminance) et saturation
 * moyenne, sur les pixels HORS de `exclure` (boîte de la marque). Tout est
 * ramené sur 0..1. Échantillonné sur 256 px de côté : la mesure est une
 * statistique de tendance, pas un contrôle de détail, et 256 px suffit pour
 * qu'elle soit stable tout en restant instantanée.
 */
export async function mesureFond(source: Buffer | string, exclure?: Box2d): Promise<MesureFond> {
  const N = 256
  const { data } = await sharp(source)
    .resize(N, N, { fit: 'fill' })
    .flatten({ background: '#000000' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  let n = 0
  let somme = 0
  let sommeCarres = 0
  let sommeSat = 0
  /*
   * La boîte exclue est DILATÉE de 2 % du cadre. Une marque ne s'arrête pas
   * net à sa boîte : anti-aliasing, glow, ombre portée débordent de quelques
   * pixels, et ces pixels-là sont clairs. Les compter dans le fond fait sortir
   * un fond bien enfoncé comme « trop clair » — mesuré : 0,0033 de luminance
   * parasite sur un fond parfaitement noir, uniquement par interpolation de
   * redimensionnement.
   */
  const MARGE = 20
  const [y0, x0, y1, x1] = exclure ?? [0, 0, 0, 0]
  const py0 = Math.floor((Math.max(0, y0 - MARGE) / 1000) * N)
  const px0 = Math.floor((Math.max(0, x0 - MARGE) / 1000) * N)
  const py1 = Math.ceil((Math.min(1000, y1 + MARGE) / 1000) * N)
  const px1 = Math.ceil((Math.min(1000, x1 + MARGE) / 1000) * N)

  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      if (exclure && y >= py0 && y < py1 && x >= px0 && x < px1) continue
      const i = (y * N + x) * 3
      const r = data[i]! / 255
      const g = data[i + 1]! / 255
      const b = data[i + 2]! / 255
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const sat = max === 0 ? 0 : (max - min) / max
      n += 1
      somme += luma
      sommeCarres += luma * luma
      sommeSat += sat
    }
  }
  if (!n) return { luminance: NaN, contraste: NaN, saturation: NaN, pixels: 0 }
  const moy = somme / n
  const variance = Math.max(0, sommeCarres / n - moy * moy)
  return {
    luminance: arrondi(moy, 4),
    contraste: arrondi(Math.sqrt(variance), 4),
    saturation: arrondi(sommeSat / n, 4),
    pixels: n,
  }
}

/**
 * Part de pixels transparents d'une image. Une pièce à fond transparent — les
 * icônes du corpus — mesure une luminance de fond de 0,000 et un contraste de
 * 0,000 dès qu'on l'aplatit sur du noir. Ce n'est pas « un fond très sombre »,
 * c'est « pas de fond » : les compter dans la médiane de luminance tire la borne
 * vers le bas sans qu'aucune pièce ne le demande.
 */
export async function partTransparente(chemin: string): Promise<number> {
  const meta = await sharp(chemin).metadata()
  if (!meta.hasAlpha) return 0
  const N = 128
  const { data } = await sharp(chemin).resize(N, N, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let n = 0
  for (let i = 0; i < N * N; i += 1) if (data[i * 4 + 3]! < 16) n += 1
  return arrondi(n / (N * N), 4)
}

// ─── Masques, composantes connexes, lisibilité ───────────────────────────────

export type Masque = { w: number; h: number; m: Uint8Array }

/**
 * Masque binaire d'opacité. Lecture en RGBA (4 canaux) puis indexation du canal
 * alpha : l'aller-retour raw en 1 canal désaligne les lignes sous sharp
 * (piège n°10 de la passation, vécu au run 5).
 */
export async function masqueOpacite(png: Buffer, taille: number, seuil = 128): Promise<Masque> {
  const { data, info } = await sharp(png)
    .resize(taille, taille, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const w = info.width
  const h = info.height
  const m = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i += 1) m[i] = data[i * 4 + 3]! >= seuil ? 1 : 0
  return { w, h, m }
}

/** Masque de l'encre d'un rendu OPAQUE : ce qui s'écarte de la couleur de fond. */
export async function masqueEncre(png: Buffer, taille: number, fond: [number, number, number], tol = 40): Promise<Masque> {
  const { data, info } = await sharp(png)
    .resize(taille, taille, { fit: 'fill' })
    .flatten({ background: { r: fond[0], g: fond[1], b: fond[2] } })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const w = info.width
  const h = info.height
  const m = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i += 1) {
    const d =
      Math.abs(data[i * 3]! - fond[0]) + Math.abs(data[i * 3 + 1]! - fond[1]) + Math.abs(data[i * 3 + 2]! - fond[2])
    m[i] = d > tol ? 1 : 0
  }
  return { w, h, m }
}

/** Composantes connexes en 8-voisinage, filtrées par surface minimale. */
export function composantes(masque: Masque, minRatio = 0.0015): { nb: number; tailles: number[] } {
  const { w, h, m } = masque
  const vu = new Uint8Array(w * h)
  const pile: number[] = []
  const tailles: number[] = []
  const minPx = Math.max(2, Math.round(minRatio * w * h))
  for (let start = 0; start < w * h; start += 1) {
    if (!m[start] || vu[start]) continue
    let taille = 0
    pile.length = 0
    pile.push(start)
    vu[start] = 1
    while (pile.length) {
      const p = pile.pop()!
      taille += 1
      const py = Math.floor(p / w)
      const px = p - py * w
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue
          const ny = py + dy
          const nx = px + dx
          if (ny < 0 || nx < 0 || ny >= h || nx >= w) continue
          const q = ny * w + nx
          if (m[q] && !vu[q]) {
            vu[q] = 1
            pile.push(q)
          }
        }
      }
    }
    if (taille >= minPx) tailles.push(taille)
  }
  return { nb: tailles.length, tailles: tailles.sort((a, b) => b - a) }
}

export function encre(masque: Masque): number {
  let n = 0
  for (let i = 0; i < masque.m.length; i += 1) n += masque.m[i]!
  return arrondi(n / masque.m.length, 4)
}

/** Boîte englobante du masque, en fractions 0..1 du cadre. */
export function boiteMasque(masque: Masque): { x0: number; y0: number; x1: number; y1: number; aire: number } | null {
  const { w, h, m } = masque
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!m[y * w + x]) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (x1 < 0) return null
  return {
    x0: x0 / w,
    y0: y0 / h,
    x1: (x1 + 1) / w,
    y1: (y1 + 1) / h,
    aire: arrondi((((x1 + 1 - x0) / w) * (y1 + 1 - y0)) / h, 4),
  }
}

/** IoU de deux masques de même dimension. */
export function iou(a: Masque, b: Masque): number {
  if (a.w !== b.w || a.h !== b.h) throw new Error('IoU sur des masques de tailles différentes')
  let inter = 0
  let union = 0
  for (let i = 0; i < a.m.length; i += 1) {
    const x = a.m[i]!
    const y = b.m[i]!
    if (x && y) inter += 1
    if (x || y) union += 1
  }
  return union ? arrondi(inter / union, 4) : 0
}

// ─── SVG : analyse statique et rendu ─────────────────────────────────────────

export type AnalyseSvg = {
  viewBox: string | null
  nbPaths: number
  nbFormesPrimitives: number
  fills: string[]
  strokes: string[]
  strokeWidths: number[]
  aText: boolean
  aGradient: boolean
  aFilter: boolean
  aImage: boolean
  aOpacite: boolean
  octets: number
}

const RE_BALISE = (nom: string) => new RegExp(`<${nom}[\\s>/]`, 'gi')

function attributsTous(svg: string, attr: string): string[] {
  const re = new RegExp(`${attr}\\s*=\\s*"([^"]*)"`, 'gi')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(svg))) out.push(m[1]!.trim())
  return out
}

export function analyseSvg(svg: string): AnalyseSvg {
  const compte = (nom: string) => (svg.match(RE_BALISE(nom)) ?? []).length
  const normalise = (c: string) => couleurNormalisee(c)
  const fills = attributsTous(svg, 'fill')
    .map(normalise)
    .filter((c) => c && c !== 'none')
  const strokes = attributsTous(svg, 'stroke')
    .map(normalise)
    .filter((c) => c && c !== 'none')
  return {
    viewBox: attributsTous(svg, 'viewBox')[0] ?? null,
    nbPaths: compte('path'),
    nbFormesPrimitives:
      compte('circle') + compte('ellipse') + compte('rect') + compte('polygon') + compte('polyline') + compte('line'),
    fills: [...new Set(fills)],
    strokes: [...new Set(strokes)],
    strokeWidths: [...new Set(attributsTous(svg, 'stroke-width').map((s) => Number(s)).filter((n) => Number.isFinite(n)))],
    aText: /<text[\s>]|<tspan[\s>]|font-family/i.test(svg),
    aGradient: /<linearGradient|<radialGradient|url\(#/i.test(svg),
    aFilter: /<filter[\s>]|filter\s*=|feGaussianBlur|feDropShadow/i.test(svg),
    aImage: /<image[\s>]/i.test(svg),
    aOpacite: /\b(fill-|stroke-)?opacity\s*=\s*"0?\.\d+"/i.test(svg),
    octets: Buffer.byteLength(svg, 'utf-8'),
  }
}

const NOMS_COULEUR: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  none: 'none',
  currentcolor: 'none',
}

export function couleurNormalisee(c: string): string {
  const v = c.trim().toLowerCase()
  if (!v) return ''
  if (NOMS_COULEUR[v]) return NOMS_COULEUR[v]!
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`
  if (/^#[0-9a-f]{6}$/.test(v)) return v
  if (v.startsWith('url(')) return 'gradient'
  return v
}

/*
 * Le premier objet JSON ÉQUILIBRÉ d'un texte, quoi qu'il y ait autour.
 *
 * Motif : les portes de mesure de cette session revenaient `null` par
 * INTERMITTENCE. Rejouée à l'identique, la même requête renvoyait un JSON
 * parfaitement valide de 351 caractères ; dans la boucle, une fois sur deux, le
 * `JSON.parse` échouait. Traquer une intermittence coûte des appels ; refermer la
 * classe d'erreur coûte quinze lignes. Ce lecteur absorbe une clôture markdown,
 * de la prose avant ou après, et surtout le cas où la réponse arrive en plusieurs
 * parts concaténées en `{…}{…}` — qui ne parse pas et qui est indiscernable d'un
 * modèle qui répond mal.
 *
 * Il compte les accolades hors chaîne, en tenant compte des échappements : un
 * `}` dans une valeur texte ne referme rien.
 */
export function extraitPremierJson(texte: string): string | null {
  const s = texte.replace(/```(?:json)?/gi, '').trim()
  const debut = s.indexOf('{')
  if (debut < 0) return null
  let profondeur = 0
  let dansChaine = false
  let echappe = false
  for (let k = debut; k < s.length; k += 1) {
    const c = s[k]
    if (dansChaine) {
      if (echappe) echappe = false
      else if (c === '\\') echappe = true
      else if (c === '"') dansChaine = false
      continue
    }
    if (c === '"') dansChaine = true
    else if (c === '{') profondeur += 1
    else if (c === '}') {
      profondeur -= 1
      if (profondeur === 0) return s.slice(debut, k + 1)
    }
  }
  return null
}

/** Extrait le premier bloc <svg>…</svg> d'une réponse libre. */
export function extraitSvg(texte: string): string | null {
  const m = texte.match(/<svg[\s\S]*?<\/svg>/i)
  return m ? m[0] : null
}

/**
 * Rendu PNG RGBA d'un SVG, à la taille demandée, fond transparent.
 * `density` élevé : librsvg rasterise à la densité demandée puis sharp
 * redimensionne — sans ça un SVG en viewBox 512 rendu à 1024 est flou.
 */
export async function renduSvg(svg: string, taille: number): Promise<Buffer> {
  return sharp(Buffer.from(svg), { density: Math.min(2400, Math.round((taille / 512) * 96 * 4)) })
    .resize(taille, taille, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
}

/** Le SVG posé sur un fond neutre — l'image que le juge de forme voit. */
export async function renduSvgSurNeutre(svg: string, taille: number, fond = '#9a9a9a'): Promise<Buffer> {
  const png = await renduSvg(svg, taille)
  return sharp(png).flatten({ background: fond }).png().toBuffer()
}

export type MesureSvg = {
  parse: boolean
  erreurRendu: string | null
  analyse: AnalyseSvg
  nbElements: number
  taillesElements: number[]
  nbCouleursRendu: number
  couleursRendu: Array<{ hex: string; part: number }>
  encre512: number
  encre64: number
  nbElements64: number
  iou64: number
  boite: { x0: number; y0: number; x1: number; y1: number; aire: number } | null
  /** La MASSE : encre / aire de la boîte englobante. Voir mesureMasseMarque. */
  masse: number | null
}

/**
 * Toutes les mesures d'un SVG candidat, en une passe. Aucune ne vient du
 * modèle : `nbElements` est un comptage de composantes connexes, `iou64` une
 * comparaison de masques, `nbCouleursRendu` une agrégation d'histogramme.
 */
export async function mesureSvg(svg: string): Promise<MesureSvg> {
  const analyse = analyseSvg(svg)
  let png512: Buffer
  let png64: Buffer
  try {
    png512 = await renduSvg(svg, 512)
    png64 = await renduSvg(svg, 64)
  } catch (err) {
    return {
      parse: false,
      erreurRendu: (err as Error).message,
      analyse,
      nbElements: 0,
      taillesElements: [],
      nbCouleursRendu: 0,
      couleursRendu: [],
      encre512: 0,
      encre64: 0,
      nbElements64: 0,
      iou64: 0,
      boite: null,
      masse: null,
    }
  }

  const m512 = await masqueOpacite(png512, 512)
  const m64 = await masqueOpacite(png64, 64)
  const m64remonte = await masqueOpacite(
    await sharp(png64).resize(512, 512, { kernel: 'nearest' }).png().toBuffer(),
    512
  )
  const comp512 = composantes(m512)
  const comp64 = composantes(m64, 0.004)
  const boite = boiteMasque(m512)
  const encre512 = encre(m512)

  return {
    parse: true,
    erreurRendu: null,
    analyse,
    nbElements: comp512.nb,
    taillesElements: comp512.tailles.map((t) => arrondi(t / (512 * 512), 4)),
    ...(await couleursRendu(png512)),
    encre512,
    encre64: encre(m64),
    nbElements64: comp64.nb,
    iou64: iou(m512, m64remonte),
    boite,
    masse: boite && boite.aire > 0 ? arrondi(encre512 / boite.aire, 4) : null,
  }
}

/** Distance d'un point au segment [a,b] dans l'espace RGB, en euclidien. */
function distanceAuSegment(
  p: [number, number, number],
  a: [number, number, number],
  b: [number, number, number]
): number {
  const ab: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const ap: [number, number, number] = [p[0] - a[0], p[1] - a[1], p[2] - a[2]]
  const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2
  if (len2 === 0) return Math.hypot(ap[0], ap[1], ap[2])
  let t = (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(ap[0] - t * ab[0], ap[1] - t * ab[1], ap[2] - t * ab[2])
}

/**
 * Couleurs distinctes d'un rendu, sur les pixels opaques. Histogramme quantifié
 * à 5 bits par canal, puis trois règles de fusion, appliquées aux seaux par
 * effectif décroissant — donc les couleurs dominantes se posent d'abord :
 *
 *  1. à moins de 60 en distance L1 d'une couleur déjà retenue → fusion ;
 *  2. sur le SEGMENT entre deux couleurs retenues (à moins de 30 en euclidien)
 *     et sous 10 % de la marque → fusion dans l'extrémité la plus proche. C'est
 *     la signature exacte de l'anti-aliasing : un liseré noir de 26 px sur un
 *     aplat blanc produit un gris #797a7c à 2,3 % de la surface, pile au milieu
 *     du segment noir↔blanc. La règle 1 ne l'attrapait pas (il est à 367 des
 *     deux extrémités) et il comptait comme une TROISIÈME couleur de marque ;
 *  3. sous 0,5 % de la marque → fusion dans la plus proche retenue (poussière).
 */
async function couleursRendu(
  png: Buffer
): Promise<{ nbCouleursRendu: number; couleursRendu: Array<{ hex: string; part: number }> }> {
  const { data, info } = await sharp(png).resize(256, 256, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const seaux = new Map<number, { n: number; r: number; g: number; b: number }>()
  let opaques = 0
  for (let i = 0; i < info.width * info.height; i += 1) {
    const a = data[i * 4 + 3]!
    if (a < 200) continue
    const r = data[i * 4]!
    const g = data[i * 4 + 1]!
    const b = data[i * 4 + 2]!
    opaques += 1
    const cle = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
    const s = seaux.get(cle)
    if (s) {
      s.n += 1
      s.r += r
      s.g += g
      s.b += b
    } else {
      seaux.set(cle, { n: 1, r, g, b })
    }
  }
  if (!opaques) return { nbCouleursRendu: 0, couleursRendu: [] }

  const tries = [...seaux.values()]
    .map((s) => ({ n: s.n, r: s.r / s.n, g: s.g / s.n, b: s.b / s.n }))
    .sort((a, b) => b.n - a.n)

  const retenues: Array<{ n: number; r: number; g: number; b: number }> = []
  const plusProche = (c: { r: number; g: number; b: number }) =>
    retenues.reduce<{ k: (typeof retenues)[number] | null; d: number }>(
      (best, k) => {
        const d = Math.hypot(k.r - c.r, k.g - c.g, k.b - c.b)
        return d < best.d ? { k, d } : best
      },
      { k: null, d: Infinity }
    ).k

  for (const c of tries) {
    const part = c.n / opaques
    const proche = retenues.find(
      (k) => Math.abs(k.r - c.r) + Math.abs(k.g - c.g) + Math.abs(k.b - c.b) < 60
    )
    if (proche) {
      proche.n += c.n
      continue
    }
    if (retenues.length >= 2 && part < 0.1) {
      let surSegment = false
      for (let i = 0; i < retenues.length && !surSegment; i += 1) {
        for (let j = i + 1; j < retenues.length && !surSegment; j += 1) {
          const a = retenues[i]!
          const b = retenues[j]!
          if (distanceAuSegment([c.r, c.g, c.b], [a.r, a.g, a.b], [b.r, b.g, b.b]) < 30) surSegment = true
        }
      }
      if (surSegment) {
        const k = plusProche(c)
        if (k) {
          k.n += c.n
          continue
        }
      }
    }
    if (part < 0.005 && retenues.length) {
      const k = plusProche(c)
      if (k) {
        k.n += c.n
        continue
      }
    }
    retenues.push({ ...c })
  }
  const hex = (x: number) => Math.round(x).toString(16).padStart(2, '0')
  const couleurs = retenues
    .map((c) => ({ hex: `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`, part: arrondi(c.n / opaques, 4) }))
    .filter((c) => c.part >= 0.01)
    .sort((a, b) => b.part - a.part)
  return { nbCouleursRendu: couleurs.length, couleursRendu: couleurs }
}

// ─── La MASSE d'une marque ───────────────────────────────────────────────────

export type MasseMarque = {
  mesurable: boolean
  /** Encre de la marque / aire de sa boîte englobante. La compacité. */
  taux_remplissage_boite: number | null
  /** Encre de la marque / aire du cadre. */
  encre_cadre: number | null
  nb_composantes: number | null
  /** Part de l'encre de la marque qui est NEUTRE (saturation < 0,15). */
  part_neutre_marque: number | null
  raison?: string
}

/**
 * La masse d'une marque : quelle part de sa propre boîte englobante elle
 * remplit. C'est le trait structurel que ce corpus partage — des lettrages
 * LOURDS, compacts, qui remplissent leur boîte — et c'est exactement ce qu'aucun
 * instrument des sessions 5 à 6 ne mesurait. Une marque aérée (un anneau croisé
 * d'une barre) peut passer toutes les gardes d'hygiène en restant incomparable
 * avec `black-world1`, dont le B occupe presque toute sa boîte.
 *
 * Segmentation, sur les pièces raster : la marque de ce corpus est CLAIRE sur un
 * fond SOMBRE. On prend la luminance moyenne hors boîte comme référence, et on
 * garde dans la boîte les pixels qui s'en écartent de plus de `ecart`. Rustique,
 * mais vérifiable : si le masque obtenu couvre moins de 8 % ou plus de 95 % de la
 * boîte, la segmentation n'a rien séparé et la pièce est déclarée NON MESURABLE
 * plutôt que de livrer un chiffre inventé.
 */
export async function mesureMasseMarque(
  source: Buffer | string,
  box: Box2d | null,
  ecart = 0.25
): Promise<MasseMarque> {
  if (!box) return { mesurable: false, taux_remplissage_boite: null, encre_cadre: null, nb_composantes: null, part_neutre_marque: null, raison: 'aucune boîte' }
  const N = 256
  const { data } = await sharp(source)
    .resize(N, N, { fit: 'fill' })
    .flatten({ background: '#000000' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const luma = (i: number) => (0.2126 * data[i * 3]! + 0.7152 * data[i * 3 + 1]! + 0.0722 * data[i * 3 + 2]!) / 255
  const [y0, x0, y1, x1] = box
  const py0 = Math.max(0, Math.floor((y0 / 1000) * N))
  const px0 = Math.max(0, Math.floor((x0 / 1000) * N))
  const py1 = Math.min(N, Math.ceil((y1 / 1000) * N))
  const px1 = Math.min(N, Math.ceil((x1 / 1000) * N))
  const aireBoite = Math.max(1, (py1 - py0) * (px1 - px0))

  let sommeHors = 0
  let nHors = 0
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      if (y >= py0 && y < py1 && x >= px0 && x < px1) continue
      sommeHors += luma(y * N + x)
      nHors += 1
    }
  }
  if (!nHors) return { mesurable: false, taux_remplissage_boite: null, encre_cadre: null, nb_composantes: null, part_neutre_marque: null, raison: 'la boîte couvre tout le cadre' }
  const fond = sommeHors / nHors

  const m = new Uint8Array(N * N)
  let encre = 0
  let neutres = 0
  for (let y = py0; y < py1; y += 1) {
    for (let x = px0; x < px1; x += 1) {
      const i = y * N + x
      if (Math.abs(luma(i) - fond) > ecart) {
        m[i] = 1
        encre += 1
        // Saturation HSV du pixel de marque : la part NEUTRE de l'encre est le
        // trait chromatique du corpus (marque claire, accent minoritaire).
        const r = data[i * 3]!
        const g = data[i * 3 + 1]!
        const bl = data[i * 3 + 2]!
        const max = Math.max(r, g, bl)
        const min = Math.min(r, g, bl)
        if (max === 0 || (max - min) / max < 0.15) neutres += 1
      }
    }
  }
  const taux = encre / aireBoite
  if (taux < 0.08 || taux > 0.95) {
    return {
      mesurable: false,
      taux_remplissage_boite: arrondi(taux, 4),
      encre_cadre: arrondi(encre / (N * N), 4),
      nb_composantes: null,
      part_neutre_marque: null,
      raison: `segmentation non concluante (${arrondi(taux, 3)} de la boîte)`,
    }
  }
  return {
    mesurable: true,
    taux_remplissage_boite: arrondi(taux, 4),
    encre_cadre: arrondi(encre / (N * N), 4),
    nb_composantes: composantes({ w: N, h: N, m }, 0.0015).nb,
    part_neutre_marque: encre ? arrondi(neutres / encre, 4) : null,
  }
}

/**
 * La part de l'encre d'un rendu SVG qui est NEUTRE. Même grandeur que
 * `part_neutre_marque` de `mesureMasseMarque`, mesurée sur l'alpha exact au lieu
 * d'une segmentation — c'est ce qui permet de comparer un candidat au corpus sur
 * le MÊME axe.
 */
export async function partNeutreRendu(png: Buffer): Promise<number | null> {
  const N = 256
  const { data } = await sharp(png).resize(N, N, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let encre = 0
  let neutres = 0
  for (let i = 0; i < N * N; i += 1) {
    if (data[i * 4 + 3]! < 128) continue
    encre += 1
    const r = data[i * 4]!
    const g = data[i * 4 + 1]!
    const b = data[i * 4 + 2]!
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    if (max === 0 || (max - min) / max < 0.15) neutres += 1
  }
  return encre ? arrondi(neutres / encre, 4) : null
}

/**
 * La SURVIE STRUCTURELLE à 64 px d'une image composée, quelle que soit son
 * origine — un SVG rendu ou une image peinte. Même instrument pour les six pièces
 * de la planche, sinon la comparaison ne vaut rien.
 *
 * Méthode : la marque est segmentée par écart de luminance au fond (celui du bord
 * du cadre, une marque de ce corpus étant centrée), une fois sur l'image pleine
 * et une fois sur la même image réduite à 64 px puis remontée au plus proche
 * voisin. L'IoU des deux masques dit ce que la vignette perd.
 */
export async function survie64(source: Buffer | string): Promise<{ iou: number; encre512: number; encre64: number }> {
  const masqueDe = async (buf: Buffer) => {
    const N = 512
    const { data } = await sharp(buf).resize(N, N, { fit: 'fill' }).flatten({ background: '#000000' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const luma = (i: number) => (0.2126 * data[i * 3]! + 0.7152 * data[i * 3 + 1]! + 0.0722 * data[i * 3 + 2]!) / 255
    const marge = Math.round(N * 0.1)
    let somme = 0
    let n = 0
    for (let y = 0; y < N; y += 1) {
      for (let x = 0; x < N; x += 1) {
        if (y >= marge && y < N - marge && x >= marge && x < N - marge) continue
        somme += luma(y * N + x)
        n += 1
      }
    }
    const fond = n ? somme / n : 0
    const m = new Uint8Array(N * N)
    for (let i = 0; i < N * N; i += 1) m[i] = Math.abs(luma(i) - fond) > 0.25 ? 1 : 0
    return { w: N, h: N, m }
  }

  const plein = typeof source === 'string' ? await sharp(source).png().toBuffer() : source
  const petit = await sharp(plein).resize(64, 64, { fit: 'cover' }).resize(512, 512, { kernel: 'nearest' }).png().toBuffer()
  const a = await masqueDe(plein)
  const b = await masqueDe(petit)
  return { iou: iou(a, b), encre512: encre(a), encre64: encre(b) }
}

// ─── Les régions de couleur d'une marque, et leur ENCLAVEMENT ────────────────

export type RegionCouleur = { hex: string; part: number; touche_le_bord: boolean }

/**
 * Les régions de couleur d'un rendu, avec pour chacune : sa part de l'encre, et
 * si elle TOUCHE LE BORD de la silhouette de la marque.
 *
 * Pourquoi cette mesure existe. Le candidat VULCAIN qui a passé dix-huit gardes
 * était un aplat orange percé d'un trou gris octogonal. J'ai d'abord voulu le
 * refuser sur la proportion — « le neutre doit dominer » — et la mesure a démonté
 * cette borne : le corpus contient `welllogo` (un W tout en or, 2 % de neutre) et
 * `goldenlogo` (or intégral, 0 %), deux exemplaires CANONIQUES. Aucun plancher sur
 * la part de neutre ne peut à la fois les admettre et refuser l'aplat orange.
 *
 * Ce qui sépare vraiment les deux, c'est la TOPOLOGIE. Dans le corpus, une
 * seconde couleur est soit toute la marque, soit une zone qui affleure le bord de
 * la silhouette (le lobe cyan de `black-world1` mord le bord bas-droite). Elle
 * n'est jamais un îlot posé au milieu d'un champ de l'autre couleur — ce qui est
 * exactement ce qu'était le trou gris.
 */
export async function regionsCouleur(png: Buffer, seuilPart = 0.01): Promise<RegionCouleur[]> {
  const N = 256
  const { data } = await sharp(png).resize(N, N, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const dansMarque = new Uint8Array(N * N)
  for (let i = 0; i < N * N; i += 1) dansMarque[i] = data[i * 4 + 3]! >= 128 ? 1 : 0

  const { couleursRendu } = await (async () => {
    const r = await mesureSvgCouleurs(png)
    return r
  })()
  const retenues = couleursRendu.filter((c) => c.part >= seuilPart)
  if (!retenues.length) return []

  const rgb = (hex: string): [number, number, number] => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
  const cibles = retenues.map((c) => ({ ...c, rgb: rgb(c.hex) }))

  const compteBord = new Array(cibles.length).fill(0) as number[]
  const compteTotal = new Array(cibles.length).fill(0) as number[]

  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      const i = y * N + x
      if (!dansMarque[i]) continue
      const r = data[i * 4]!
      const g = data[i * 4 + 1]!
      const b = data[i * 4 + 2]!
      let meilleur = 0
      let dMin = Infinity
      for (let k = 0; k < cibles.length; k += 1) {
        const c = cibles[k]!.rgb
        const d = Math.abs(c[0] - r) + Math.abs(c[1] - g) + Math.abs(c[2] - b)
        if (d < dMin) {
          dMin = d
          meilleur = k
        }
      }
      compteTotal[meilleur] = (compteTotal[meilleur] ?? 0) + 1
      // Un pixel « de bord » : au moins un voisin HORS de la marque, ou sur le
      // cadre. C'est ce qui distingue une zone qui affleure d'un îlot.
      let bord = x === 0 || y === 0 || x === N - 1 || y === N - 1
      for (let dy = -1; dy <= 1 && !bord; dy += 1) {
        for (let dx = -1; dx <= 1 && !bord; dx += 1) {
          const ny = y + dy
          const nx = x + dx
          if (ny < 0 || nx < 0 || ny >= N || nx >= N) continue
          if (!dansMarque[ny * N + nx]) bord = true
        }
      }
      if (bord) compteBord[meilleur] = (compteBord[meilleur] ?? 0) + 1
    }
  }

  const encre = compteTotal.reduce((a, x) => a + x, 0) || 1
  return cibles.map((c, k) => ({
    hex: c.hex,
    part: arrondi((compteTotal[k] ?? 0) / encre, 4),
    /*
     * Un seuil de 3 pixels et pas 1 : l'anti-aliasing entre deux couleurs voisines
     * du bord peut faire basculer un pixel isolé dans la mauvaise classe, et un
     * seul pixel suffirait alors à faire passer un îlot pour une zone affleurante.
     */
    touche_le_bord: (compteBord[k] ?? 0) >= 3,
  }))
}

/** Histogramme de couleurs d'un PNG, réutilisé par regionsCouleur. */
async function mesureSvgCouleurs(png: Buffer): Promise<{ couleursRendu: Array<{ hex: string; part: number }> }> {
  const r = await couleursRendu(png)
  return { couleursRendu: r.couleursRendu }
}

// ─── Couleurs : teinte, saturation, familles ─────────────────────────────────

export function hexVersHsv(hex: string): { h: number; s: number; v: number } | null {
  const c = couleurNormalisee(hex)
  if (!/^#[0-9a-f]{6}$/.test(c)) return null
  const r = parseInt(c.slice(1, 3), 16) / 255
  const g = parseInt(c.slice(3, 5), 16) / 255
  const bl = parseInt(c.slice(5, 7), 16) / 255
  const max = Math.max(r, g, bl)
  const min = Math.min(r, g, bl)
  const d = max - min
  let h = 0
  if (d > 0) {
    if (max === r) h = ((g - bl) / d + (g < bl ? 6 : 0)) * 60
    else if (max === g) h = ((bl - r) / d + 2) * 60
    else h = ((r - g) / d + 4) * 60
  }
  return { h, s: max === 0 ? 0 : d / max, v: max }
}

/** Une couleur neutre : blanc, gris, noir. 41 pièces du corpus sur 55 en ont une. */
export function estNeutre(hex: string, seuilSaturation = 0.15): boolean {
  const hsv = hexVersHsv(hex)
  return hsv !== null && hsv.s < seuilSaturation
}

/** La famille de teinte, par tranches de 30° — l'unité qui a du sens visuellement. */
export function familleTeinte(hex: string): number | null {
  const hsv = hexVersHsv(hex)
  if (!hsv || hsv.s < 0.15) return null
  return Math.floor(hsv.h / 30) * 30
}

// ─── Journal ─────────────────────────────────────────────────────────────────

export function ligneJournal(texte: string): string {
  return `${new Date().toISOString().slice(11, 19)} · ${texte}`
}
