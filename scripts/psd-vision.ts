/**
 * Run 5.7 — LOT 1.4 : vision sur calques isolés.
 *
 * Un élément isolé s'analyse infiniment mieux qu'un rendu aplati : pour chaque
 * PSD décomposé, on assemble des planches contact numérotées (fond damier,
 * vignettes ≤200 px) de TOUS les calques/groupes rasterisés, et gemini-3.5-flash
 * classe chaque cellule : rôle dans la pile (fond / lettrage / emblème / texture /
 * effet lumière / accent / badge / ui), nature du lettrage (typographié vs
 * custom dessiné), description courte, couleurs dominantes.
 *
 * Résultats fusionnés DANS les manifests (champ `vision` par nœud) +
 * synthèse `_vision-summary.json` (piles rôle-par-rôle en ordre z, par PSD).
 *
 * Coût : ~1 appel flash par planche de 24 cellules (~25 appels au total),
 * débité au grand livre run 5.7 sous le label `run57-vision-calques`.
 *
 * Usage : bun scripts/psd-vision.ts [--only <psd>] [--dry]
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import sharp, { type OverlayOptions } from 'sharp'
import { geminiVisionText } from '../src/lib/ai/gemini'
import { installBudgetGuard, setBudgetLabel, spentForLabel } from './calibration/budget'

const ROOT = join(import.meta.dir, '..', 'src', 'engine', 'psd-knowledge')
const VISION_MODEL = 'gemini-3.5-flash'
const CELL = 200 // vignette
const LABEL_H = 26
const COLS = 6
const PER_SHEET = 24

type Json = Record<string, unknown>

interface CellRef { id: number; name: string; kind: string; png: string; node: Json }

const ROLES = [
  'fond',
  'lettrage',
  'embleme',
  'mascotte',
  'texture',
  'effet_lumiere',
  'accent_deco',
  'badge_forme',
  'ui_texte_secondaire',
  'autre',
] as const

interface VisionCell {
  cell: number
  role: (typeof ROLES)[number]
  lettrage_nature: 'typographie' | 'custom_dessine' | 'absent'
  description: string
  couleurs: string[]
}

const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const onlyIdx = args.indexOf('--only')
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1] : undefined

function collectCells(nodes: Json[], out: CellRef[]): void {
  for (const n of nodes) {
    if (typeof n.png === 'string') {
      out.push({ id: n.id as number, name: String(n.name), kind: String(n.kind), png: n.png as string, node: n })
    }
    if (Array.isArray(n.children)) collectCells(n.children as Json[], out)
  }
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Planche 100 % sharp : fond damier + étiquettes en SVG, vignettes en composite
 *  (le drawImage de @napi-rs/canvas est silencieusement inopérant dans cet
 *  environnement Bun/Windows — constaté sur la première planche vulcainlogo). */
async function buildSheet(dir: string, cells: CellRef[]): Promise<Buffer> {
  const rows = Math.ceil(cells.length / COLS)
  const W = COLS * CELL
  const H = rows * (CELL + LABEL_H)

  const svgParts: string[] = [
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`,
    `<defs><pattern id="chk" width="32" height="32" patternUnits="userSpaceOnUse">`,
    `<rect width="32" height="32" fill="#454545"/><rect width="16" height="16" fill="#5a5a5a"/><rect x="16" y="16" width="16" height="16" fill="#5a5a5a"/></pattern></defs>`,
    `<rect width="${W}" height="${H}" fill="#222222"/>`,
  ]
  for (let i = 0; i < cells.length; i++) {
    const cx = (i % COLS) * CELL
    const cy = Math.floor(i / COLS) * (CELL + LABEL_H)
    svgParts.push(`<rect x="${cx}" y="${cy}" width="${CELL}" height="${CELL}" fill="url(#chk)"/>`)
    svgParts.push(`<rect x="${cx}" y="${cy + CELL}" width="${CELL}" height="${LABEL_H}" fill="#000000"/>`)
    const cell = cells[i]!
    const label = `#${cell.id} ${cell.kind === 'group' ? '[G] ' : ''}${cell.name.slice(0, 16)}`
    svgParts.push(
      `<text x="${cx + 4}" y="${cy + CELL + 18}" font-family="Arial, sans-serif" font-size="14" font-weight="bold" fill="#ffffff">${xmlEscape(label)}</text>`
    )
  }
  svgParts.push('</svg>')
  const base = await sharp(Buffer.from(svgParts.join(''))).png().toBuffer()

  const overlays: OverlayOptions[] = []
  for (let i = 0; i < cells.length; i++) {
    const cx = (i % COLS) * CELL
    const cy = Math.floor(i / COLS) * (CELL + LABEL_H)
    const pngPath = join(dir, cells[i]!.png)
    if (!existsSync(pngPath)) continue
    try {
      const thumb = await sharp(pngPath).resize(CELL - 8, CELL - 8, { fit: 'inside', withoutEnlargement: true }).png().toBuffer()
      const meta = await sharp(thumb).metadata()
      overlays.push({
        input: thumb,
        left: cx + Math.round((CELL - (meta.width ?? 0)) / 2),
        top: cy + Math.round((CELL - (meta.height ?? 0)) / 2),
      })
    } catch {
      /* vignette illisible : cellule damier vide, le modèle dira "autre" */
    }
  }
  return sharp(base).composite(overlays).jpeg({ quality: 88 }).toBuffer()
}

