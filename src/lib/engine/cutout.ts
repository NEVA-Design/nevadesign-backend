import sharp from 'sharp'

// Détourage serveur du logo master (run 5, LOT 4) — AUCUN appel API.
// Le compilateur impose un fond plat pur (#FFFFFF ou #000000) que le logo
// ne touche pas : un flood-fill depuis les bords suffit, avec un feather
// de 0,6 px pour des contours propres. Déclinaisons blanc/noir dérivées
// localement (recolorisation du RGB, alpha conservé) — coût zéro.

type CutoutResult = {
  png: Buffer
  width: number
  height: number
}

// Box-blur séparable 3×3 sur un canal 8 bits — feather d'un demi-pixel.
function boxBlur3(src: Uint8Array, width: number, height: number): Uint8Array {
  const tmp = new Uint8Array(width * height)
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      const left = src[row + Math.max(0, x - 1)]!
      const mid = src[row + x]!
      const right = src[row + Math.min(width - 1, x + 1)]!
      tmp[row + x] = (left + mid + right) / 3
    }
  }
  for (let y = 0; y < height; y++) {
    const up = Math.max(0, y - 1) * width
    const row = y * width
    const down = Math.min(height - 1, y + 1) * width
    for (let x = 0; x < width; x++) {
      out[row + x] = (tmp[up + x]! + tmp[row + x]! + tmp[down + x]!) / 3
    }
  }
  return out
}

// Depuis le run 5.2 le fond logo est #F2F2F2 (jamais pur) : la tolérance
// descend à 18 pour qu'un logo blanc (#FFFFFF, distance ≈ 22) ou noir ne
// soit pas mangé par le flood-fill, et la marge du recadrage passe à 8 %.
export async function cutoutFlatBackground(
  input: Buffer,
  tolerance = 18,
  marginRatio = 0.08
): Promise<CutoutResult> {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height } = info
  const channels = 4

  // Couleur de fond = moyenne des 4 coins
  const cornerIdx = [
    0,
    (width - 1) * channels,
    (height - 1) * width * channels,
    ((height - 1) * width + (width - 1)) * channels,
  ]
  const bg: [number, number, number] = [0, 0, 0]
  for (const idx of cornerIdx) {
    bg[0] += data[idx]! / 4
    bg[1] += data[idx + 1]! / 4
    bg[2] += data[idx + 2]! / 4
  }

  const isBackground = (idx: number) => {
    const dr = data[idx]! - bg[0]!
    const dg = data[idx + 1]! - bg[1]!
    const db = data[idx + 2]! - bg[2]!
    return Math.sqrt(dr * dr + dg * dg + db * db) < tolerance
  }

  // Flood-fill BFS depuis tous les pixels de bord ressemblant au fond
  const mask = new Uint8Array(width * height) // 1 = fond
  const queue: number[] = []
  const push = (x: number, y: number) => {
    const p = y * width + x
    if (mask[p]) return
    if (!isBackground(p * channels)) return
    mask[p] = 1
    queue.push(p)
  }
  for (let x = 0; x < width; x++) {
    push(x, 0)
    push(x, height - 1)
  }
  for (let y = 0; y < height; y++) {
    push(0, y)
    push(width - 1, y)
  }
  while (queue.length) {
    const p = queue.pop()!
    const x = p % width
    const y = (p - x) / width
    if (x > 0) push(x - 1, y)
    if (x < width - 1) push(x + 1, y)
    if (y > 0) push(x, y - 1)
    if (y < height - 1) push(x, y + 1)
  }

  // Canal alpha : 0 sur le fond, 255 ailleurs, feather box-blur 3×3 maison
  // (l'aller-retour sharp sur un raw 1 canal désaligne les lignes — vécu).
  const alphaHard = new Uint8Array(width * height)
  for (let p = 0; p < width * height; p++) alphaHard[p] = mask[p] ? 0 : 255
  const alphaFeathered = boxBlur3(alphaHard, width, height)

  // Applique l'alpha + bounding box du contenu
  let minX = width, minY = height, maxX = 0, maxY = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      data[p * channels + 3] = alphaFeathered[p]!
      if (alphaFeathered[p]! > 8) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX <= minX || maxY <= minY) {
    // détourage raté (image pleine) : on renvoie l'image telle quelle avec alpha
    const png = await sharp(data, { raw: { width, height, channels } }).png().toBuffer()
    return { png, width, height }
  }

  const margin = Math.round(Math.max(maxX - minX, maxY - minY) * marginRatio)
  const left = Math.max(0, minX - margin)
  const top = Math.max(0, minY - margin)
  const cropWidth = Math.min(width - left, maxX - minX + margin * 2)
  const cropHeight = Math.min(height - top, maxY - minY + margin * 2)

  const png = await sharp(data, { raw: { width, height, channels } })
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .png()
    .toBuffer()
  return { png, width: cropWidth, height: cropHeight }
}

