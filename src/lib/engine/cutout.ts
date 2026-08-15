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

export async function cutoutFlatBackground(input: Buffer, tolerance = 34): Promise<CutoutResult> {
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

  // marge de 2 %
  const margin = Math.round(Math.max(maxX - minX, maxY - minY) * 0.02)
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
