/*
 * Run 6 (§5) — LA PREUVE que le blockout est une contrainte exécutable.
 * Zéro appel API : on teste le validateur (le plancher d'overlap par
 * archétype, la forme), la MESURE DE DÉBORDEMENT du patch P2, et on DESSINE
 * les six formes pour les regarder — un squelette de composition ne se valide
 * pas sur parole.
 *
 * PATCH P2/P3 — ce que ce fichier prouve en plus depuis E1 :
 *   - les quatre formes « mot posé sur une plaque » sont recalées par le
 *     débordement, alors que leur overlap de bbox est au maximum (≈ 1,00) ;
 *   - les six gabarits livrés tiennent le contrat complet
 *     (overlap >= 0,35 ET 0,05 <= débordement <= 0,35) ;
 *   - la police n'est plus une variable : elle ne figure plus dans la spec.
 *
 *   bun run scripts/test-blockout.ts
 *   → captures/calibration/_blockout-v6/*.png
 */

import { mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import {
  validateBlockout,
  renderBlockout,
  mesureBlockout,
  verifieContratBlockout,
  plancherOverlap,
  policeBlockoutDisponible,
  BLOCKOUT_FONT,
  BLOCKOUT_SHAPES,
  FORMES_EVIDEES_PAR_P2,
  emblemeSvg,
  emblemeSilhouetteSvg,
  type BlockoutShape,
  type BlockoutSpec,
} from '../src/lib/engine/logo-blockout'
import { overlapRatio, DEBORDEMENT_MIN, DEBORDEMENT_MAX } from '../src/lib/engine/overlap'

const SORTIE = resolve(import.meta.dir, '../../captures/calibration/_blockout-v6')
const MOT = 'FRUITZ'

let failures = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`}`)
  if (!ok) failures += 1
}

// ── 1. le validateur ─────────────────────────────────────────────────────────

// CONTENANT conforme : la tranche englobe le lettrage (overlap 1).
const contenant = {
  emblem_shape: 'circle' as const,
  emblem_bbox: [0.14, 0.14, 0.72, 0.72],
  word_bbox: [0.26, 0.44, 0.48, 0.13],
}
const vContenant = validateBlockout(contenant, { archetype: 'CONTAINER' })
check('CONTENANT conforme : accepté', 'spec' in vContenant, true)
check('CONTENANT : overlap 1', overlapRatio(contenant.emblem_bbox as never, contenant.word_bbox as never), 1)

// Le même blockout mais l'emblème posé À CÔTÉ — la faute des rendus rejetés.
const pose = { ...contenant, emblem_bbox: [0.7, 0.2, 0.18, 0.18] }
const vPose = validateBlockout(pose, { archetype: 'CONTAINER' })
check('emblème posé à côté : REJETÉ en CONTAINER', 'errors' in vPose, true)
if ('errors' in vPose) {
  check(
    'le message cite le ratio et le plancher',
    /overlap ratio is 0\.00 but CONTAINER requires at least 0\.35/.test(vPose.errors.join(' ')),
    true
  )
}

// ENTWINED : une bande qui traverse le mot, 0,46 — au-dessus du plancher 0,35.
const enlace = {
  emblem_shape: 'arc_band' as const,
  emblem_bbox: [0.1, 0.42, 0.8, 0.06],
  word_bbox: [0.2, 0.4, 0.6, 0.13],
}
const vEnlace = validateBlockout(enlace, { archetype: 'ENTWINED' })
check('ENTWINED traversant : accepté', 'spec' in vEnlace, true)

// Le plancher est plus bas pour les autres archétypes (0,20).
check('plancher CONTAINER', plancherOverlap('CONTAINER'), 0.35)
check('plancher ENTWINED', plancherOverlap('ENTWINED'), 0.35)
check('plancher CREST', plancherOverlap('CREST'), 0.2)
check('plancher SCENE', plancherOverlap('SCENE'), 0.2)

const tangent = {
  emblem_shape: 'shield' as const,
  emblem_bbox: [0.25, 0.3, 0.5, 0.16],
  word_bbox: [0.25, 0.42, 0.5, 0.12],
}
const ratioTangent = overlapRatio(tangent.emblem_bbox as never, tangent.word_bbox as never)
check('même blockout : rejeté en CONTAINER, accepté en CREST', [
  'errors' in validateBlockout(tangent, { archetype: 'CONTAINER' }),
  'spec' in validateBlockout(tangent, { archetype: 'CREST' }),
], [true, true])
check('ratio du cas tangent entre les deux planchers', ratioTangent >= 0.2 && ratioTangent < 0.35, true)

// Forme inconnue, bbox absurde, blockout manquant.
check('forme inconnue : rejetée', 'errors' in validateBlockout({ ...contenant, emblem_shape: 'blob' }, { archetype: 'CONTAINER' }), true)
check('bbox dégénérée : rejetée', 'errors' in validateBlockout({ ...contenant, word_bbox: [0.3, 0.4, 0, 0.1] }, { archetype: 'CONTAINER' }), true)
check('blockout absent : rejeté', 'errors' in validateBlockout(null, { archetype: 'CONTAINER' }), true)

// ── 1bis. P3 — la police n'est plus une variable ─────────────────────────────
check('P3 : la police du blockout est embarquée', policeBlockoutDisponible(), true)
check('P3 : la police est une constante, pas une entrée du DA', BLOCKOUT_FONT, 'Archivo Black')
// une police proposée par le modèle est simplement IGNORÉE (plus de champ)
const avecPoliceParasite = validateBlockout({ ...contenant, word_font: 'Great Vibes' }, { archetype: 'CONTAINER' })
check('P3 : un word_font résiduel n\'entre pas dans la spec', 'spec' in avecPoliceParasite && !('word_font' in avecPoliceParasite.spec), true)

