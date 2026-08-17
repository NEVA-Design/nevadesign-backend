/*
 * Run 6 — LE PIVOT IDIOME, PIÈCE À CONVICTION. Zéro appel API.
 *
 * L'opérateur a demandé de voir, AVANT toute dépense : le nouveau
 * `_fivem-set.json`, ce qui partira réellement au modèle, et le coût estimé.
 * Ce script produit exactement ça, sans rien envoyer.
 *
 *   bun run scripts/calibration/pivot-idiome.ts            # l'aperçu texte
 *   bun run scripts/calibration/pivot-idiome.ts --planche  # + la planche JPG
 *
 * Sortie planche : captures/calibration/_pivot-idiome/planche-idiome.jpg
 */

import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import sharp, { type OverlayOptions } from 'sharp'
import { listReferenceCatalogue, fivemSlugs, goldSlugs, horsCorpusReferenceSlugs } from '../../src/lib/engine/exemplars'
import {
  phraseS1,
  phraseS3,
  ARCHETYPES,
  ARCHETYPE_DEFAUT,
  FAMILLES_RENDU,
  MAX_CHROME_3D,
  S2_MIN_MOTS,
  S2_MAX_MOTS,
} from '../../src/lib/engine/logo-director-v6'
import { BRIEFS_E3, motAttendu } from './briefs-e3'
import { CALIBRATION_DIR, CAP_EUR, spentEur } from './budget6'

const LOGO_DIR = resolve(import.meta.dir, '../../src/engine/exemplars/fivem/logo')
const SORTIE = join(CALIBRATION_DIR, '_pivot-idiome')
const REJEU = ['nox', 'vulcain', 'azure']
// Coûts constatés (passation §2) : 1 appel DA ~0,03 €, 1 image 2K ~0,14 €,
// 1 appel flash (OCR / mesure) ~0,001 €.
const COUT = { da: 0.03, image: 0.14, flash: 0.001 }

const catalogue = listReferenceCatalogue('logo')
const fivem = fivemSlugs()
const gold = goldSlugs()
const horsCorpus = horsCorpusReferenceSlugs()

// ── 1. LE SET ────────────────────────────────────────────────────────────────

console.log('═══ LE CORPUS DE RÉFÉRENCES APRÈS LE PIVOT\n')
console.log(`Joignables (image présente, >= 512 px) : ${catalogue.length}`)
console.log(`Éligibles REFERENCE 1 (idiome FiveM)   : ${catalogue.filter((c) => c.fivem).length}`)
console.log(`Dans la barre (gold)                   : ${catalogue.filter((c) => c.gold).length}`)
console.log(`Sortis du corpus de références         : ${horsCorpus.size} (${[...horsCorpus].join(', ')})\n`)

const parFamille = new Map<string, typeof catalogue>()
for (const c of catalogue.filter((x) => x.fivem)) {
  const f = c.famille_rendu ?? '(non classé)'
  parFamille.set(f, [...(parFamille.get(f) ?? []), c])
}
for (const famille of FAMILLES_RENDU) {
  const lot = parFamille.get(famille) ?? []
  console.log(`── ${famille} (${lot.length})`)
  for (const c of lot) {
    console.log(`   ${c.gold ? '★' : ' '} ${c.slug.padEnd(34)} ${c.construction ?? ''}`)
  }
}
const horsIdiome = catalogue.filter((c) => !c.fivem)
console.log(`\n── joignables mais HORS idiome — slots 2 et 3 seulement (${horsIdiome.length})`)
console.log(`   ${horsIdiome.map((c) => c.slug).join(', ')}\n`)

// ── 2. CE QUI PART RÉELLEMENT AU MODÈLE ─────────────────────────────────────

console.log('═══ LE SQUELETTE DES PROMPTS — S1 et S3 sont écrites PAR LE CODE\n')
console.log(`Archétype par défaut : ${ARCHETYPE_DEFAUT}   ·   rotation : ${ARCHETYPES.join(' / ')}`)
console.log(`Familles de rendu    : ${FAMILLES_RENDU.join(' / ')}   ·   chrome_3d <= ${MAX_CHROME_3D}/3`)
console.log(`S2 (la seule phrase écrite par le DA) : ${S2_MIN_MOTS}-${S2_MAX_MOTS} mots\n`)

for (const id of REJEU) {
  const b = BRIEFS_E3.find((x) => x.id === id)
  if (!b) continue
  const mot = motAttendu(b)
  console.log(`── ${id} (${b.project.name}${mot ? `, mot « ${mot} »` : ', sans lettrage'})`)
  console.log(`   S1  ${phraseS1(mot)}`)
  console.log(`   S2  <${S2_MIN_MOTS}-${S2_MAX_MOTS} mots — écrits par le DA, non générés ici : c'est un appel payant>`)
  console.log(`   S3  ${phraseS3(mot)}\n`)
}

// ── 3. LE COÛT ───────────────────────────────────────────────────────────────

const avecLettrage = REJEU.filter((id) => motAttendu(BRIEFS_E3.find((b) => b.id === id)!) !== null).length
const coutConcepts = REJEU.length * COUT.da
const coutImages = REJEU.length * COUT.image
const coutPortes = avecLettrage * COUT.flash * 2.5 // OCR + mesure, jusqu'à 3 essais
const total = coutConcepts + coutImages + coutPortes