// ── Run 5.10 (chantier 2) : le détourage DÉCONTAMINÉ ─────────────────────────
// La frange blanche vue sur tous les détourages 5.8-5.9 (surtout les lockups
// 3D) : les pixels de bord du rendu portent un mélange marque/fond clair que
// le flood-fill laisse en place — recollés sur fond sombre, ils dessinent le
// liseré sticker. Correction en trois temps, tout local :
//   1. ÉROSION du masque de premier plan (1-2 px) — la couronne contaminée
//      passe côté fond ;
//   2. DÉCONTAMINATION des couleurs : les pixels de la bande de bord restante
//      prennent la couleur des pixels INTÉRIEURS les plus proches (dilatation
//      itérative des couleurs sûres vers le bord) — l'anti-aliasing rejoué
//      par le feather se fait sur la couleur de la marque, plus sur le blanc ;
//   3. feather 3×3 habituel.
// Le glow de contact est réappliqué localement par l'assemblage si besoin
// (tintedSilhouette dans logo-stack.ts) — il n'a pas à survivre au détourage.

export type CutoutDecontamineResult = CutoutResult & {
  /** part des pixels classés fond par le flood-fill (0-1) — verdict d'isolation */
  fondRatio: number
  /** bbox du contenu avant marge, en fraction du cadre — verdict d'isolation */
  bboxFraction: { width: number; height: number }
}

// Largeur de la bande décontaminée au-delà de l'érosion (px).
const DECON_BAND_PX = 2

