/*
 * Run 6 — LA PLANCHE D'E3 : AVANT / APRÈS / RÉFÉRENCES.
 *
 * C'est la seule sortie qui décide. E1 a montré pourquoi : trois instruments
 * ont noté 8-9/10 des candidats que l'opérateur a rejetés, et le duel forcé a
 * classé un rejeté AU-DESSUS des deux gagnants du plafond. La mesure retire une
 * famille d'échecs, elle ne prédit pas un verdict. La barre est donc regardée,
 * pas racontée.
 *
 * PIVOT IDIOME (17/08) — la troisième ligne CHANGE. Elle portait les deux
 * gagnants du test plafond ; ils sont retirés sur décision opérateur : ils
 * parlaient la même langue que le corpus fautif (chrome sur palmiers néon,
 * c'est-à-dire un écran de chargement GTA V). La barre est désormais faite de
 * VRAIES pièces du dossier « entrainement IA fivem ».
 *
 *   bun run scripts/calibration/planche-e3.ts [--briefs=nox,vulcain,azure]
 * Sortie : captures/calibration/_e3/planche-e3.jpg — zéro appel API.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'fs'
import { join, resolve } from 'path'
import sharp, { type OverlayOptions } from 'sharp'
import { CALIBRATION_DIR } from './budget6'
import { BRIEFS_E3 } from './briefs-e3'

const CELL = 512
const CAPTION = 64
const HEADER = 58
const GAP = 10
const SORTIE = join(CALIBRATION_DIR, '_e3')
const LOGO_DIR = resolve(import.meta.dir, '../../src/engine/exemplars/fivem/logo')

const filtre = process.argv.find((a) => a.startsWith('--briefs='))?.slice(9).split(',').filter(Boolean)
const briefs = filtre?.length ? BRIEFS_E3.filter((b) => filtre.includes(b.id)) : BRIEFS_E3

type Resultat = {
  brief: string
  nom: string
  archetype: string
  famille_rendu?: string
  composition: { overlapRatio: number; verdict: string; seuil: number | null; mesurable?: boolean } | null
  debordementBlockout: number | null
}

const rapportPath = join(SORTIE, 'e3-rapport.json')
const resultats: Resultat[] = existsSync(rapportPath)
  ? ((JSON.parse(readFileSync(rapportPath, 'utf-8')) as { resultats: Resultat[] }).resultats ?? [])
  : []

/*
 * Un candidat plus VIEUX que les concepts de son brief n'a pas été rendu sous
 * la configuration courante. Le 17/08, le budget s'est épuisé avant le rendu
 * d'azure : sans cette marque, la planche l'aurait présenté comme le résultat
 * du dernier réglage. Une comparaison faussée est pire que pas de comparaison.
 */
function rejoueSousLaConfigCourante(id: string): boolean {
  const image = join(SORTIE, id, 'candidate.png')
  const concepts = join(SORTIE, `concepts-${id}.json`)
  if (!existsSync(image) || !existsSync(concepts)) return true
  return statSync(image).mtimeMs >= statSync(concepts).mtimeMs
}

function legende(id: string): string {
  const r = resultats.find((x) => x.brief === id)
  const marque = rejoueSousLaConfigCourante(id) ? '' : ' ⚠ NON REJOUÉ'
  if (!r) return `${id}${marque}`
  const tete = [r.nom, r.archetype, r.famille_rendu].filter(Boolean).join(' · ') + marque
  if (!r.composition) return `${tete} · sans lettrage`
  // un échec d'instrument s'affiche comme tel, jamais comme un zéro
  if (r.composition.mesurable === false) return `${tete} · NON MESURÉ`
  // PIVOT : sur un archétype sans emblème séparé, l'overlap ne dit rien — on
  // l'écrit plutôt que d'afficher un chiffre qui se lirait comme une note.
  if (r.composition.verdict === 'non_applicable') return `${tete} · overlap sans objet`
  return `${tete} · overlap ${r.composition.overlapRatio.toFixed(2)} (${r.composition.verdict})`
}

type Cellule = { titre: string; chemin: string }
type Ligne = { entete: string; cellules: Cellule[] }

/** La version archivée la plus récente d'un brief (candidate-vN.png, N max). */
function versionPrecedente(id: string): { chemin: string; n: number } | null {
  let trouve: { chemin: string; n: number } | null = null
  for (let n = 1; n <= 9; n += 1) {
    const chemin = join(SORTIE, id, `candidate-v${n}.png`)
    if (existsSync(chemin)) trouve = { chemin, n }
  }
  return trouve
}