console.log('═══ LE COÛT ESTIMÉ DU REJEU (nox, vulcain, azure)\n')
console.log(`Phase 1 — concepts (3 appels DA)        ${coutConcepts.toFixed(4)} €`)
console.log(`Phase 2 — rendus (3 images 2K)          ${coutImages.toFixed(4)} €`)
console.log(`Portes OCR + mesure (flash)             ${coutPortes.toFixed(4)} €`)
console.log(`                                        ─────────`)
console.log(`TOTAL estimé                            ${total.toFixed(4)} €`)
console.log(`\nGrand livre session 6 : ${spentEur().toFixed(4)} € / ${CAP_EUR.toFixed(2)} €`)
console.log(`Reste après le rejeu  : ${(CAP_EUR - spentEur() - total).toFixed(4)} €`)
console.log(
  `\n⚠ Risque de dépassement : la porte OCR peut redemander une image (2 rejets max).\n` +
    `   Pire cas à 3 images pour un brief : +${(2 * COUT.image).toFixed(2)} € par brief concerné.\n` +
    `   Sur E3, seul « blackwood » (9 lettres) l'a déclenché ; NOX en fait 3 et Vulcain n'a aucun texte.`
)

// ── 4. LA PLANCHE ────────────────────────────────────────────────────────────

if (!process.argv.includes('--planche')) {
  console.log('\n(ajouter --planche pour produire la planche de contrôle JPG)')
  process.exit(0)
}

const CELL = 320
const CAPTION = 46
const HEADER = 52
const GAP = 8
const COLS = 5

function svgTexte(largeur: number, hauteur: number, texte: string, taille: number, fond: string): Buffer {
  const echappe = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const coupe = Math.ceil(texte.length / (texte.length > 40 ? 2 : 1))
  const morceaux = texte.length > 40 ? [texte.slice(0, coupe), texte.slice(coupe)] : [texte]
  const lignes = morceaux
    .map(
      (m, i) =>
        `<text x="10" y="${Math.round(hauteur * (morceaux.length === 1 ? 0.66 : 0.42 + i * 0.42))}" font-family="Arial" font-size="${taille}" fill="#ffffff">${echappe(m)}</text>`
    )
    .join('')
  return Buffer.from(`<svg width="${largeur}" height="${hauteur}"><rect width="${largeur}" height="${hauteur}" fill="${fond}"/>${lignes}</svg>`)
}

type Bloc = { entete: string; couleur: string; cellules: Array<{ slug: string; titre: string }> }

const blocs: Bloc[] = [
  ...FAMILLES_RENDU.map((famille) => ({
    entete: `IDIOME · ${famille} — éligible REFERENCE 1`,
    couleur: '#16301f',
    cellules: (parFamille.get(famille) ?? []).map((c) => ({
      slug: c.slug,
      titre: `${c.gold ? '★ ' : ''}${c.slug} · ${c.construction ?? ''}`,
    })),
  })).filter((b) => b.cellules.length),
  {
    entete: 'HORS IDIOME — joignable en slot 2 ou 3 seulement',
    couleur: '#3a2f14',
    cellules: horsIdiome.map((c) => ({ slug: c.slug, titre: `${c.gold ? '★ ' : ''}${c.slug}` })),
  },
  {
    entete: 'SORTIES DU CORPUS DE RÉFÉRENCES — plus jamais jointes, quel que soit le slot',
    couleur: '#3a1616',
    cellules: [...horsCorpus].map((slug) => ({ slug, titre: slug })),
  },
]

const composites: OverlayOptions[] = []
let y = GAP
let manquantes = 0
const rangeesParBloc = blocs.map((b) => Math.max(1, Math.ceil(b.cellules.length / COLS)))
const hauteur = blocs.reduce((h, _, i) => h + HEADER + rangeesParBloc[i]! * (CELL + CAPTION + GAP) + GAP, GAP)
const largeur = COLS * CELL + (COLS + 1) * GAP

for (const [bi, bloc] of blocs.entries()) {
  composites.push({ input: svgTexte(largeur - 2 * GAP, HEADER - 8, bloc.entete, 24, bloc.couleur), left: GAP, top: y })
  let yCell = y + HEADER
  for (const [i, cell] of bloc.cellules.entries()) {
    const col = i % COLS
    if (i > 0 && col === 0) yCell += CELL + CAPTION + GAP
    const x = GAP + col * (CELL + GAP)
    const chemin = join(LOGO_DIR, `${cell.slug}.jpg`)
    if (existsSync(chemin)) {
      const img = await sharp(readFileSync(chemin)).resize(CELL, CELL, { fit: 'contain', background: '#0b0e14' }).png().toBuffer()
      composites.push({ input: img, left: x, top: yCell })
    } else {
      composites.push({ input: svgTexte(CELL, CELL, `MANQUANT : ${cell.slug}`, 18, '#3a1d1d'), left: x, top: yCell })
      manquantes += 1
    }
    composites.push({ input: svgTexte(CELL, CAPTION, cell.titre, 16, '#111'), left: x, top: yCell + CELL })
  }
  y += HEADER + rangeesParBloc[bi]! * (CELL + CAPTION + GAP) + GAP
}

mkdirSync(SORTIE, { recursive: true })
const chemin = join(SORTIE, 'planche-idiome.jpg')
await sharp({ create: { width: largeur, height: hauteur, channels: 3, background: '#05070b' } })
  .composite(composites)
  .jpeg({ quality: 88 })
  .toFile(chemin)
console.log(`\nPlanche : ${chemin} (${largeur}×${hauteur})${manquantes ? ` — ${manquantes} manquante(s)` : ''}`)
