/*
 * Run 6 (§6) — LES COULEURS : contrat de sortie, pas ligne de prompt.
 *
 * Deux constats sourcés :
 *   1. le hex ne survit pas au tokenizer — le prompt gagnant du test plafond
 *      n'en portait AUCUN et sortait la meilleure matière du projet ;
 *   2. « exactly two colors » annule mécaniquement le chrome : le chrome
 *      n'est pas une couleur, c'est une réflexion d'environnement — il lui
 *      faut un dégradé sombre→clair et une ligne d'horizon.
 *
 * Donc : on génère SANS couleur imposée (le validateur v6 rejette tout hex
 * dans S2), on MESURE après rendu, et on corrige localement en sharp si
 * l'écart dépasse le seuil. Zéro appel API. Le contrat client « vos couleurs
 * exactes » est tenu à l'export, pas à la génération.
 *
 * La correction déplace TEINTE et SATURATION en laissant la LUMINANCE
 * intacte : c'est elle qui porte le modelé, les speculars et le relief. Un
 * hue-shift global de sharp (.modulate) repeindrait aussi le fond — ici on ne
 * touche qu'aux pixels proches du cluster visé.
 */

import sharp from 'sharp'

export type Rgb = { r: number; g: number; b: number }
export type Lab = { L: number; a: number; b: number }

/** Seuil de déclenchement (§6) : au-delà, la palette du wizard n'est pas tenue. */
export const DELTA_E_SEUIL = 12

// ── conversions ──────────────────────────────────────────────────────────────

export function hexToRgb(hex: string): Rgb {
  const v = hex.replace('#', '')
  const plein = v.length === 3 ? v.split('').map((c) => c + c).join('') : v
  return {
    r: parseInt(plein.slice(0, 2), 16),
    g: parseInt(plein.slice(2, 4), 16),
    b: parseInt(plein.slice(4, 6), 16),
  }
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

export function rgbToLab({ r, g, b }: Rgb): Lab {
  const lin = (c: number) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  const R = lin(r)
  const G = lin(g)
  const B = lin(b)
  // sRGB → XYZ (D65)
  const X = R * 0.4124564 + G * 0.3575761 + B * 0.1804375
  const Y = R * 0.2126729 + G * 0.7151522 + B * 0.072175
  const Z = R * 0.0193339 + G * 0.119192 + B * 0.9503041
  // XYZ → Lab (blanc D65)
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29)
  const fx = f(X / 0.95047)
  const fy = f(Y / 1.0)
  const fz = f(Z / 1.08883)
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) }
}

/** CIEDE2000 — la distance perceptuelle, celle qui fait foi pour un client. */
export function deltaE2000(l1: Lab, l2: Lab): number {
  const rad = Math.PI / 180
  const deg = 180 / Math.PI
  const kL = 1
  const kC = 1
  const kH = 1

  const C1 = Math.hypot(l1.a, l1.b)
  const C2 = Math.hypot(l2.a, l2.b)
  const Cbar = (C1 + C2) / 2
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)))
  const a1p = (1 + G) * l1.a
  const a2p = (1 + G) * l2.a
  const C1p = Math.hypot(a1p, l1.b)
  const C2p = Math.hypot(a2p, l2.b)
  const h1p = C1p === 0 ? 0 : (Math.atan2(l1.b, a1p) * deg + 360) % 360
  const h2p = C2p === 0 ? 0 : (Math.atan2(l2.b, a2p) * deg + 360) % 360

  const dLp = l2.L - l1.L
  const dCp = C2p - C1p
  let dhp = 0
  if (C1p * C2p !== 0) {
    const diff = h2p - h1p
    dhp = diff > 180 ? diff - 360 : diff < -180 ? diff + 360 : diff
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2)

  const Lbarp = (l1.L + l2.L) / 2
  const Cbarp = (C1p + C2p) / 2
  let hbarp = h1p + h2p
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbarp += h1p + h2p < 360 ? 360 : -360
    hbarp /= 2
  }

  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * rad) +
    0.24 * Math.cos(2 * hbarp * rad) +
    0.32 * Math.cos((3 * hbarp + 6) * rad) -
    0.2 * Math.cos((4 * hbarp - 63) * rad)
  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2))
  const Rc = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7))
  const Sl = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2)
  const Sc = 1 + 0.045 * Cbarp
  const Sh = 1 + 0.015 * Cbarp * T
  const Rt = -Math.sin(2 * dTheta * rad) * Rc

  return Math.sqrt(
    (dLp / (kL * Sl)) ** 2 +
      (dCp / (kC * Sc)) ** 2 +
      (dHp / (kH * Sh)) ** 2 +
      Rt * (dCp / (kC * Sc)) * (dHp / (kH * Sh))
  )
}

