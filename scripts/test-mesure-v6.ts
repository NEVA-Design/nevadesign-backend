/*
 * Run 6 — LA PREUVE que la mesure v6 décide en CODE, avant de payer.
 * Piège n°8 de la passation appliqué à la lettre : calibrer l'instrument
 * avant de mesurer. Ici, zéro appel API — on teste la géométrie pure et les
 * deux barèmes :
 *   1. overlapRatio / decideOverlap (§7.1) — la part du LETTRAGE couverte
 *      par l'emblème, et les seuils 0,30 / 0,20 ;
 *   2. normaliseBbox — les trois conventions de coordonnées que Gemini
 *      renvoie selon son humeur (0..1, 0..1000, pixels) ;
 *   3. decideDuel (§7.2) — le barème >= 4/8 barre, <= 2/8 rejet.
 *
 *   bun run scripts/test-mesure-v6.ts
 */

import {
  overlapRatio,
  decideOverlap,
  decideOverlapPourArchetype,
  decideDebordement,
  contratComposition,
  normaliseBbox,
  parseBox2d,
  decideDuel,
  intersection,
  aire,
  seuilOverlap,
  tauxDebordement,
  OVERLAP_ELIMINATOIRE,
  type Bbox,
  type Masque,
} from './calibration/mesure-v6'

let failures = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`}`)
  if (!ok) failures += 1
}

// Le lettrage de référence : une bande centrale, 40 % de large, 10 % de haut.
const motCentre: Bbox = [0.3, 0.45, 0.4, 0.1]

// ── 1. géométrie pure — les archétypes du §2, chiffrés ───────────────────────

// CONTENANT : une grande tranche d'agrume qui englobe le lettrage (la
// construction des deux gagnants du plafond — le lettrage vit DANS l'emblème).
const emblemeContenant: Bbox = [0.15, 0.15, 0.7, 0.7]
check("contenant : le mot est entièrement dans l'emblème → 1", overlapRatio(emblemeContenant, motCentre), 1)
check('contenant : verdict passage', decideOverlap(overlapRatio(emblemeContenant, motCentre)), 'passage')

// POSÉ À CÔTÉ : la petite tranche perchée sur le Z, hors du corps du mot —
// c'est la composition des rendus rejetés (mesurée ~0,05 à 0,15).
const emblemePose: Bbox = [0.68, 0.38, 0.12, 0.12]
const ratioPose = overlapRatio(emblemePose, motCentre)
check('posé à côté : overlap sous le seuil éliminatoire', ratioPose < OVERLAP_ELIMINATOIRE, true)
check('posé à côté : verdict éliminatoire', decideOverlap(ratioPose), 'eliminatoire')

// ENLACEMENT : une bande qui traverse le lettrage — passe la barre sans
// contenir le mot.
const emblemeEnlace: Bbox = [0.2, 0.45, 0.6, 0.06]
check('enlacement : couvre 60 % de la hauteur du mot → 0,6', overlapRatio(emblemeEnlace, motCentre), 0.6)
check('enlacement : verdict passage', decideOverlap(overlapRatio(emblemeEnlace, motCentre)), 'passage')

// Zone grise entre les deux seuils : ni passage, ni éliminatoire.
const emblemeTangent: Bbox = [0.3, 0.42, 0.4, 0.055]
check('zone grise : entre 0,20 et 0,30 → sous_barre', decideOverlap(overlapRatio(emblemeTangent, motCentre)), 'sous_barre')

// Aucun emblème (lettrage nu) : overlap 0, éliminatoire.
check("lettrage seul : pas d'emblème → 0", overlapRatio(null, motCentre), 0)
check('lettrage seul : verdict éliminatoire', decideOverlap(overlapRatio(null, motCentre)), 'eliminatoire')
check('mot introuvable : dénominateur nul → 0, jamais NaN', overlapRatio(emblemeContenant, null), 0)
check('bbox dégénérée : aire nulle → 0, jamais Infinity', overlapRatio(emblemeContenant, [0.5, 0.5, 0, 0]), 0)

