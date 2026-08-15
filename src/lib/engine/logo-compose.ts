import sharp from 'sharp'

// ── Composition [fond][logo] de l'étape B (run 5.4, LOT 4) — ZÉRO appel API ──
// Le fond est généré seul, le logo master (PNG alpha) est posé dessus par
// calques, avec une harmonisation légère locale : ombre douce projetée par
// l'alpha du logo + glow de contact discret. Le fond change, le logo ne bouge
// jamais — et inversement.

type ComposeInput = {
  fondPng: Buffer
  logoPng: Buffer
  width: number
  height: number
  // largeur du logo en fraction de la largeur du canvas (défaut 0.62 — cohérent
  // avec l'occupation 60-70 % du gabarit maître)
  logoRatio?: number
}

// Ombre douce : l'alpha du logo, floutée et noircie, décalée vers le bas.
async function softShadow(logoResized: Buffer, blurPx: number): Promise<Buffer> {
  const { data, info } = await sharp(logoResized).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  for (let p = 0; p < info.width * info.height; p++) {
    data[p * 4] = 0
    data[p * 4 + 1] = 0
    data[p * 4 + 2] = 0
    data[p * 4 + 3] = Math.round((data[p * 4 + 3] ?? 0) * 0.38)
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .blur(blurPx)
    .png()
    .toBuffer()
}

// Glow de contact : la même silhouette en blanc, floutée large, très discrète.
async function contactGlow(logoResized: Buffer, blurPx: number): Promise<Buffer> {
  const { data, info } = await sharp(logoResized).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  for (let p = 0; p < info.width * info.height; p++) {
    data[p * 4] = 255
    data[p * 4 + 1] = 255
    data[p * 4 + 2] = 255
    data[p * 4 + 3] = Math.round((data[p * 4 + 3] ?? 0) * 0.16)
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .blur(blurPx)
    .png()
    .toBuffer()
}

export async function composeLogoOnFond(input: ComposeInput): Promise<Buffer> {
  const { width, height } = input
  const logoRatio = input.logoRatio ?? 0.62

  const fond = await sharp(input.fondPng).resize(width, height, { fit: 'cover' }).png().toBuffer()

  const logoTargetWidth = Math.round(width * logoRatio)
  const logoTargetHeight = Math.round(height * logoRatio)
  const logo = await sharp(input.logoPng)
    .resize({ width: logoTargetWidth, height: logoTargetHeight, fit: 'inside', withoutEnlargement: false })
    .png()
    .toBuffer()
  const logoMeta = await sharp(logo).metadata()
  const logoW = logoMeta.width ?? logoTargetWidth
  const logoH = logoMeta.height ?? logoTargetHeight

  const left = Math.round((width - logoW) / 2)
  const top = Math.round((height - logoH) / 2)
  const shadowOffset = Math.max(2, Math.round(height * 0.012))
  const blurPx = Math.max(4, Math.round(width * 0.012))

  const [shadow, glow] = await Promise.all([
    softShadow(logo, blurPx),
    contactGlow(logo, blurPx * 2.2),
  ])

  return sharp(fond)
    .composite([
      { input: glow, left, top, blend: 'screen' },
      { input: shadow, left, top: top + shadowOffset, blend: 'over' },
      { input: logo, left, top, blend: 'over' },
    ])
    .png()
    .toBuffer()
}

// Bannière-logo 16:9 simple : le fond recadré en 16:9, le logo centré (~50 %
// de la hauteur — la boîte de resize est min(l, h) × ratio) — la déclinaison
// « bannière » stockée à la validation.
export async function composeBanniereLogo(input: {
  fondPng: Buffer
  logoPng: Buffer
  width?: number
  height?: number
}): Promise<Buffer> {
  const width = input.width ?? 1920
  const height = input.height ?? 1080
  return composeLogoOnFond({
    fondPng: input.fondPng,
    logoPng: input.logoPng,
    width,
    height,
    logoRatio: 0.5,
  })
}
