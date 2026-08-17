/*
 * Run 6 — INTÉGRER AU CORPUS LES PIÈCES D'IDIOME OUBLIÉES. Zéro appel API.
 *
 * Pourquoi ce script existe : l'entraînement v4 a compilé 59 logos depuis
 * « entrainement IA fivem/logo serveur fivem gtarp », mais CINQ pièces HD du
 * dossier n'y sont jamais entrées :
 *   - quatre PNG (logotbnnn, vulcainlogo, gtanewlogo, GoldenLogo) sont arrivés
 *     dans le dossier APRÈS la passe d'entraînement (ils venaient de PackPsd,
 *     dossier sans catégorie) ;
 *   - blackstory-rp2 est un GIF, extension explicitement écartée par
 *     train-fivem-v4 (« format animé hors extensions retenues »).
 *
 * Ce n'est pas un détail de comptage : DEUX d'entre elles (logotbnnn,
 * vulcainlogo) sont les SEULES pièces du corpus à porter la trame halftone et
 * le remplissage de glyphe par une matière — c'est-à-dire l'idiome que
 * l'opérateur décrit comme la vraie cible FiveM. Sans elles, aucune image
 * joignable n'enseigne cette langue, et la consigne « flat_vector_texture »
 * n'aurait aucune référence pour la porter.
 *
 * Le script recompile les images au format du corpus (1024 px q92 mozjpeg,
 * comme recompile-exemplars-hq.ts), extrait la palette dominante EN CODE, et
 * ajoute les entrées au manifest. Les reverse-prompts (.txt) sont écrits à la
 * main, à l'œil, dans la structure 0-5 du corpus : aucune vision payante.
 *
 * Usage : bun run scripts/calibration/ajoute-exemplars-idiome.ts [--dry]
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import sharp from 'sharp'

const SOURCE_DIR = resolve(import.meta.dir, '../../../entrainement IA fivem/logo serveur fivem gtarp')
const LOGO_DIR = resolve(import.meta.dir, '../../src/engine/exemplars/fivem/logo')
const MANIFEST = join(LOGO_DIR, '_manifest.json')
const MAX_SIDE = 1024
const QUALITY = 92
const DRY = process.argv.includes('--dry')

type Piece = {
  slug: string
  fichier: string
  tags: string[]
  energie: number
  modernite: number
  /** famille héritée du manifest (le typage du corpus n'a que ces trois valeurs) */
  famille: 'plat_premium' | 'semi_flat_biseau' | 'dimensionnelle'
  lettrage_riche: boolean
  construction: string
  lettrage: { type: string; integration_embleme: string; traitement_contour: string }
  scores: { relief_3d: number; glow: number; saturation: number; sombre_clair: number; complexite: number }
  style: {
    famille: 'plat_premium' | 'semi_flat_biseau' | 'dimensionnelle'
    traitement_lettrage: string
    matiere: string
    embleme: { present: boolean; type: string | null }
    ambiance: string
    fond_sombre: boolean
  }
  reverse: string
}