check('disjointes : intersection nulle (pas de largeur négative)', intersection([0, 0, 0.2, 0.2], [0.8, 0.8, 0.2, 0.2]), 0)
check('aire : produit simple', aire([0.1, 0.1, 0.5, 0.4]), 0.2)

// ── 2. normaliseBbox — les trois conventions de Gemini ───────────────────────
check('convention 0..1 : passe telle quelle', normaliseBbox([0.1, 0.2, 0.3, 0.4]), [0.1, 0.2, 0.3, 0.4])
check('convention 0..1000 : divisée par 1000', normaliseBbox([100, 200, 300, 400]), [0.1, 0.2, 0.3, 0.4])
check('convention pixels : divisée par le côté du canevas', normaliseBbox([1024, 512, 1024, 512], 1024), [1, 0.5, 1, 0.5])
check('null / absent → null', normaliseBbox(null), null)
check('longueur invalide → null', normaliseBbox([0.1, 0.2, 0.3]), null)
check('non numérique → null', normaliseBbox(['a', 'b', 'c', 'd']), null)
check('largeur nulle → null (jamais une bbox plate)', normaliseBbox([0.1, 0.2, 0, 0.4]), null)
check('origine bornée à 0..1', normaliseBbox([-0.2, 0.9, 0.5, 0.5]), [0, 0.9, 0.5, 0.5])

// ── 2bis. parseBox2d — le format natif de détection, contrat STRICT ──────────
// E1 a relevé que le modèle mélange les échelles dans un même tableau quand on
// lui demande [x,y,w,h] en 0..1 (vu : [0.199, 339, 0.365, 0.507]). Le format
// natif [ymin,xmin,ymax,xmax] en entiers 0-1000 est celui qu'il maîtrise, et
// tout ce qui sort du contrat est REFUSÉ (l'appelant rejoue) — jamais rattrapé
// par une heuristique.
check('box_2d : plein cadre', parseBox2d([0, 0, 1000, 1000]), [0, 0, 1, 1])
check('box_2d : ordre [ymin,xmin,ymax,xmax] respecté', parseBox2d([300, 100, 700, 900]), [0.1, 0.3, 0.8, 0.4])
check('box_2d : bande centrale', parseBox2d([450, 200, 550, 800]), [0.2, 0.45, 0.6, 0.1])
check('box_2d : ymax <= ymin → null', parseBox2d([700, 100, 300, 900]), null)
check('box_2d : xmax == xmin → null', parseBox2d([100, 500, 900, 500]), null)
check('box_2d : hors 0-1000 → null', parseBox2d([100, 200, 300, 1400]), null)
check('box_2d : négatif → null', parseBox2d([-10, 200, 300, 400]), null)
check('box_2d : échelles mélangées (le bug E1) → null', parseBox2d([0.199, 339, 0.365, 0.507]), null)
check('box_2d : boîte plus fine que 2 % → null', parseBox2d([500, 200, 505, 800]), null)
check('box_2d : longueur invalide → null', parseBox2d([100, 200, 300]), null)
check('box_2d : null → null', parseBox2d(null), null)

// le chevauchement se lit correctement dans le format natif : un emblème
// contenant (100..900) et un mot central (450..550 × 250..750) → overlap 1
check(
  'box_2d : emblème contenant → overlap 1',
  overlapRatio(parseBox2d([100, 100, 900, 900]), parseBox2d([450, 250, 550, 750])),
  1
)

// ── 2ter. PATCH P1 — les seuils sont PAR ARCHÉTYPE, jamais plats ─────────────
// Le seuil plat 0,30 / 0,20 appliqué pendant E1 recale FLASH MOOD (0,292),
// une pièce de la barre. Le tableau ci-dessous EST celui du patch, rejoué en
// code : chaque pièce gold contre le seuil de SON archétype.
check('seuil CONTAINER', seuilOverlap('CONTAINER'), 0.35)
check('seuil ENTWINED', seuilOverlap('ENTWINED'), 0.35)
check('seuil CREST', seuilOverlap('CREST'), 0.2)
check('seuil SCENE', seuilOverlap('SCENE'), 0.2)
check('HERO_MONOGRAM : aucun seuil, la mesure ne s\'applique pas', seuilOverlap('HERO_MONOGRAM'), null)
check('WORDMARK_PUR : ajouté par P1 — non applicable', seuilOverlap('WORDMARK_PUR'), null)
check('LOCKUP_EMPILE : ajouté par P1 — non applicable', seuilOverlap('LOCKUP_EMPILE'), null)