// ── k-means déterministe (k=5 par défaut, §6) ───────────────────────────────
// Init k-means++ à graine FIXE : deux mesures de la même image donnent le même
// verdict. Une mesure non rejouable ne vaut rien (loi de la calibration).

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type Cluster = { rgb: Rgb; lab: Lab; part: number }

export function kmeans(pixels: Rgb[], k = 5, iterations = 12, seed = 42): Cluster[] {
  if (!pixels.length) return []
  const labs = pixels.map(rgbToLab)
  const rand = mulberry32(seed)

  // k-means++ : premier centre au hasard, les suivants proportionnels au carré
  // de la distance au centre le plus proche.
  const centres: Lab[] = [labs[Math.floor(rand() * labs.length)]!]
  while (centres.length < Math.min(k, labs.length)) {
    const d2 = labs.map((p) => Math.min(...centres.map((c) => (p.L - c.L) ** 2 + (p.a - c.a) ** 2 + (p.b - c.b) ** 2)))
    const total = d2.reduce((s, v) => s + v, 0)
    let cible = rand() * total
    let idx = 0
    for (let i = 0; i < d2.length; i += 1) {
      cible -= d2[i]!
      if (cible <= 0) {
        idx = i
        break
      }
    }
    centres.push(labs[idx]!)
  }

  let assignations = new Array<number>(labs.length).fill(0)
  for (let it = 0; it < iterations; it += 1) {
    let bouge = false
    labs.forEach((p, i) => {
      let best = 0
      let bestD = Infinity
      centres.forEach((c, ci) => {
        const d = (p.L - c.L) ** 2 + (p.a - c.a) ** 2 + (p.b - c.b) ** 2
        if (d < bestD) {
          bestD = d
          best = ci
        }
      })
      if (assignations[i] !== best) bouge = true
      assignations[i] = best
    })
    centres.forEach((_, ci) => {
      const membres = labs.filter((_, i) => assignations[i] === ci)
      if (!membres.length) return
      centres[ci] = {
        L: membres.reduce((s, m) => s + m.L, 0) / membres.length,
        a: membres.reduce((s, m) => s + m.a, 0) / membres.length,
        b: membres.reduce((s, m) => s + m.b, 0) / membres.length,
      }
    })
    if (!bouge) break
  }

  return centres
    .map((lab, ci) => {
      const membres = pixels.filter((_, i) => assignations[i] === ci)
      if (!membres.length) return null
      const rgb = {
        r: membres.reduce((s, m) => s + m.r, 0) / membres.length,
        g: membres.reduce((s, m) => s + m.g, 0) / membres.length,
        b: membres.reduce((s, m) => s + m.b, 0) / membres.length,
      }
      return { rgb, lab, part: membres.length / pixels.length }
    })
    .filter((c): c is Cluster => c !== null)
    .sort((a, b) => b.part - a.part)
}

// ── mesure ───────────────────────────────────────────────────────────────────

export type MesurePalette = {
  clusters: Cluster[]
  /** pour chaque hex du wizard : le cluster le plus proche et son écart */
  ecarts: Array<{ hex: string; deltaE: number; clusterHex: string }>
  /** le pire écart des 2 clusters dominants — c'est lui qui décide */
  deltaEMax: number
  conforme: boolean
}