const PIECES: Piece[] = [
  {
    slug: 'logotbnnn',
    fichier: 'logotbnnn.png',
    tags: ['urbain', 'esport', 'sombre'],
    energie: 80,
    modernite: 70,
    famille: 'plat_premium',
    lettrage_riche: true,
    construction:
      "Three-letter monogram 'TBN' in a heavy angular display face, drawn on a violet chevron plate with a thick black keyline. A Statue of Liberty illustration rises BEHIND the letters and her raised torch arm crosses IN FRONT of the T, so the figure is woven through the lockup rather than placed above it.",
    lettrage: { type: 'monogram', integration_embleme: 'woven through the lettering', traitement_contour: 'thick black keyline' },
    scores: { relief_3d: 2, glow: 3, saturation: 7, sombre_clair: 2, complexite: 7 },
    style: {
      famille: 'plat_premium',
      traitement_lettrage: 'flat_outline',
      matiere: 'flat violet duotone with diagonal scanlines',
      embleme: { present: true, type: 'statue of liberty' },
      ambiance: 'urban',
      fond_sombre: true,
    },
    reverse: `0. CONTEXT — FiveM server logo, flat vector monogram with a woven illustration.
1. SHAPE — Three-letter monogram 'TBN' in a heavy angular display face, set on a violet chevron plate with a thick black keyline. A Statue of Liberty illustration rises behind the letters; her raised torch arm crosses in front of the T and her gown falls through the bottom of the chevron, so the figure is woven through the lockup instead of sitting above it. The lockup occupies 70% of the width.
2. RENDER — Flat 2D vector, no 3D extrusion. The letters are filled with a violet-to-white gradient carrying fine diagonal scanlines; the illustration is a two-tone screenprint (white line work on violet). Every shape carries the same thick black outline.
3. COLORS — Deep violet #4B1E78, light lilac #C89BE8, pure white #FFFFFF, near-black #0B0610.
4. FORMAT — Square composition, centred subject. Full-bleed dark background: a night skyline in low contrast under a violet halftone dot screen, vignetted at the corners.
5. KEYWORDS — flat vector, thick outline, halftone screen, scanline fill, duotone, monogram, esport, statue of liberty, night city.
`,
  },
  {
    slug: 'vulcainlogo',
    fichier: 'vulcainlogo.png',
    tags: ['esport', 'sombre', 'luxe'],
    energie: 65,
    modernite: 75,
    famille: 'plat_premium',
    lettrage_riche: true,
    construction:
      "A letter 'V' whose two arms open into a pair of stylized wings, cut as one single silhouette — the wing feathers and the letter share the same contour, no seam between them.",
    lettrage: { type: 'monogram', integration_embleme: 'fused in silhouette', traitement_contour: 'dark inner cut' },
    scores: { relief_3d: 2, glow: 4, saturation: 3, sombre_clair: 2, complexite: 4 },
    style: {
      famille: 'plat_premium',
      traitement_lettrage: 'flat_outline',
      matiere: 'iced blue-white flat fill with halftone dots',
      embleme: { present: true, type: 'wings' },
      ambiance: 'esport',
      fond_sombre: true,
    },
    reverse: `0. CONTEXT — FiveM server logo, flat vector monogram fused with an emblem.
1. SHAPE — A letter 'V' whose two arms open into a pair of stylized wings, cut as one single silhouette: the feathers and the letter share the same contour, with dark negative-space slots separating the feathers. The mark occupies 65% of the width and is centred.
2. RENDER — Flat 2D vector, no 3D extrusion. The fill is an iced blue-to-white vertical gradient carrying a visible halftone dot screen that fades from dense at the bottom to clear at the top. A soft dark drop shadow sits directly under the silhouette.
3. COLORS — Ice white #EAF6FF, pale cyan #A8D8EE, steel blue #1E4A63, near-black #05090D.
4. FORMAT — Square composition, centred subject, full-bleed dark background: a diagonal technical grid and a faint halftone gradient, very low contrast.
5. KEYWORDS — flat vector, halftone dots, duotone, wings, monogram, esport, iced blue, dark grid background.
`,
  },
  {
    slug: 'gtanewlogo',
    fichier: 'gtanewlogo.png',
    tags: ['urbain', 'ete', 'retro'],
    energie: 75,
    modernite: 60,
    famille: 'semi_flat_biseau',
    lettrage_riche: true,
    construction:
      "Two-line stacked wordmark: 'GTA' in a heavy rounded display face on top, 'NEW' in italic script on a slanted ribbon plate below, the ribbon tucked under the baseline of the first line.",
    lettrage: { type: 'wordmark', integration_embleme: 'stacked lockup', traitement_contour: 'white keyline' },
    scores: { relief_3d: 4, glow: 4, saturation: 8, sombre_clair: 4, complexite: 5 },
    style: {
      famille: 'semi_flat_biseau',
      traitement_lettrage: 'flat_outline',
      matiere: 'pink to orange flat gradient',
      embleme: { present: false, type: null },
      ambiance: 'urban',
      fond_sombre: true,
    },
    reverse: `0. CONTEXT — FiveM server logo, stacked wordmark over a night scene.
1. SHAPE — Two-line stacked wordmark: 'GTA' in a heavy rounded display face on top, 'NEW' in an italic script sitting on a slanted ribbon plate below, tucked under the baseline of the first line. The lockup occupies 80% of the width.
2. RENDER — Semi-flat: solid colour fills with a thin white keyline and a short soft drop shadow, a light inner bevel on the top line, no full 3D extrusion.
3. COLORS — Hot pink #F26DC8, warm orange #F09A5A, pure white #FFFFFF, deep magenta #3B0B2A.
4. FORMAT — Square composition, centred lockup. Full-bleed dark background: palm fronds in silhouette at the corners over a magenta night sky and a faint perspective grid.
5. KEYWORDS — stacked wordmark, script ribbon, white keyline, palms, night city, vice-city palette, semi-flat.
`,
  },
  {
    slug: 'goldenlogo',
    fichier: 'GoldenLogo.png',
    tags: ['luxe', 'sombre', 'esport'],
    energie: 60,
    modernite: 65,
    famille: 'plat_premium',
    lettrage_riche: true,
    construction:
      "Two-letter monogram 'GV' cut as one continuous ribbon: the tail of the G runs into the left arm of the V, and the V's point drops below the baseline of the G.",
    lettrage: { type: 'monogram', integration_embleme: 'fused in silhouette', traitement_contour: 'none' },
    scores: { relief_3d: 2, glow: 5, saturation: 6, sombre_clair: 2, complexite: 3 },
    style: {
      famille: 'plat_premium',
      traitement_lettrage: 'or',
      matiere: 'flat gold gradient',
      embleme: { present: true, type: 'letter G V' },
      ambiance: 'esport',
      fond_sombre: true,
    },
    reverse: `0. CONTEXT — FiveM server logo, flat gold monogram.
1. SHAPE — Two-letter monogram 'GV' cut as one continuous ribbon: the tail of the G runs into the left arm of the V, and the V's point drops below the baseline of the G. Sharp mitred corners, constant stroke width. The mark occupies 75% of the width.
2. RENDER — Flat 2D vector with a single warm gold gradient across the whole silhouette, no bevel and no 3D extrusion. A soft warm glow sits behind the mark.
3. COLORS — Bright gold #F5C542, deep amber #8A5A12, near-black #0A0805.
4. FORMAT — Square composition, centred subject. Full-bleed dark background: torn gold paint strokes at the top and bottom edges over black, plus a faint halftone dot field.
5. KEYWORDS — flat vector, gold gradient, monogram, ligature, paint strokes, halftone, dark background, esport.
`,
  },
  {
    slug: 'blackstory-rp2',
    fichier: 'blackstory-rp2.gif',
    tags: ['urbain', 'ete', 'chill'],
    energie: 55,
    modernite: 55,
    famille: 'plat_premium',
    lettrage_riche: true,
    construction:
      "Two-word lockup: 'BLACK' in a hand-cut brush display face across the full width, 'Story' in a blue script crossing it diagonally, the script sitting in front of the C and behind the K.",
    lettrage: { type: 'wordmark', integration_embleme: 'crossing lockup', traitement_contour: 'white keyline' },
    scores: { relief_3d: 1, glow: 2, saturation: 5, sombre_clair: 2, complexite: 4 },
    style: {
      famille: 'plat_premium',
      traitement_lettrage: 'script',
      matiere: 'flat white and blue',
      embleme: { present: true, type: 'palm trees' },
      ambiance: 'urban',
      fond_sombre: true,
    },
    reverse: `0. CONTEXT — FiveM server logo, flat two-word lockup over a night beach scene.
1. SHAPE — Two-word lockup: 'BLACK' in a hand-cut brush display face across the full width, 'Story' in a blue script crossing it diagonally — the script passes in front of the C and behind the K. Two palm trees in white silhouette rise from behind the ends of the wordmark.
2. RENDER — Flat 2D vector, no extrusion. Solid white fills with a thin white keyline on the script, faint snow-fleck particles over the whole frame.
3. COLORS — Pure white #FFFFFF, electric blue #1E6FE0, night navy #101C2E.
4. FORMAT — Square composition, lockup centred across the middle third. Full-bleed dark background: a low-contrast night street with palms, buildings and a blue-grey sky.
5. KEYWORDS — brush wordmark, script overlay, palms, night, flat vector, duotone, low-contrast background.
`,
  },
]

