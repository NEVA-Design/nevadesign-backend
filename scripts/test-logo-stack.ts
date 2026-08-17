/**
 * Run 5.7 — smoke test LOCAL de la pile de calques (zéro appel API).
 * Fond factice (dégradé sharp), emblème factice (disque alpha), recette
 * Fruitz : vérifie assemblage, dérivation alpha, déclinaisons monochromes,
 * et la validation de recette (bornes PSD).
 * Usage : bun scripts/test-logo-stack.ts <dossier-sortie>
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { assembleLogo, declineMonochrome, spellOut, validateCalquesRecette, type LogoCalquesRecette } from '../src/lib/engine/logo-stack'

const OUT = process.argv[2] ?? '.'
let echecs = 0
const check = (nom: string, ok: boolean, detail = '') => {
  if (!ok) echecs++
  console.log(`${ok ? 'PASS' : 'ÉCHEC'}  ${nom}${detail ? ` — ${detail}` : ''}`)
}

// ── 0. épellation : un nom en plusieurs mots ne fabrique pas de tiret isolé ──
check('spellOut : mot simple', spellOut('Fruitz') === 'F-R-U-I-T-Z', spellOut('Fruitz'))
check('spellOut : nom en deux mots', spellOut('Northside RP') === 'N-O-R-T-H-S-I-D-E R-P', spellOut('Northside RP'))
check('spellOut : espaces multiples absorbés', spellOut('  NOX   RP ') === 'N-O-X R-P', spellOut('  NOX   RP '))

// ── 1. validation de recette : bornes PSD appliquées ──
const bonne: LogoCalquesRecette = {
  disposition: 'pile',
  lockup: {
    description:
      'The word FRUITZ in heavy custom italic letterforms with sharp angular cuts, the letter I replaced by a juicy citrus wedge slicing through the baseline, deep matte extrusion with satin faces and one polished chrome bevel accent along the top edges',
    echelle: 0.66,
  },
  lettrage: {
    texte: 'FRUITZ',
    police: 'Anton',
    gradient: { stops: [{ color: '#FF6B4A', location: 0 }, { color: '#FFC4A3', location: 1 }], angle: 90 },
    contour: { taillePx: 4, couleur: '#ffffff', position: 'outside' },
    glow: { taillePx: 10, couleur: '#FF6B4A', opacite: 0.5 },
  },
  embleme: { description: 'a juicy citrus slice with 3 wedges, flat premium style', echelle: 0.45 },
  fond: { famille: 'combinaison', description: 'deep coral-to-night gradient, faint halftone field 12%, palm silhouettes 10%' },
}
const v1 = validateCalquesRecette(bonne, { attenduTexte: 'FRUITZ' })
check('recette valide acceptée', 'recette' in v1, 'errors' in v1 ? v1.errors.join(' ; ') : '')

// Run 5.8 : le lockup fusionné est obligatoire dès que le brief a un lettrage
const sansLockup = { ...bonne, lockup: undefined }
check('recette sans lockup rejetée (brief avec lettrage)', 'errors' in validateCalquesRecette(sansLockup, { attenduTexte: 'FRUITZ' }))
const lockupVague = { ...bonne, lockup: { description: 'a nice fruity logo with the word FRUITZ and a happy summery vibe, colorful and fun and juicy and bright' } }
check('lockup sans vocabulaire typo rejeté', 'errors' in validateCalquesRecette(lockupVague, { attenduTexte: 'FRUITZ' }))

const contourHorsPsd = { ...bonne, lettrage: { ...bonne.lettrage!, contour: { taillePx: 14, couleur: '#000000' } } }
const v2 = validateCalquesRecette(contourHorsPsd, { attenduTexte: 'FRUITZ' })
check('contour 14px (signature 2015) rejeté', 'errors' in v2, 'errors' in v2 ? v2.errors[0] : '')

const mauvaisTexte = { ...bonne, lettrage: { ...bonne.lettrage!, texte: 'FRUTZ' } }
check('texte mal épelé rejeté', 'errors' in validateCalquesRecette(mauvaisTexte, { attenduTexte: 'FRUITZ' }))

const policeInconnue = { ...bonne, lettrage: { ...bonne.lettrage!, police: 'Comic Sans MS' } }
check('police hors catalogue rejetée', 'errors' in validateCalquesRecette(policeInconnue, { attenduTexte: 'FRUITZ' }))

// ── 2. assemblage complet ──
const S = 1024
const fondPng = await sharp(
  Buffer.from(
    `<svg width="${S}" height="${S}"><defs><linearGradient id="g" x1="0" y1="1" x2="0.6" y2="0">` +
      `<stop offset="0" stop-color="#1a0e14"/><stop offset="0.6" stop-color="#57202b"/><stop offset="1" stop-color="#93402f"/></linearGradient></defs>` +
      `<rect width="${S}" height="${S}" fill="url(#g)"/></svg>`
  )
).png().toBuffer()
const emblemePng = await sharp(
  Buffer.from(
    `<svg width="600" height="600"><circle cx="300" cy="300" r="260" fill="#FF6B4A"/><circle cx="300" cy="300" r="200" fill="#FFC4A3"/>` +
      `<path d="M300 100 L300 500 M100 300 L500 300" stroke="#FF6B4A" stroke-width="40"/></svg>`
  )
).png().toBuffer()

const stack = await assembleLogo({ fondPng, emblemePng, recette: bonne, taille: S })
writeFileSync(join(OUT, 'stack-master.png'), stack.master)
writeFileSync(join(OUT, 'stack-alpha.png'), stack.alpha)

const masterStats = await sharp(stack.master).stats()
check('master opaque plein cadre', (masterStats.channels[3]?.mean ?? 0) > 250)
const alphaStats = await sharp(stack.alpha).stats()
const alphaMean = alphaStats.channels[3]?.mean ?? 0
check('alpha transparent hors marque', alphaMean > 5 && alphaMean < 200, `alpha-mean=${alphaMean.toFixed(1)}`)

const blanc = await declineMonochrome(stack.alpha, 'white')
writeFileSync(join(OUT, 'stack-blanc.png'), blanc)
const blancStats = await sharp(blanc).stats()
check('déclinaison blanche : RGB=255, alpha conservé', (blancStats.channels[0]?.mean ?? 0) > 250)

// ── 3. lettrage seul (sans fond ni emblème) ──
const seul = await assembleLogo({ recette: { ...bonne, disposition: 'lettrage_seul' }, taille: S })
writeFileSync(join(OUT, 'stack-lettrage-seul.png'), seul.master)
check('lettrage_seul rend', seul.master.length > 1000)

// ── 4. run 5.8 : mode lockup fusionné — le lockup détouré remplace emblème+lettrage ──
const lockupPng = await sharp(
  Buffer.from(
    `<svg width="700" height="380"><rect x="20" y="80" width="660" height="220" rx="24" fill="#FF6B4A"/>` +
      `<circle cx="350" cy="190" r="150" fill="#FFC4A3"/></svg>`
  )
).png().toBuffer()
const stackLockup = await assembleLogo({ fondPng, lockupPng, recette: bonne, taille: S })
writeFileSync(join(OUT, 'stack-lockup.png'), stackLockup.master)
const lockupMasterStats = await sharp(stackLockup.master).stats()
check('lockup : master opaque plein cadre', (lockupMasterStats.channels[3]?.mean ?? 0) > 250)
const lockupAlphaStats = await sharp(stackLockup.alpha).stats()
const lockupAlphaMean = lockupAlphaStats.channels[3]?.mean ?? 0
check('lockup : alpha = le lockup seul', lockupAlphaMean > 5 && lockupAlphaMean < 200, `alpha-mean=${lockupAlphaMean.toFixed(1)}`)

console.log(echecs ? `\n${echecs} ÉCHEC(S)` : '\nTous les tests passent')
process.exit(echecs ? 1 : 0)
