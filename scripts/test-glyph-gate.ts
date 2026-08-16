/**
 * Run 5.9, chantier 2 — tests des deux fonctions pures neuves de la mesure :
 *   1. glyphDecision : la porte glyphe à glyphe du lockup. Non-régression du
 *      checkpoint 5.8 rejeté : « FRU VTZ » (iter11), « FPÛiTZ » (iter12) et
 *      toute lecture de mot top-down doivent rejeter.
 *   2. decideRegen : la décision de régénération ciblée. Non-régression des
 *      deux bugs 5.8 : ok=false sans régénération, et « wheat ear motif »
 *      envoyé sur le calque FOND par la regex.
 * Zéro appel API. Usage : bun scripts/test-glyph-gate.ts
 */
import { glyphDecision } from '../src/lib/engine/ocr-gate'
import { decideRegen } from '../src/lib/engine/logo-pipeline'
import { demandeInterdite, detecteFrancais } from '../src/lib/engine/logo-stack'

let echecs = 0
const verif = (nom: string, obtenu: unknown, attendu: unknown) => {
  const ok = JSON.stringify(obtenu) === JSON.stringify(attendu)
  if (!ok) {
    echecs++
    console.error(`✗ ${nom} — obtenu ${JSON.stringify(obtenu)}, attendu ${JSON.stringify(attendu)}`)
  } else {
    console.log(`✓ ${nom}`)
  }
}

// ── 1. glyphDecision ─────────────────────────────────────────────────────────
verif('glyphes exacts', glyphDecision(['F', 'R', 'U', 'I', 'T', 'Z'], 'FRUITZ').ok, true)
verif('casse ignorée', glyphDecision(['f', 'r', 'u', 'i', 't', 'z'], 'FRUITZ').ok, true)
// iter11-58 : « FRU VTZ » — six formes mais le I avalé se lit V
verif('iter11 : U avalé lu V', glyphDecision(['F', 'R', 'U', 'V', 'T', 'Z'], 'FRUITZ').ok, false)
// iter12-58 : R déformé en P + i minuscule à point (i normalisé I : passe la
// casse, mais le R→P doit rejeter)
verif('iter12 : R lu P', glyphDecision(['F', 'P', 'U', 'I', 'T', 'Z'], 'FRUITZ').ok, false)
// glyphe malformé transcrit « ? »
verif('glyphe malformé (?)', glyphDecision(['F', 'R', '?', 'I', 'T', 'Z'], 'FRUITZ').ok, false)
// glyphe manquant (goutte qui avale le U et le I → 5 formes)
verif('glyphe manquant', glyphDecision(['F', 'R', 'U', 'T', 'Z'], 'FRUITZ').ok, false)
// glyphe doublé
verif('glyphe doublé', glyphDecision(['F', 'R', 'U', 'I', 'I', 'T', 'Z'], 'FRUITZ').ok, false)
// transcription multi-caractères par entrée = ambigu = ?
verif('entrée multi-caractères = ambigu', glyphDecision(['FR', 'U', 'I', 'T', 'Z'], 'FRUITZ').ok, false)
// rien transcrit
verif('aucun glyphe', glyphDecision([], 'FRUITZ').ok, false)

// ── 2. decideRegen ───────────────────────────────────────────────────────────
const ctxLockup = { lockupMode: true, hasFond: true, hasEmbleme: false }

// verdict ok → aucune régénération
verif('ok → null', decideRegen({ ok: true, calqueFautif: null, defauts: [] }, ctxLockup), null)

// LE BUG iter10b-58 : ok=false, calque fautif structuré « fond » → fond régénéré
verif(
  'iter10b : fond fautif structuré',
  decideRegen({ ok: false, calqueFautif: 'fond', defauts: ['deepen the dark base of the background'] }, ctxLockup),
  'fond'
)

// LE BUG iter11-58 : « wheat ear motif » — la regex 5.8 ciblait le FOND à
// cause du mot « motif ». Sans calque structuré, le secours doit viser le
// lockup (défaut d'emblème).
verif(
  'iter11 : wheat ear motif → lockup (pas fond)',
  decideRegen(
    { ok: false, calqueFautif: null, defauts: ['replace the wheat ear motif with a tropical fruit or summer element to align with the theme'] },
    ctxLockup
  ),
  'lockup'
)

// calque structuré prioritaire sur la regex
verif(
  'structuré prioritaire',
  decideRegen({ ok: false, calqueFautif: 'lockup', defauts: ['deepen the dark base of the background'] }, ctxLockup),
  'lockup'
)

// ok=false SANS défaut nommé mais avec calque fautif → régénère quand même
// (le 5.8 exigeait defauts.length : un verdict structuré muet ne déclenchait rien)
verif('fautif sans défauts nommés', decideRegen({ ok: false, calqueFautif: 'lockup', defauts: [] }, ctxLockup), 'lockup')

// cible indisponible (fallback emblème absent, pas de lockup) → null
verif(
  'cible indisponible',
  decideRegen({ ok: false, calqueFautif: 'lockup', defauts: [] }, { lockupMode: false, hasFond: true, hasEmbleme: false }),
  null
)

// mode emblème (fallback) : défaut de marque cible l'emblème
verif(
  'fallback : marque → embleme',
  decideRegen(
    { ok: false, calqueFautif: null, defauts: ['the emblem looks like a generic mascot'] },
    { lockupMode: false, hasFond: true, hasEmbleme: true }
  ),
  'embleme'
)

// ── 3. demandeInterdite (chantier 4) ─────────────────────────────────────────
// iter10b-58 : le DA demandait lui-même le contour blanc épais (en français)
verif('iter10b : contour blanc épais FR', demandeInterdite('Mot-symbole FRUITZ en italique lourd, contour blanc épais') !== null, true)
// demande anglaise du sticker : rejetée
verif('sticker border EN', demandeInterdite('a thick white outline around the whole lockup') !== null, true)
// candy demandé : rejeté
verif('candy demandé', demandeInterdite('letters coated in a uniform candy gloss finish') !== null, true)
// NÉGATIONS légitimes (le DA répète la material law) : tolérées
verif('négation candy tolérée', demandeInterdite('satin fills, never a uniform candy coating or gel gloss') === null, true)
verif('négation sticker tolérée', demandeInterdite('custom letterforms, no thick border around the whole lockup, each letter outlined separately') === null, true)
// contour par lettre légitime : toléré
verif('outline per-letter toléré', demandeInterdite('a clean thick outline hugging each letterform’s own silhouette') === null, true)

// ── 4. detecteFrancais (chantier 4) ──────────────────────────────────────────
verif('description FR détectée', detecteFrancais('Lettrage FRUITZ massif et angulaire. Une feuille de palmier géométrique.'), true)
verif('description EN propre', detecteFrancais('Massive angular FRUITZ lettering. A sharp geometric palm leaf replaces the F bar.'), false)

if (echecs) {
  console.error(`\n${echecs} échec(s)`)
  process.exit(1)
}
console.log('\nTous les cas passent.')