/** Les pixels du LETTRAGE, ou à défaut la zone centrale de la marque. */
async function pixelsDeLaMarque(png: Buffer, wordBbox?: [number, number, number, number]): Promise<Rgb[]> {
  const image = sharp(png)
  const meta = await image.metadata()
  const W = meta.width ?? 1024
  const H = meta.height ?? 1024
  const zone = wordBbox ?? [0.2, 0.3, 0.6, 0.4]
  const left = Math.max(0, Math.round(zone[0] * W))
  const top = Math.max(0, Math.round(zone[1] * H))
  const width = Math.max(1, Math.min(W - left, Math.round(zone[2] * W)))
  const height = Math.max(1, Math.min(H - top, Math.round(zone[3] * H)))

  const { data, info } = await image
    .extract({ left, top, width, height })
    // sous-échantillonnage : 128 px de côté suffit pour des amas de couleur et
    // garde le k-means instantané
    .resize({ width: 128, height: 128, fit: 'inside' })
    .raw()
    .toBuffer({ resolveWithObject: true })

  const canaux = info.channels
  const pixels: Rgb[] = []
  for (let i = 0; i < info.width * info.height; i += 1) {
    const o = i * canaux
    if (canaux === 4 && data[o + 3]! < 128) continue // transparent : hors marque
    pixels.push({ r: data[o]!, g: data[o + 1]!, b: data[o + 2]! })
  }
  return pixels
}

export async function mesurePalette(opts: {
  png: Buffer
  /** la palette EXACTE du wizard (1 à 3 hex) */
  palette: string[]
  wordBbox?: [number, number, number, number]
  k?: number
}): Promise<MesurePalette> {
  const pixels = await pixelsDeLaMarque(opts.png, opts.wordBbox)
  const clusters = kmeans(pixels, opts.k ?? 5)
  const dominants = clusters.slice(0, 2)

  const ecarts = opts.palette.map((hex) => {
    const cible = rgbToLab(hexToRgb(hex))
    let meilleur = { deltaE: Infinity, clusterHex: '' }
    for (const c of dominants) {
      // Luminance APPARIÉE avant comparaison. Un cluster est la moyenne d'un
      // dégradé (c'est le modelé qui fait le chrome) ; le hex du wizard est un
      // aplat. Les comparer luminance comprise ferait échouer par construction
      // tout rendu à relief — et pousserait la correction à aplatir la matière
      // pour « réussir » la mesure, exactement ce que le §6 refuse. Ce qu'un
      // client appelle « ma couleur », c'est la teinte et la saturation.
      const cibleAppariee = { L: c.lab.L, a: cible.a, b: cible.b }
      const d = deltaE2000(c.lab, cibleAppariee)
      if (d < meilleur.deltaE) meilleur = { deltaE: Math.round(d * 100) / 100, clusterHex: rgbToHex(c.rgb) }
    }
    return { hex, deltaE: meilleur.deltaE, clusterHex: meilleur.clusterHex }
  })

  const deltaEMax = ecarts.length ? Math.max(...ecarts.map((e) => e.deltaE)) : 0
  return { clusters, ecarts, deltaEMax, conforme: deltaEMax <= DELTA_E_SEUIL }
}

// ── correction locale ────────────────────────────────────────────────────────

/** Luminance perçue (Rec. 709) — ce que l'œil lit comme « clair » ou « sombre ». */
export function luma({ r, g, b }: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const R = r / 255
  const G = g / 255
  const B = b / 255
  const max = Math.max(R, G, B)
  const min = Math.min(R, G, B)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === R) h = ((G - B) / d + (G < B ? 6 : 0)) / 6
  else if (max === G) h = ((B - R) / d + 2) / 6
  else h = ((R - G) / d + 4) / 6
  return { h, s, l }
}

function hslToRgb({ h, s, l }: { h: number; s: number; l: number }): Rgb {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const canal = (t: number) => {
    let v = t
    if (v < 0) v += 1
    if (v > 1) v -= 1
    if (v < 1 / 6) return p + (q - p) * 6 * v
    if (v < 1 / 2) return q
    if (v < 2 / 3) return p + (q - p) * (2 / 3 - v) * 6
    return p
  }
  return { r: canal(h + 1 / 3) * 255, g: canal(h) * 255, b: canal(h - 1 / 3) * 255 }
}

/**
 * Amène une couleur à une luminance perçue cible SANS jamais écrêter :
 * - trop claire → on assombrit proportionnellement (la teinte est conservée) ;
 * - trop sombre → on mélange vers le BLANC, ce qui désature en montant.
 * Cette seconde branche n'est pas un pis-aller : c'est le comportement d'un
 * specular réel. Multiplier au lieu de mélanger écrêtait le haut du dégradé et
 * compressait le modelé (mesuré : écart-type 29,9 → 26,7 au lieu de ~29).
 */