const avant = briefs
  .map((b) => ({ id: b.id, v: versionPrecedente(b.id) }))
  .filter((c): c is { id: string; v: { chemin: string; n: number } } => c.v !== null)

/*
 * LA LIGNE DE RÉFÉRENCES — trois pièces du dossier « entrainement IA fivem »,
 * choisies pour couvrir les trois traits que le pivot vise, pas pour être
 * jolies : la trame + les scanlines dans le glyphe, la fusion glyphe/emblème en
 * halftone, le monogramme plat duotone sur scène sombre.
 */
const REFERENCES: Cellule[] = [
  { titre: 'logotbnnn — contour noir, scanlines dans les lettres, halftone de fond', chemin: join(LOGO_DIR, 'logotbnnn.jpg') },
  { titre: 'vulcainlogo — glyphe et emblème en UNE silhouette, trame halftone', chemin: join(LOGO_DIR, 'vulcainlogo.jpg') },
  { titre: 'black-world1 — monogramme plat duotone, skyline à bas contraste', chemin: join(LOGO_DIR, 'black-world1.jpg') },
]

const LIGNES: Ligne[] = [
  ...(avant.length
    ? [
        {
          entete: 'AVANT — DA v6 d\'origine : S1 « premium », familles chrome/satin, sélection sur l\'overlap',
          cellules: avant.map((c) => ({ titre: `${c.id} · version ${c.v.n}`, chemin: c.v.chemin })),
        },
      ]
    : []),
  {
    entete:
      'APRÈS — pivot idiome : S1 sans « premium », familles flat_vector_texture / texture_fill / scene_composite, HERO_MONOGRAM par défaut',
    cellules: briefs.map((b) => ({ titre: legende(b.id), chemin: join(SORTIE, b.id, 'candidate.png') })),
  },
  {
    entete: 'RÉFÉRENCES — 3 pièces du dossier « entrainement IA fivem » : la langue à parler',
    cellules: REFERENCES,
  },
]

function svgTexte(largeur: number, hauteur: number, texte: string, taille: number, fond: string): Buffer {
  const echappe = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  // deux lignes maximum : les légendes portent maintenant la mesure
  const coupe = Math.ceil(texte.length / (texte.length > 46 ? 2 : 1))
  const morceaux = texte.length > 46 ? [texte.slice(0, coupe), texte.slice(coupe)] : [texte]
  const lignes = morceaux
    .map((m, i) => `<text x="12" y="${Math.round(hauteur * (morceaux.length === 1 ? 0.68 : 0.42 + i * 0.4))}" font-family="Arial" font-size="${taille}" fill="#ffffff">${echappe(m)}</text>`)
    .join('')
  return Buffer.from(`<svg width="${largeur}" height="${hauteur}"><rect width="${largeur}" height="${hauteur}" fill="${fond}"/>${lignes}</svg>`)
}

const cols = Math.max(...LIGNES.map((l) => l.cellules.length))
const largeur = cols * CELL + (cols + 1) * GAP
const ligneH = HEADER + CELL + CAPTION + GAP
const hauteur = LIGNES.length * ligneH + GAP

const composites: OverlayOptions[] = []
let y = GAP
let manquantes = 0
for (const ligne of LIGNES) {
  composites.push({ input: svgTexte(largeur - 2 * GAP, HEADER - 8, ligne.entete, 26, '#1d2530'), left: GAP, top: y })
  const yCell = y + HEADER
  for (const [i, cell] of ligne.cellules.entries()) {
    const x = GAP + i * (CELL + GAP)
    if (existsSync(cell.chemin)) {
      const img = await sharp(readFileSync(cell.chemin)).resize(CELL, CELL, { fit: 'contain', background: '#0b0e14' }).png().toBuffer()
      composites.push({ input: img, left: x, top: yCell })
    } else {
      composites.push({ input: svgTexte(CELL, CELL, `MANQUANT : ${cell.titre}`, 22, '#3a1d1d'), left: x, top: yCell })
      console.warn(`⚠ cellule manquante : ${cell.chemin}`)
      manquantes += 1
    }
    composites.push({ input: svgTexte(CELL, CAPTION, cell.titre, 20, '#111'), left: x, top: yCell + CELL })
  }
  y += ligneH
}

mkdirSync(SORTIE, { recursive: true })
const chemin = join(SORTIE, 'planche-e3.jpg')
await sharp({ create: { width: largeur, height: hauteur, channels: 3, background: '#05070b' } })
  .composite(composites)
  .jpeg({ quality: 90 })
  .toFile(chemin)

console.log(`Planche : ${chemin} (${largeur}×${hauteur})${manquantes ? ` — ${manquantes} cellule(s) manquante(s)` : ''}`)