function visionPrompt(psd: string, cells: CellRef[]): string {
  const liste = cells.map((c) => `#${c.id} (${c.kind}${c.kind === 'text' ? ', calque texte Photoshop' : ''})`).join(', ')
  return [
    `Planche contact de calques ISOLÉS extraits du fichier Photoshop d'un logo/bannière FiveM professionnel (« ${psd} »).`,
    `Chaque cellule montre UN calque seul sur damier gris, avec son numéro sous la vignette. Cellules présentes : ${liste}.`,
    ``,
    `Pour CHAQUE cellule, classe le calque :`,
    `- "role" : ${ROLES.join(' | ')} — fond = arrière-plan/scène/ciel ; lettrage = le nom du serveur en lettres ; embleme = symbole/objet central non textuel ; mascotte = personnage ; texture = grain/motif/bruit de surface ; effet_lumiere = glow/lens flare/éclat/fumée lumineuse ; accent_deco = trait/forme décorative ; badge_forme = plaque/écusson/conteneur ; ui_texte_secondaire = slogan/discord/url en petit.`,
    `- "lettrage_nature" : si le calque contient des lettres → "typographie" (lettres régulières issues d'une police, même stylisées) ou "custom_dessine" (lettres dessinées/déformées à la main, uniques). Sinon "absent".`,
    `- "description" : ≤ 12 mots, français.`,
    `- "couleurs" : les 2 couleurs dominantes en hex (ignore le damier gris #5a5a5a/#454545).`,
    ``,
    `Réponds UNIQUEMENT en JSON : {"cells":[{"cell":<numéro>,"role":"...","lettrage_nature":"...","description":"...","couleurs":["#..","#.."]}]}. Une entrée par cellule, aucun numéro omis.`,
  ].join('\n')
}

function parseCells(text: string): VisionCell[] | null {
  try {
    const clean = text.replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '')
    const obj = JSON.parse(clean) as { cells?: VisionCell[] }
    return Array.isArray(obj.cells) ? obj.cells : null
  } catch {
    return null
  }
}

async function processPsd(dirName: string): Promise<Json | null> {
  const dir = join(ROOT, dirName)
  const mPath = join(dir, 'manifest.json')
  if (!existsSync(mPath)) return null
  const manifest = JSON.parse(readFileSync(mPath, 'utf8')) as Json
  const cells: CellRef[] = []
  collectCells((manifest.tree ?? []) as Json[], cells)
  if (!cells.length) return null

  console.log(`[${dirName}] ${cells.length} calques → ${Math.ceil(cells.length / PER_SHEET)} planche(s)`)
  if (DRY) return null

  const byId = new Map<number, Json>()
  for (let s = 0; s < cells.length; s += PER_SHEET) {
    const batch = cells.slice(s, s + PER_SHEET)
    const sheet = await buildSheet(dir, batch)
    const sheetPath = join(dir, `_sheet-${s / PER_SHEET}.jpg`)
    writeFileSync(sheetPath, sheet)

    let parsed: VisionCell[] | null = null
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      const text = await geminiVisionText({
        model: VISION_MODEL,
        imageBase64: sheet.toString('base64'),
        mimeType: 'image/jpeg',
        prompt: visionPrompt(manifest.psd as string, batch),
        temperature: 0,
        json: true,
        thinkingBudget: 0,
        maxOutputTokens: 8000,
      })
      parsed = parseCells(text)
      if (!parsed) console.warn(`[${dirName}] planche ${s / PER_SHEET} : JSON illisible (tentative ${attempt + 1})`)
    }
    if (!parsed) continue
    for (const v of parsed) {
      if (typeof v.cell !== 'number') continue
      byId.set(v.cell, {
        role: ROLES.includes(v.role) ? v.role : 'autre',
        lettrage_nature: v.lettrage_nature ?? 'absent',
        description: v.description,
        couleurs: v.couleurs,
        modele: VISION_MODEL,
      })
    }
  }

  // fusion dans le manifest
  let merged = 0
  const mergeInto = (nodes: Json[]): void => {
    for (const n of nodes) {
      const v = byId.get(n.id as number)
      if (v) {
        n.vision = v
        merged++
      }
      if (Array.isArray(n.children)) mergeInto(n.children as Json[])
    }
  }
  mergeInto((manifest.tree ?? []) as Json[])
  writeFileSync(mPath, JSON.stringify(manifest, null, 2))
  console.log(`[${dirName}] vision fusionnée sur ${merged}/${cells.length} calques`)

  // pile en ordre z (racine z0 = bas de pile Photoshop → on lit l'arbre tel quel)
  const pile = cells
    .map((c) => ({ id: c.id, name: c.name, kind: c.kind, ...(byId.get(c.id) ?? {}) }))
    .filter((c) => (c as Json).role)
  return { psd: manifest.psd, dir: dirName, pile }
}

installBudgetGuard()
setBudgetLabel('run57-vision-calques')

const dirs = readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((d) => !ONLY || d === ONLY)

const summary: Json[] = []
for (const d of dirs) {
  const r = await processPsd(d)
  if (r) summary.push(r)
}
if (!DRY && summary.length) {
  writeFileSync(join(ROOT, '_vision-summary.json'), JSON.stringify({ generatedAt: new Date().toISOString(), modele: VISION_MODEL, psds: summary }, null, 2))
}
console.log(`Terminé. ${summary.length} PSD annotés. Coût vision : ${spentForLabel('run57-vision-calques').toFixed(4)} €`)