export function ramenerALaLuma(couleur: Rgb, cible: number): Rgb {
  const actuelle = luma(couleur)
  if (actuelle <= 0) return { r: cible, g: cible, b: cible }
  if (cible <= actuelle) {
    const f = cible / actuelle
    return { r: couleur.r * f, g: couleur.g * f, b: couleur.b * f }
  }
  const t = Math.min(1, (cible - actuelle) / Math.max(1e-6, 255 - actuelle))
  return {
    r: couleur.r + t * (255 - couleur.r),
    g: couleur.g + t * (255 - couleur.g),
    b: couleur.b + t * (255 - couleur.b),
  }
}

export type ConformiteResultat = {
  png: Buffer
  applique: boolean
  deltaEAvant: number
  deltaEApres: number
  /** part des pixels réellement déplacés — trace, pour juger d'une surcorrection */
  partCorrigee: number
}

/**
 * Amène le cluster dominant vers la couleur cible en préservant la luminance.
 * `rayon` est la distance ΔE2000 au cluster source en deçà de laquelle un
 * pixel est considéré comme lui appartenant.
 */
export async function conformePalette(opts: {
  png: Buffer
  palette: string[]
  wordBbox?: [number, number, number, number]
  rayon?: number
}): Promise<ConformiteResultat> {
  const avant = await mesurePalette({ png: opts.png, palette: opts.palette, wordBbox: opts.wordBbox })
  if (avant.conforme || !opts.palette.length || !avant.clusters.length) {
    return {
      png: opts.png,
      applique: false,
      deltaEAvant: avant.deltaEMax,
      deltaEApres: avant.deltaEMax,
      partCorrigee: 0,
    }
  }

  // La cible : le hex le plus éloigné, ramené sur le cluster dominant.
  const pire = avant.ecarts.reduce((a, b) => (b.deltaE > a.deltaE ? b : a))
  const source = avant.clusters[0]!
  const cibleHsl = rgbToHsl(hexToRgb(pire.hex))
  const sourceHsl = rgbToHsl(source.rgb)
  const rayon = opts.rayon ?? 28
  // La saturation du pixel est mise à l'ÉCHELLE (cible / source) au lieu d'être
  // remplacée : la variation de saturation d'un chrome — mate dans les creux,
  // saturée sur les arêtes — survit au lieu d'être aplatie sur une valeur.
  const echelleSat = sourceHsl.s > 0.02 ? cibleHsl.s / sourceHsl.s : 1

  const { data, info } = await sharp(opts.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const sortie = Buffer.from(data)
  let corriges = 0
  const total = info.width * info.height

  for (let i = 0; i < total; i += 1) {
    const o = i * 4
    if (data[o + 3]! < 8) continue
    const px = { r: data[o]!, g: data[o + 1]!, b: data[o + 2]! }
    const d = deltaE2000(rgbToLab(px), source.lab)
    if (d > rayon) continue
    const hsl = rgbToHsl(px)
    // La teinte vient de la cible, la saturation est mise à l'échelle, et la
    // LUMINANCE PERÇUE du pixel est restituée exactement : le modelé, les
    // speculars et le relief survivent intacts. La clarté HSL ne suffit pas —
    // elle n'est pas la luminance perçue, et s'y fier aplatissait le chrome
    // (mesuré : écart-type 29,9 → 21 avant cette correction).
    const teinte = hslToRgb({ h: cibleHsl.h, s: Math.min(1, hsl.s * echelleSat), l: hsl.l })
    const neuf = ramenerALaLuma(teinte, luma(px))
    sortie[o] = Math.round(neuf.r)
    sortie[o + 1] = Math.round(neuf.g)
    sortie[o + 2] = Math.round(neuf.b)
    corriges += 1
  }

  const png = await sharp(sortie, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer()
  const apres = await mesurePalette({ png, palette: opts.palette, wordBbox: opts.wordBbox })

  return {
    png,
    applique: true,
    deltaEAvant: avant.deltaEMax,
    deltaEApres: apres.deltaEMax,
    partCorrigee: Math.round((corriges / total) * 1000) / 1000,
  }
}