export async function cutoutDecontamine(
  input: Buffer,
  opts?: { tolerance?: number; erosionPx?: number; marginRatio?: number }
): Promise<CutoutDecontamineResult> {
  const tolerance = opts?.tolerance ?? 18
  const erosionPx = Math.max(0, Math.min(3, Math.round(opts?.erosionPx ?? 2)))
  const marginRatio = opts?.marginRatio ?? 0.08

  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height } = info
  const channels = 4
  const total = width * height

  // Couleur de fond = moyenne des 4 coins (même doctrine que cutoutFlatBackground)
  const cornerIdx = [
    0,
    (width - 1) * channels,
    (height - 1) * width * channels,
    ((height - 1) * width + (width - 1)) * channels,
  ]
  const bg: [number, number, number] = [0, 0, 0]
  for (const idx of cornerIdx) {
    bg[0] += data[idx]! / 4
    bg[1] += data[idx + 1]! / 4
    bg[2] += data[idx + 2]! / 4
  }
  const isBackground = (idx: number) => {
    const dr = data[idx]! - bg[0]!
    const dg = data[idx + 1]! - bg[1]!
    const db = data[idx + 2]! - bg[2]!
    return Math.sqrt(dr * dr + dg * dg + db * db) < tolerance
  }

  // 1. flood-fill BFS depuis les bords
  const mask = new Uint8Array(total) // 1 = fond
  const queue: number[] = []
  const push = (x: number, y: number) => {
    const p = y * width + x
    if (mask[p]) return
    if (!isBackground(p * channels)) return
    mask[p] = 1
    queue.push(p)
  }
  for (let x = 0; x < width; x++) {
    push(x, 0)
    push(x, height - 1)
  }
  for (let y = 0; y < height; y++) {
    push(0, y)
    push(width - 1, y)
  }
  while (queue.length) {
    const p = queue.pop()!
    const x = p % width
    const y = (p - x) / width
    if (x > 0) push(x - 1, y)
    if (x < width - 1) push(x + 1, y)
    if (y > 0) push(x, y - 1)
    if (y < height - 1) push(x, y + 1)
  }
  const fondRatio = mask.reduce((s, v) => s + v, 0) / total

  // 2. érosion du premier plan : la couronne contaminée passe côté fond.
  // Double tampon par itération — une érosion ne doit pas cascader en elle-même.
  const dilateFond = (src: Uint8Array): Uint8Array => {
    const out = new Uint8Array(src)
    for (let y = 0; y < height; y++) {
      const row = y * width
      for (let x = 0; x < width; x++) {
        const p = row + x
        if (src[p]) continue
        if (
          (x > 0 && src[p - 1]) ||
          (x < width - 1 && src[p + 1]) ||
          (y > 0 && src[p - width]) ||
          (y < height - 1 && src[p + width])
        ) {
          out[p] = 1
        }
      }
    }
    return out
  }
  let maskErode: Uint8Array = mask
  for (let i = 0; i < erosionPx; i++) maskErode = dilateFond(maskErode)

  // 3. bande de bord restante + décontamination des couleurs : les pixels
  // sûrs sont ceux à plus de DECON_BAND_PX du fond érodé ; la bande prend
  // la couleur moyenne de ses voisins sûrs, par dilatation itérative.
  let interieur: Uint8Array = maskErode
  for (let i = 0; i < DECON_BAND_PX; i++) interieur = dilateFond(interieur)
  const sur = new Uint8Array(total) // 1 = couleur fiable (intérieur profond)
  for (let p = 0; p < total; p++) sur[p] = maskErode[p] ? 0 : interieur[p] ? 0 : 1
  for (let pass = 0; pass < DECON_BAND_PX + 1; pass++) {
    const surAvant = new Uint8Array(sur)
    for (let y = 0; y < height; y++) {
      const row = y * width
      for (let x = 0; x < width; x++) {
        const p = row + x
        if (maskErode[p] || surAvant[p]) continue // fond ou déjà décontaminé
        let r = 0
        let g = 0
        let b = 0
        let n = 0
        const voisins = [
          x > 0 ? p - 1 : -1,
          x < width - 1 ? p + 1 : -1,
          y > 0 ? p - width : -1,
          y < height - 1 ? p + width : -1,
          x > 0 && y > 0 ? p - width - 1 : -1,
          x < width - 1 && y > 0 ? p - width + 1 : -1,
          x > 0 && y < height - 1 ? p + width - 1 : -1,
          x < width - 1 && y < height - 1 ? p + width + 1 : -1,
        ]
        for (const v of voisins) {
          if (v < 0 || !surAvant[v]) continue
          r += data[v * channels]!
          g += data[v * channels + 1]!
          b += data[v * channels + 2]!
          n += 1
        }
        if (!n) continue
        data[p * channels] = Math.round(r / n)
        data[p * channels + 1] = Math.round(g / n)
        data[p * channels + 2] = Math.round(b / n)
        sur[p] = 1
      }
    }
  }

  // 4. alpha féathéré + bbox (doctrine cutoutFlatBackground)
  const alphaHard = new Uint8Array(total)
  for (let p = 0; p < total; p++) alphaHard[p] = maskErode[p] ? 0 : 255
  const alphaFeathered = boxBlur3(alphaHard, width, height)

  let minX = width
  let minY = height
  let maxX = 0
  let maxY = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      data[p * channels + 3] = alphaFeathered[p]!
      if (alphaFeathered[p]! > 8) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX <= minX || maxY <= minY) {
    // détourage raté (image pleine) : image telle quelle avec alpha, ratios francs
    const png = await sharp(data, { raw: { width, height, channels } }).png().toBuffer()
    return { png, width, height, fondRatio, bboxFraction: { width: 1, height: 1 } }
  }

  const bboxFraction = { width: (maxX - minX + 1) / width, height: (maxY - minY + 1) / height }
  const margin = Math.round(Math.max(maxX - minX, maxY - minY) * marginRatio)
  const left = Math.max(0, minX - margin)
  const top = Math.max(0, minY - margin)
  const cropWidth = Math.min(width - left, maxX - minX + margin * 2)
  const cropHeight = Math.min(height - top, maxY - minY + margin * 2)

  const png = await sharp(data, { raw: { width, height, channels } })
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .png()
    .toBuffer()
  return { png, width: cropWidth, height: cropHeight, fondRatio, bboxFraction }
}

// Déclinaison monochrome locale : silhouette alpha → blanc ou noir pur.
export async function makeMonochrome(cutoutPng: Buffer, color: 'white' | 'black'): Promise<Buffer> {
  const { data, info } = await sharp(cutoutPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const value = color === 'white' ? 255 : 0
  for (let p = 0; p < info.width * info.height; p++) {
    data[p * 4] = value
    data[p * 4 + 1] = value
    data[p * 4 + 2] = value
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer()
}
