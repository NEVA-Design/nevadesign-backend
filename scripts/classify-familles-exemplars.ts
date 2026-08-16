/*
 * Run 5.8 (chantier 2) — classification OFFLINE des 59 exemplaires logo par
 * famille de rendu. Aujourd'hui pickExemplars joint des images sans garantie
 * qu'elles montrent la même famille que le concept → transfert de style
 * faible. Ce script étend le _manifest.json avec :
 *   - famille : plat_premium | semi_flat_biseau | dimensionnelle
 *     dérivée de scores.relief_3d avec LES MÊMES SEUILS que les clusters
 *     mesurés de logo.json.familles_rendu (source : « manifest v4, seuils
 *     relief_3d <=2 / 3-5 / >=6 ») — zéro appel vision nécessaire, l'analyse
 *     v4 a déjà noté les 59 images.
 *   - lettrage_riche : true si l'exemplaire montre un lettrage travaillé
 *     (type non « none ») — pickExemplars privilégie ces références pour le
 *     lockup fusionné (le traitement typographique est ce qu'on transfère).
 *
 * Usage : bun run scripts/classify-familles-exemplars.ts [--dry]
 */

import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const MANIFEST_PATH = resolve(import.meta.dir, '../src/engine/exemplars/fivem/logo/_manifest.json')

type Lettrage = { type?: string; integration_embleme?: string; traitement_contour?: string }
type Entry = {
  slug: string
  scores?: { relief_3d?: number }
  lettrage?: Lettrage
  famille?: string
  lettrage_riche?: boolean
}
type Manifest = { categorie: string; genere_le: string; exemplaires: Entry[] }

// Les seuils des clusters mesurés (logo.json.familles_rendu.source).
function familleOf(relief3d: number): 'plat_premium' | 'semi_flat_biseau' | 'dimensionnelle' {
  if (relief3d <= 2) return 'plat_premium'
  if (relief3d <= 5) return 'semi_flat_biseau'
  return 'dimensionnelle'
}

function lettrageRiche(l: Lettrage | undefined): boolean {
  return Boolean(l?.type && l.type !== 'none')
}

const dry = process.argv.includes('--dry')
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as Manifest

const compte: Record<string, number> = { plat_premium: 0, semi_flat_biseau: 0, dimensionnelle: 0 }
let richesse = 0
const sansScore: string[] = []

for (const entry of manifest.exemplaires) {
  const relief = entry.scores?.relief_3d
  if (relief === undefined || relief === null) {
    sansScore.push(entry.slug)
    continue
  }
  entry.famille = familleOf(relief)
  entry.lettrage_riche = lettrageRiche(entry.lettrage)
  compte[entry.famille] = (compte[entry.famille] ?? 0) + 1
  if (entry.lettrage_riche) richesse += 1
}

console.log(`Exemplaires : ${manifest.exemplaires.length}`)
console.log(`Familles : plat_premium ${compte.plat_premium} · semi_flat_biseau ${compte.semi_flat_biseau} · dimensionnelle ${compte.dimensionnelle}`)
console.log(`Lettrage riche : ${richesse}/${manifest.exemplaires.length}`)
if (sansScore.length) {
  console.warn(`⚠ ${sansScore.length} exemplaire(s) sans scores.relief_3d (à classer par vision) : ${sansScore.join(', ')}`)
}

if (dry) {
  console.log('--dry : manifest non modifié.')
} else {
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 1))
  console.log(`Écrit : ${MANIFEST_PATH}`)
}