const verdictPour = (ratio: number, archetype: string) => decideOverlapPourArchetype(ratio, archetype).verdict
// le gold set, pièce par pièce (relevé E1)
check('gold wordmark Fruitz (CONTAINER, 1,000) → passage', verdictPour(1, 'CONTAINER'), 'passage')
check('gold badge ALYA (ENTWINED, 1,000) → passage', verdictPour(1, 'ENTWINED'), 'passage')
check('gold A + dauphin (ENTWINED, 0,488) → passage', verdictPour(0.488, 'ENTWINED'), 'passage')
check('gold R or fracturé (HERO_MONOGRAM, 0,000) → non applicable', verdictPour(0, 'HERO_MONOGRAM'), 'non_applicable')
check('gold script Sweety Life (WORDMARK_PUR, 0,000) → non applicable', verdictPour(0, 'WORDMARK_PUR'), 'non_applicable')
check('gold planche South District (LOCKUP_EMPILE, 0,000) → non applicable', verdictPour(0, 'LOCKUP_EMPILE'), 'non_applicable')
// ce que le seuil plat cassait : FLASH MOOD recalé par 0,30
check('gold FLASH MOOD (0,292) : recalé par le seuil PLAT', decideOverlap(0.292), 'sous_barre')
check('gold FLASH MOOD (0,292) : PASSE au seuil de son archétype', verdictPour(0.292, 'GLYPH_FUSION'), 'passage')

// LA CONSÉQUENCE DURE, encodée : sur GLYPH_FUSION, la mesure ne distingue pas
// une pièce gold d'un rendu rejeté par l'opérateur. C'est la preuve chiffrée
// qui sort cet archétype de la rotation (P1) — pas une préférence de style.
check(
  'GLYPH_FUSION : gold 0,292 et rejeté 0,217 rendent le MÊME verdict',
  [verdictPour(0.292, 'GLYPH_FUSION'), verdictPour(0.217, 'GLYPH_FUSION')],
  ['passage', 'passage']
)
// alors que sur CONTAINER, les mêmes rejetés tombent
check('CONTAINER : integ1 (0,217) sous la barre', verdictPour(0.217, 'CONTAINER'), 'sous_barre')
// la borne exacte : « éliminatoire = MOINS de la moitié du seuil ». integ3
// mesure 0,175, soit très exactement la moitié de 0,35 — il reste sous la
// barre sans être éliminé. Un point sur la frontière n'est pas recalé.
check('CONTAINER : integ3 (0,175) = pile la moitié → sous la barre', verdictPour(0.175, 'CONTAINER'), 'sous_barre')
check('CONTAINER : 0,174, sous la moitié → éliminatoire', verdictPour(0.174, 'CONTAINER'), 'eliminatoire')
check('CONTAINER : integ2 (0,097) éliminatoire', verdictPour(0.097, 'CONTAINER'), 'eliminatoire')
check('CONTAINER : les 2 gagnants du plafond passent', [verdictPour(0.982, 'CONTAINER'), verdictPour(0.715, 'CONTAINER')], ['passage', 'passage'])
check('archétype inconnu : rapporté sans verdict, jamais un seuil inventé', verdictPour(0.5, 'BADGE_MAISON'), 'non_applicable')

// ── 2quater. PATCH P2 — le taux de débordement ───────────────────────────────
// Masques de synthèse 10×10 : le mot occupe 10 pixels, l'emblème une moitié.
const masque = (pixels: number[]): Masque => ({ data: new Uint8Array(pixels.map((p) => (p ? 255 : 0))), width: 10, height: 10 })
const grille = (fn: (x: number, y: number) => boolean) =>
  masque(Array.from({ length: 100 }, (_, i) => (fn(i % 10, Math.floor(i / 10)) ? 1 : 0)))