// ── 1ter. P2 — les formes pleines sont évidées, la silhouette reste pleine ───
check('P2 : circle, polygon et shield sont les formes évidées', [...FORMES_EVIDEES_PAR_P2].sort(), ['circle', 'polygon', 'shield'])
check('P2 : le cercle dessiné porte un masque (anneau)', emblemeSvg('circle', [0.1, 0.1, 0.8, 0.8]).includes('<mask'), true)
check('P2 : sa silhouette de mesure reste pleine', emblemeSilhouetteSvg('circle', [0.1, 0.1, 0.8, 0.8]).includes('<mask'), false)

// ── 2. P2 — le débordement recale le badge que l'overlap adore ───────────────
// Le cas exact dénoncé par le patch : mot entièrement posé sur une plaque
// pleine. L'overlap de bbox est au MAXIMUM, et la construction est celle du
// sticker. Une mesure seule ne suffit pas ; il en faut une seconde qui borne.
const badge: BlockoutSpec = {
  emblem_shape: 'circle',
  emblem_bbox: [0.14, 0.14, 0.72, 0.72],
  word_bbox: [0.26, 0.44, 0.48, 0.13],
}
const mBadge = await mesureBlockout(badge, MOT, 'CONTAINER')
check('badge : overlap de bbox au maximum', mBadge.overlapBbox, 1)
check('badge : débordement nul → verdict badge', mBadge.contrat.debordement, 'badge')
check('badge : contrat de composition REFUSÉ', mBadge.contrat.ok, false)
const cBadge = await verifieContratBlockout(badge, MOT, 'CONTAINER')
check('badge : le message nomme la plaque et donne la cible', /badge, a word laid on a plate/.test(cBadge.errors.join(' ')), true)

// Le mot posé à côté : l'autre bout du contrat.
const aCote: BlockoutSpec = { emblem_shape: 'circle', emblem_bbox: [0.62, 0.1, 0.3, 0.3], word_bbox: [0.06, 0.5, 0.5, 0.14] }
const mACote = await mesureBlockout(aCote, MOT, 'CONTAINER')
check('posé à côté : débordement total → pose_a_cote', mACote.contrat.debordement, 'pose_a_cote')
check('posé à côté : contrat REFUSÉ', mACote.contrat.ok, false)

// Le débordement ne s'applique qu'aux contenants — un CREST n'est pas jugé
// dessus (patch P2 : le contrat des deux bouts vise CONTAINER / ENTWINED).
const mCrest = await mesureBlockout(badge, MOT, 'CREST')
check('CREST : débordement non applicable', mCrest.contrat.debordement, 'non_applicable')
check('CREST : le même blockout passe', mCrest.contrat.ok, true)

// ── 3. le dessin — les six formes, à regarder ────────────────────────────────
// Gabarits P2 : sur CHAQUE forme fermée, le lettrage franchit le contour de
// l'emblème. Les formes pleines sont évidées en anneau/cadre ET le mot sort de
// la silhouette — les deux branches de la règle 2, pas une seule.
const GABARITS: Record<BlockoutShape, { emblem: number[]; word: number[] }> = {
  circle: { emblem: [0.12, 0.12, 0.76, 0.76], word: [0.06, 0.42, 0.88, 0.16] },
  crescent: { emblem: [0.1, 0.12, 0.78, 0.78], word: [0.04, 0.43, 0.88, 0.15] },
  arc_band: { emblem: [0.08, 0.16, 0.84, 0.68], word: [0.03, 0.42, 0.94, 0.16] },
  shield: { emblem: [0.22, 0.1, 0.56, 0.8], word: [0.12, 0.4, 0.76, 0.13] },
  wedge: { emblem: [0.16, 0.16, 0.68, 0.68], word: [0.18, 0.42, 0.64, 0.14] },
  polygon: { emblem: [0.15, 0.15, 0.7, 0.7], word: [0.12, 0.43, 0.76, 0.13] },
}

async function dessine() {
  mkdirSync(SORTIE, { recursive: true })
  for (const shape of BLOCKOUT_SHAPES) {
    const g = GABARITS[shape]
    const verdict = validateBlockout(
      { emblem_shape: shape, emblem_bbox: g.emblem, word_bbox: g.word },
      { archetype: 'CONTAINER' }
    )
    if ('errors' in verdict) {
      console.log(`✗ gabarit ${shape} invalide : ${verdict.errors.join(' ; ')}`)
      failures += 1
      continue
    }
    const mesure = await mesureBlockout(verdict.spec, MOT, 'CONTAINER')
    const png = await renderBlockout(verdict.spec, MOT)
    const chemin = join(SORTIE, `blockout-${shape}.png`)
    writeFileSync(chemin, png)
    const conforme = mesure.contrat.ok
    if (!conforme) failures += 1
    console.log(
      `${conforme ? '✓' : '✗'} ${shape.padEnd(10)} overlap ${mesure.overlapBbox.toFixed(2)} · débordement ${mesure.debordement.toFixed(
        2
      )} (${mesure.contrat.debordement}) → ${chemin}`
    )
    if (!conforme) console.log(`    ${mesure.contrat.raisons.join(' ; ')}`)
  }
}

await dessine()

console.log(
  `\nContrat P2 pour CONTAINER/ENTWINED : overlap >= 0,35 ET ${DEBORDEMENT_MIN} <= débordement <= ${DEBORDEMENT_MAX}`
)
console.log(failures ? `\n${failures} test(s) en échec` : '\nTous les tests du blockout passent')
process.exit(failures ? 1 : 0)