type ManifestEntry = Record<string, unknown> & { slug: string }
type Manifest = { categorie: string; genere_le: string; exemplaires: ManifestEntry[] }

/** Palette dominante EN CODE (quantification 4 bits par canal, 3 pics les plus
 *  peuplés, séparés d'au moins 60 en distance RGB). Jamais un hex inventé. */
async function paletteDominante(buffer: Buffer): Promise<string[]> {
  const { data, info } = await sharp(buffer).resize(120, 120, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true })
  const canaux = info.channels
  const seaux = new Map<number, { n: number; r: number; g: number; b: number }>()
  for (let i = 0; i < data.length; i += canaux) {
    const r = data[i] ?? 0
    const g = data[i + 1] ?? 0
    const b = data[i + 2] ?? 0
    const cle = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    const s = seaux.get(cle) ?? { n: 0, r: 0, g: 0, b: 0 }
    s.n += 1
    s.r += r
    s.g += g
    s.b += b
    seaux.set(cle, s)
  }
  const tries = [...seaux.values()]
    .map((s) => ({ n: s.n, r: Math.round(s.r / s.n), g: Math.round(s.g / s.n), b: Math.round(s.b / s.n) }))
    .sort((a, b) => b.n - a.n)
  const retenus: Array<{ r: number; g: number; b: number }> = []
  for (const c of tries) {
    if (retenus.length >= 3) break
    const loin = retenus.every((p) => Math.abs(p.r - c.r) + Math.abs(p.g - c.g) + Math.abs(p.b - c.b) > 60)
    if (loin) retenus.push(c)
  }
  return retenus.map((c) => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`)
}

async function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8')) as Manifest
  const connus = new Set(manifest.exemplaires.map((e) => e.slug))
  let ajoutes = 0

  for (const p of PIECES) {
    const src = join(SOURCE_DIR, p.fichier)
    if (!existsSync(src)) {
      console.log(`⚠ ${p.slug} : source absente (${p.fichier}) — ignorée`)
      continue
    }
    if (connus.has(p.slug)) {
      console.log(`= ${p.slug} : déjà au manifest — ignorée`)
      continue
    }
    // `animated: false` : pour un GIF, sharp lit la première frame. C'est ce
    // qu'on veut — un logo animé porte le même dessin sur toutes ses frames.
    const image = sharp(src, { animated: false })
    const meta = await image.metadata()
    const natif = Math.max(meta.width ?? 0, meta.height ?? 0)
    const out = await sharp(src, { animated: false })
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: QUALITY, mozjpeg: true })
      .toBuffer()
    const couleurs = await paletteDominante(out)

    console.log(
      `+ ${p.slug.padEnd(18)} ${natif}px natif → ${(out.length / 1024).toFixed(1)} Ko · palette ${couleurs.join(' ')}`
    )
    if (DRY) continue

    writeFileSync(join(LOGO_DIR, `${p.slug}.jpg`), out)
    writeFileSync(join(LOGO_DIR, `${p.slug}.txt`), p.reverse, 'utf-8')
    manifest.exemplaires.push({
      slug: p.slug,
      source: p.fichier,
      priorite: 'reverse',
      tags: p.tags,
      energie: p.energie,
      modernite: p.modernite,
      couleurs,
      ratio: '1:1',
      typographie_generee: 'none',
      scores: p.scores,
      construction: p.construction,
      lettrage: p.lettrage,
      famille: p.famille,
      lettrage_riche: p.lettrage_riche,
      resolution_native: natif,
      style: p.style,
      ajoute_le: '2026-08-17',
      ajoute_par: 'scripts/calibration/ajoute-exemplars-idiome.ts (run 6 — pivot idiome)',
    })
    ajoutes += 1
  }

  if (!DRY && ajoutes) {
    writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 1)}\n`, 'utf-8')
    console.log(`\nmanifest mis à jour : ${manifest.exemplaires.length} exemplaires (${ajoutes} ajoutés)`)
  } else if (DRY) {
    console.log('\n--dry : rien écrit')
  }
}

void main()