const motBande = grille((_, y) => y === 5) // 10 pixels, la ligne 5
check('débordement : mot entièrement dans la silhouette → 0 (badge)', tauxDebordement(motBande, grille(() => true)), 0)
check('débordement : mot entièrement dehors → 1 (posé à côté)', tauxDebordement(motBande, grille((_, y) => y === 0)), 1)
check('débordement : 2 pixels sur 10 dehors → 0,2', tauxDebordement(motBande, grille((x) => x >= 2)), 0.2)
check('débordement : mot vide → 0, jamais NaN', tauxDebordement(grille(() => false), grille(() => true)), 0)

check('verdict : 0,00 → badge', decideDebordement(0), 'badge')
check('verdict : 0,04 → badge (sous le plancher)', decideDebordement(0.04), 'badge')
check('verdict : 0,05 → contenant réel', decideDebordement(0.05), 'contenant_reel')
check('verdict : 0,35 → contenant réel (borne haute incluse)', decideDebordement(0.35), 'contenant_reel')
check('verdict : 0,5 → entre deux', decideDebordement(0.5), 'entre_deux')
check('verdict : 0,9 → posé à côté', decideDebordement(0.9), 'pose_a_cote')

// LE CONTRAT DES DEUX BOUTS : le badge a l'overlap maximal et échoue quand même.
check(
  'contrat : overlap 1,00 + débordement 0 (le badge) → REFUSÉ',
  contratComposition({ archetype: 'CONTAINER', overlap: 1, debordement: 0 }).ok,
  false
)
check(
  'contrat : overlap 0,86 + débordement 0,12 (contenant réel) → accepté',
  contratComposition({ archetype: 'CONTAINER', overlap: 0.86, debordement: 0.12 }).ok,
  true
)
check(
  'contrat : overlap 0,10 + débordement 0,20 (emblème à côté) → REFUSÉ',
  contratComposition({ archetype: 'CONTAINER', overlap: 0.1, debordement: 0.2 }).ok,
  false
)
check(
  'contrat : le débordement ne juge QUE les contenants',
  contratComposition({ archetype: 'CREST', overlap: 0.25, debordement: 0 }).ok,
  true
)
check(
  'contrat : sans emblème séparé, tout est non applicable',
  contratComposition({ archetype: 'HERO_MONOGRAM', overlap: 0, debordement: null }).ok,
  true
)

// ── 3. decideDuel — le barème §7.2 ───────────────────────────────────────────
check('duel : 4/8 → à la barre', decideDuel(4, 8), 'barre')
check('duel : 8/8 → à la barre', decideDuel(8, 8), 'barre')
check('duel : 3/8 → entre deux', decideDuel(3, 8), 'entre_deux')
check('duel : 2/8 → rejet', decideDuel(2, 8), 'rejet')
check('duel : 0/8 → rejet', decideDuel(0, 8), 'rejet')
// transposition quand le gold set ne fournit pas 8 pièces jouables
check('duel : 4/7 → à la barre (barème transposé)', decideDuel(4, 7), 'barre')
check('duel : 1/7 → rejet (barème transposé)', decideDuel(1, 7), 'rejet')

// ── 4. PIVOT IDIOME — la mesure ne s'exécute pas sur ce qu'elle ne juge pas ──
// HERO_MONOGRAM est devenu l'archétype par défaut. Lancer l'appel de détection
// dessus produirait une boîte d'emblème inventée et un chiffre que le rapport
// lirait comme une note. Le court-circuit est vérifié SANS clé API : s'il
// tombait, cet appel partirait sur le réseau et le test échouerait.
const { mesureComposition } = await import('./calibration/mesure-v6')
for (const archetype of ['HERO_MONOGRAM', 'EMBLEM_ONLY', 'WORDMARK_PUR']) {
  const m = await mesureComposition({ png: Buffer.alloc(0), label: 'test_sans_appel', archetype })
  check(`${archetype} : verdict non applicable, zéro appel`, [m.verdict, m.mesurable, m.essais, m.tokensIn], [
    'non_applicable',
    true,
    0,
    0,
  ])
}

console.log(failures ? `\n${failures} test(s) en échec` : '\nTous les tests de la mesure v6 passent')
process.exit(failures ? 1 : 0)
