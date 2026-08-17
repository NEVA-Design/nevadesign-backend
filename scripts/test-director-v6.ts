/*
 * Run 6 — LE VALIDATEUR v6 SOUS TEST, zéro appel API.
 *
 * Pourquoi ce fichier existe : un validateur trop rigide coûte un appel DA
 * (~0,03 €) à chaque rejet, et deux rejets font échouer la génération entière.
 * C'est arrivé en phase 1 d'E3 — trois concepts consécutifs recalés pour une
 * matière écrite « obsidian or chrome surfaces » au lieu du gabarit exact
 * attendu, avec un message qui ne CITAIT PAS la phrase fautive : le modèle a
 * donc réécrit la même chose au second essai. Les deux défauts sont corrigés
 * ici et verrouillés.
 *
 * Mise à jour du 17/08 (PIVOT IDIOME) : le contrat a changé sur quatre points —
 * S1 sans « premium », familles de rendu, HERO_MONOGRAM par défaut et sans
 * blockout, chrome_3d minoritaire. Chaque changement est verrouillé ici.
 *
 *   bun run scripts/test-director-v6.ts
 */

import {
  validateConceptsV6,
  buildPromptV6,
  phraseS1,
  phraseS3,
  ARCHETYPES,
  ARCHETYPE_DEFAUT,
  ARCHETYPE_SANS_LETTRAGE,
  FAMILLES_RENDU,
  MAX_CHROME_3D,
  CLAUSE_CADRAGE,
  CLAUSE_FAMILLE,
  HERO_MONOGRAM_MAX_LETTRES,
  compteLettres,
  rotationPourMot,
  archetypesPivotPourMot,
} from '../src/lib/engine/logo-director-v6'
import { parseLogoAnswersV3 } from '../src/lib/engine/logo-brief'

let failures = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`}`)
  if (!ok) failures += 1
}

const answersNom = parseLogoAnswersV3({ type: 'nom', sujet: 'loup, forêt', ambiance: 'sombre', matiere: 'or' })!
const answersEmbleme = parseLogoAnswersV3({ type: 'embleme', sujet: 'ailes, forge', ambiance: 'sombre', matiere: 'or' })!

// REFERENCE 1 doit parler la famille du concept (correction opérateur du
// 17/08) : le catalogue de test porte donc une pièce par famille.
const FAMILLE_DES_REFS = new Map<string, string | undefined>([
  ['daycity1', 'flat_vector_texture'],
  ['flashmood-rp2', 'texture_fill'],
  ['valesia-rp1', 'scene_composite'],
  ['logo2', 'chrome_3d'],
])

const OPTS = {
  answers: answersNom,
  // 3 lettres : HERO_MONOGRAM reste proposable (plafond du 17/08). Les briefs à
  // nom long sont testés séparément via OPTS_LONG.
  projectName: 'Nox',
  slugsDisponibles: new Set(['logo', 'logo2', 'flashmood-rp2', 'branding', 'daycity1', 'valesia-rp1']),
  slugsGold: new Set(['logo2', 'flashmood-rp2', 'branding']),
  // l'idiome : seuls ces slugs peuvent occuper REFERENCE 1
  slugsFivem: new Set(['logo2', 'flashmood-rp2', 'daycity1', 'valesia-rp1']),
  familleParSlug: FAMILLE_DES_REFS,
}

/** Les 3 références d'un concept : slot 1 dans SA famille, 2 pièces gold. */
function refsPour(famille: string) {
  const slot1 = [...FAMILLE_DES_REFS.entries()].find(([, f]) => f === famille)?.[0] ?? 'daycity1'
  const gold = ['logo2', 'flashmood-rp2', 'branding'].filter((s) => s !== slot1).slice(0, 2)
  return [
    { slug: slot1, label: `REFERENCE 1 — ${famille} piece` },
    { slug: gold[0]!, label: 'REFERENCE 2 — quality bar' },
    { slug: gold[1]!, label: 'REFERENCE 3 — free' },
  ]
}

const refs = refsPour('flat_vector_texture')

/** Un blockout conforme au contrat P2 : le mot traverse le contour. */
const blockout = { emblem_shape: 'circle', emblem_bbox: [0.12, 0.12, 0.76, 0.76], word_bbox: [0.06, 0.42, 0.88, 0.16] }

/*
 * Les S2 de référence, un par famille. Depuis le 17/08 chacune doit NOMMER UNE
 * SCÈNE (« dark atmospheric background » est rejeté), tenir en 18-28 mots, et
 * ne PAS écrire le contour noir ni le duotone — le code les ajoute.
 */
const S2 = {
  hero: 'A massive wolf-cut monogram locked to a small wordmark, drawn in matte vinyl or duotone surfaces under a halftone screen, on a palm-lined street at night',
  container:
    'A howling wolf head contains the lettering breaking out at the ends, painted in flat paint or matte vinyl surfaces, on a rain-slick city street',
  fill: 'A wolf silhouette crosses the lettering and fills every counter with forest light, in photographic or painted fill surfaces, behind a chain-link fence',
  chrome:
    'A howling wolf head contains the lettering breaking out at the ends, forged in chrome or satin materials, outside a neon casino in the rain',
}

type ConceptTest = { archetype: string; famille_rendu: string; s2: string; blockout?: unknown; refs?: unknown }

/** Le trio par défaut du pivot : un HERO_MONOGRAM, deux constructions, deux
 *  familles plates et rien de chromé. */
function trioDefaut(): ConceptTest[] {
  return [
    { archetype: 'HERO_MONOGRAM', famille_rendu: 'flat_vector_texture', s2: S2.hero },
    { archetype: 'CONTAINER', famille_rendu: 'scene_composite', s2: S2.container, blockout },
    { archetype: 'ENTWINED', famille_rendu: 'texture_fill', s2: S2.fill, blockout },
  ]
}

function payload(concepts: ConceptTest[], surcharge: Record<string, unknown> = {}) {
  return {
    concepts: concepts.map((c) => ({
      archetype: c.archetype,
      famille_rendu: c.famille_rendu,
      s2: c.s2,
      why: 'ligne opérateur',
      // slot 1 suit la famille du concept, sauf surcharge explicite du test
      refs: c.refs ?? refsPour(c.famille_rendu),
      ...(c.blockout ? { blockout: c.blockout } : {}),
      ...surcharge,
    })),
  }
}

/** Le trio par défaut avec UN concept remplacé — pour isoler une variable. */
function trioAvec(index: number, patch: Partial<ConceptTest>): ConceptTest[] {
  const t = trioDefaut()
  t[index] = { ...t[index]!, ...patch }
  return t
}

// ── 0. LE TRIO DE RÉFÉRENCE PASSE ───────────────────────────────────────────
check('le trio par défaut du pivot est ACCEPTÉ', 'concepts' in (await validateConceptsV6(payload(trioDefaut()), OPTS)), true)

// ── 1. LA MATIÈRE : le contrat porte sur « une famille + une alternative » ───
// Toutes ces formulations tiennent le contrat. Les recaler coûte un appel DA.
// Elles sont testées sur le concept chrome_3d, le seul où le métal est permis.
const matieresValides = [
  'metallic or resin materials',
  'chrome or satin materials',
  'brushed steel or black lacquer surfaces',
  'aged gold or gunmetal finish',
  'smoked glass or matte enamel finishes',
  'obsidian or chrome surfaces',
]
for (const matiere of matieresValides) {
  const s2 = `A howling wolf head contains the lettering breaking out at the ends, forged in ${matiere}, outside a neon casino in the rain`
  const v = await validateConceptsV6(payload(trioAvec(1, { famille_rendu: 'chrome_3d', s2 })), OPTS)
  check(`matière acceptée : « ${matiere} »`, 'concepts' in v, true)
}

// Et ce que la règle doit VRAIMENT refuser : aucune alternative.
const sansAlternative = await validateConceptsV6(
  payload(
    trioAvec(1, {
      famille_rendu: 'chrome_3d',
      s2: 'A wolf head contains the lettering breaking out at the ends, forged in polished chrome, outside a neon casino in the rain',
    })
  ),
  OPTS
)
check('matière sans alternative : REJETÉE', 'errors' in sansAlternative, true)
if ('errors' in sansAlternative) {
  check(
    'le message CITE la phrase fautive (sinon le modèle la réécrit à l\'identique)',
    sansAlternative.errors.some((e) => e.includes('offending fragment') && e.includes('A wolf head contains')),
    true
  )
}

// ── 2. P1 : GLYPH_FUSION est hors rotation, et le message dit pourquoi ───────
check('la rotation ne contient plus GLYPH_FUSION', [...ARCHETYPES].includes('GLYPH_FUSION' as never), false)
const glyph = await validateConceptsV6(payload(trioAvec(1, { archetype: 'GLYPH_FUSION' })), OPTS)
check('GLYPH_FUSION : REJETÉ', 'errors' in glyph, true)
if ('errors' in glyph) {
  check('le message dit qu\'aucune garde ne le couvre', /OUT of the production rotation/.test(glyph.errors.join(' ')), true)
}

// ── 3. PIVOT — HERO_MONOGRAM est l'archétype par défaut ─────────────────────
check('HERO_MONOGRAM ouvre la rotation', ARCHETYPES[0], 'HERO_MONOGRAM')
check('l\'archétype par défaut est HERO_MONOGRAM', ARCHETYPE_DEFAUT, 'HERO_MONOGRAM')
const sansHero = await validateConceptsV6(
  payload([
    { archetype: 'CONTAINER', famille_rendu: 'scene_composite', s2: S2.container, blockout },
    { archetype: 'ENTWINED', famille_rendu: 'texture_fill', s2: S2.fill, blockout },
    { archetype: 'CREST', famille_rendu: 'flat_vector_texture', s2: S2.hero, blockout },
  ]),
  OPTS
)
check('aucun HERO_MONOGRAM dans le trio : REJETÉ', 'errors' in sansHero, true)
if ('errors' in sansHero) {
  check(
    'le message dit que c\'est la construction par défaut de l\'idiome',
    /default construction of the FiveM idiom/.test(sansHero.errors.join(' ')),
    true
  )
}

// HERO_MONOGRAM n'a PAS de blockout : le squelette emblème/mot ne s'y applique
// pas (E1 — trois pièces gold sortent à 0,000 pour cette raison).
const vHero = await validateConceptsV6(payload(trioDefaut()), OPTS)
if ('concepts' in vHero) {
  check(
    'HERO_MONOGRAM : aucun blockout, aucun débordement mesuré',
    [vHero.concepts[0]!.blockout, vHero.concepts[0]!.debordement],
    [null, null]
  )
}
// mais la garde d'ÉCHELLE tient quand un blockout est quand même fourni
const heroMinuscule = await validateConceptsV6(
  payload(trioAvec(0, { blockout: { emblem_shape: 'circle', emblem_bbox: [0.3, 0.3, 0.4, 0.4], word_bbox: [0.4, 0.44, 0.2, 0.1] } })),
  OPTS
)
check('HERO_MONOGRAM à petite échelle : REJETÉ', 'errors' in heroMinuscule, true)
if ('errors' in heroMinuscule) {
  check('le message parle d\'échelle, pas d\'overlap', /carries the whole mark/.test(heroMinuscule.errors.join(' ')), true)
}

// ── 4. PIVOT — LES FAMILLES DE RENDU ────────────────────────────────────────
check('les 4 familles, dans cet ordre', [...FAMILLES_RENDU], [
  'flat_vector_texture',
  'texture_fill',
  'scene_composite',
  'chrome_3d',
])
const familleInconnue = await validateConceptsV6(payload(trioAvec(0, { famille_rendu: 'plat_premium' })), OPTS)
check('famille_rendu hors liste : REJETÉE', 'errors' in familleInconnue, true)

// chrome_3d est minoritaire
const troisChrome = await validateConceptsV6(
  payload([
    { archetype: 'HERO_MONOGRAM', famille_rendu: 'chrome_3d', s2: S2.chrome },
    { archetype: 'CONTAINER', famille_rendu: 'chrome_3d', s2: S2.chrome, blockout },
    { archetype: 'ENTWINED', famille_rendu: 'chrome_3d', s2: S2.chrome, blockout },
  ]),
  OPTS
)
check(`plus de ${MAX_CHROME_3D} concept chrome_3d : REJETÉ`, 'errors' in troisChrome, true)
if ('errors' in troisChrome) {
  check('le message dit que le chrome est minoritaire', /minority register/.test(troisChrome.errors.join(' ')), true)
}

// chrome_3d ne se pose pas sur l'archétype par défaut
const heroChrome = await validateConceptsV6(
  payload(trioAvec(0, { famille_rendu: 'chrome_3d', s2: S2.chrome.replace('contains the lettering breaking out at the ends', 'is cut from a fractured shard, locked to a small wordmark') })),
  OPTS
)
check('HERO_MONOGRAM en chrome_3d : REJETÉ', 'errors' in heroChrome, true)
if ('errors' in heroChrome) {
  check(
    'le message dit de déplacer le chrome sur une autre construction',
    /must be shown in its majority language/.test(heroChrome.errors.join(' ')),
    true
  )
}
// mais le chrome reste permis sur une AUTRE construction
check(
  'chrome_3d sur CONTAINER : ACCEPTÉ',
  'concepts' in (await validateConceptsV6(payload(trioAvec(1, { famille_rendu: 'chrome_3d', s2: S2.chrome })), OPTS)),
  true
)

// une famille plate ne parle pas chrome
const platEnChrome = await validateConceptsV6(
  payload(trioAvec(1, { famille_rendu: 'scene_composite', s2: S2.chrome })),
  OPTS
)
check('famille plate + matière chromée : REJETÉE', 'errors' in platEnChrome, true)
if ('errors' in platEnChrome) {
  check(
    'le message cite le mot de relief fautif',
    /offending fragment": "chrome|offending fragment: "chrome/.test(platEnChrome.errors.join(' ')),
    true
  )
}

// flat_vector_texture DOIT nommer sa texture
const platSansTexture = await validateConceptsV6(
  payload(
    trioAvec(0, {
      s2: 'A massive wolf-cut monogram locked to a small wordmark, drawn in matte vinyl or duotone surfaces, on a palm-lined street at night',
    })
  ),
  OPTS
)
check('flat_vector_texture sans texture nommée : REJETÉE', 'errors' in platSansTexture, true)
if ('errors' in platSansTexture) {
  check('le message propose halftone / grain / scanlines / grid', /halftone dot screen, grain, scanlines/.test(platSansTexture.errors.join(' ')), true)
}

// texture_fill DOIT dire que la matière remplit le glyphe
const fillSansRemplissage = await validateConceptsV6(
  payload(
    trioAvec(2, {
      s2: 'A wolf silhouette crosses the lettering from behind, painted in photographic or painted surfaces, behind a chain-link fence',
    })
  ),
  OPTS
)
check('texture_fill sans remplissage : REJETÉE', 'errors' in fillSansRemplissage, true)

// deux familles au minimum sur les trois concepts
const familleUnique = await validateConceptsV6(
  payload([
    { archetype: 'HERO_MONOGRAM', famille_rendu: 'flat_vector_texture', s2: S2.hero },
    { archetype: 'CONTAINER', famille_rendu: 'flat_vector_texture', s2: S2.hero.replace('locked to a small wordmark', 'contains the lettering breaking out'), blockout },
    { archetype: 'ENTWINED', famille_rendu: 'flat_vector_texture', s2: S2.hero.replace('locked to a small wordmark', 'coiled around the lettering'), blockout },
  ]),
  OPTS
)
check('les 3 concepts dans la même famille : REJETÉ', 'errors' in familleUnique, true)

// ── 4bis. PIVOT — LA CLAUSE DE FAMILLE, écrite par le CODE ──────────────────
// Correction opérateur du 17/08 : le contour noir épais et le duotone sont sur
// TOUTES ses références et sur aucun des 3 prompts de la phase 1.
check(
  'flat_vector_texture : la clause est ajoutée au prompt assemblé',
  buildPromptV6('x', 'NOX', 'flat_vector_texture').includes('thick black outline and a strict two-color palette'),
  true
)
check(
  'chrome_3d : aucune clause ajoutée',
  buildPromptV6('x', 'NOX', 'chrome_3d').includes('thick black outline'),
  false
)
if ('concepts' in vHero) {
  check(
    'le prompt du concept flat porte la clause',
    vHero.concepts[0]!.prompt.includes('thick black outline and a strict two-color palette'),
    true
  )
}
// et le DA ne la réécrit pas : elle serait dite deux fois
const clauseEnDouble = await validateConceptsV6(
  payload(
    trioAvec(0, {
      s2: 'A massive wolf-cut monogram with a thick black outline, drawn in matte vinyl or duotone surfaces under a halftone screen, on a night street',
    })
  ),
  OPTS
)
check('le DA réécrit la clause de famille : REJETÉ', 'errors' in clauseEnDouble, true)
if ('errors' in clauseEnDouble) {
  check('le message dit que le code l\'ajoute déjà', /are added automatically/.test(clauseEnDouble.errors.join(' ')), true)
}

// ── 4ter. PIVOT — LE FOND NOMME UNE SCÈNE ──────────────────────────────────
// « dark atmospheric background » est le défaut exact de northside.
const fondVide = await validateConceptsV6(
  payload(
    trioAvec(0, {
      s2: 'A massive wolf-cut monogram locked to a small wordmark, drawn in matte vinyl or duotone surfaces under a halftone screen, on a dark atmospheric background',
    })
  ),
  OPTS
)
check('fond « dark atmospheric background » : REJETÉ', 'errors' in fondVide, true)
if ('errors' in fondVide) {
  check(
    'le message propose des scènes réelles',
    /purple night city skyline|chain-link fence|palm-lined street/.test(fondVide.errors.join(' ')),
    true
  )
}
for (const scene of ['on a purple night city skyline', 'behind a chain-link fence', 'on a palm-lined street at night']) {
  const s2 = `A massive wolf-cut monogram locked to a small wordmark, drawn in matte vinyl or duotone surfaces under a halftone screen, ${scene}`
  check(
    `scène « ${scene} » : ACCEPTÉE`,
    'concepts' in (await validateConceptsV6(payload(trioAvec(0, { s2 })), OPTS)),
    true
  )
}

// ── 4quater. PIVOT — REFERENCE 1 parle la langue du concept ────────────────
// Sur `vulcain`, le DA a dessiné l'objet déduit du NOM (une enclume) au lieu de
// la construction de sa référence. On ne code pas « déduit de l'étymologie » ;
// on exige que la première image, celle que le rendu copie, montre la famille.
const ref1AutreFamille = await validateConceptsV6(
  payload(trioAvec(0, { refs: refsPour('chrome_3d') })),
  OPTS
)
check('REFERENCE 1 d\'une autre famille : REJETÉE', 'errors' in ref1AutreFamille, true)
if ('errors' in ref1AutreFamille) {
  check(
    'le message nomme les deux familles et propose les éligibles',
    /is a chrome_3d piece but the concept is flat_vector_texture/.test(ref1AutreFamille.errors.join(' ')) &&
      /Pick reference 1 from: .*daycity1/.test(ref1AutreFamille.errors.join(' ')),
    true
  )
}

// ── 5. les règles de diversité d'archétype ──────────────────────────────────
const memeArchetype = await validateConceptsV6(payload(trioAvec(2, { archetype: 'CONTAINER' })), OPTS)
check('3 archétypes non distincts : REJETÉ', 'errors' in memeArchetype, true)

// ── 6. P2 : le blockout badge est recalé sur le débordement ─────────────────
const badge = { emblem_shape: 'circle', emblem_bbox: [0.14, 0.14, 0.72, 0.72], word_bbox: [0.26, 0.44, 0.48, 0.13] }
const vBadge = await validateConceptsV6(payload(trioAvec(1, { blockout: badge })), OPTS)
check('blockout en plaque (overlap 1,00) : REJETÉ sur le débordement', 'errors' in vBadge, true)
if ('errors' in vBadge) {
  check('le message nomme le badge', /badge, a word laid on a plate/.test(vBadge.errors.join(' ')), true)
}

// ── 7. le mode SANS LETTRAGE (brief vulcain) ────────────────────────────────
const optsEmbleme = { ...OPTS, answers: answersEmbleme, projectName: 'Vulcain' }
const s2Embleme =
  'Two forged wings sweep around a central hammer, cut from matte vinyl or duotone surfaces with a halftone screen, behind a chain-link fence'
const sansLettrage = await validateConceptsV6(
  {
    concepts: [1, 2, 3].map((i) => {
      const famille = i === 3 ? 'scene_composite' : 'flat_vector_texture'
      return { archetype: ARCHETYPE_SANS_LETTRAGE, famille_rendu: famille, s2: s2Embleme, why: 'x', refs: refsPour(famille) }
    }),
  },
  optsEmbleme
)
check('sans lettrage : EMBLEM_ONLY sans blockout est accepté', 'concepts' in sansLettrage, true)
if ('concepts' in sansLettrage) {
  check('sans lettrage : aucun blockout, aucun débordement', [sansLettrage.concepts[0]!.blockout, sansLettrage.concepts[0]!.debordement], [null, null])
}
const archetypeDeTrop = await validateConceptsV6(
  {
    concepts: [1, 2, 3].map(() => ({ archetype: 'CONTAINER', famille_rendu: 'flat_vector_texture', s2: s2Embleme, why: 'x', refs })),
  },
  optsEmbleme
)
check('sans lettrage : un archétype de la rotation est REJETÉ', 'errors' in archetypeDeTrop, true)

// ── 8. PIVOT — le squelette S1/S3, sans « premium » ─────────────────────────
check('S1 ne dit plus « premium »', /premium/i.test(phraseS1('BLACKWOOD')), false)
check('S1 sans mot ne dit plus « premium »', /premium/i.test(phraseS1(null)), false)
check('S1 demande l\'IDIOME des références', phraseS1('NOX').includes('in the exact visual idiom of the attached reference logos'), true)
check('S1 porte l\'épellation', phraseS1('BLACKWOOD').includes('B-L-A-C-K-W-O-O-D'), true)
check('S1 sans mot : aucun texte', phraseS1(null).includes('no text and no lettering'), true)
check('S3 sans mot : aucun texte', phraseS3(null).includes('no text'), true)
check(
  'le prompt assemblé = S1 + S2 + cadrage + S3, dans cet ordre',
  buildPromptV6('A wolf head contains the word', 'NOX'),
  `${phraseS1('NOX')} A wolf head contains the word. ${CLAUSE_CADRAGE} ${phraseS3('NOX')}`
)

// ── 9. les références : 3 slugs, >= 2 gold, tous joignables ─────────────────
const vRefInconnue = await validateConceptsV6(
  payload(trioDefaut(), { refs: [{ slug: 'inexistant', label: 'REFERENCE 1 — x' }, refs[1]!, refs[2]!] }),
  OPTS
)
check('slug hors catalogue : REJETÉ', 'errors' in vRefInconnue, true)
const vGold = await validateConceptsV6(
  payload(trioDefaut(), { refs: [refs[0]!, refs[2]!, { slug: 'daycity1', label: 'REFERENCE 3 — x' }] }),
  OPTS
)
check('moins de 2 références gold : REJETÉ', 'errors' in vGold, true)

// ── 10. L'IDIOME : REFERENCE 1 est toujours une pièce FiveM/GTA ─────────────
// E3 a rendu la leçon chère : quatre concepts sur cinq ont ouvert sur le
// wordmark Fruitz — une marque de fruits — et les rendus ont hérité de SA
// langue au lieu de celle d'un serveur.
const vIdiome = await validateConceptsV6(
  payload(trioDefaut(), {
    refs: [
      { slug: 'logo', label: 'REFERENCE 1 — the Fruitz wordmark' },
      { slug: 'logo2', label: 'REFERENCE 2 — chrome S' },
      { slug: 'flashmood-rp2', label: 'REFERENCE 3 — FLASH MOOD' },
    ],
  }),
  OPTS
)
check('REFERENCE 1 hors idiome (Fruitz) : REJETÉ', 'errors' in vIdiome, true)
if ('errors' in vIdiome) {
  check(
    'le message nomme le slug fautif et propose les éligibles',
    /REFERENCE 1 is "logo", which is not a FiveM\/GTA server piece/.test(vIdiome.errors.join(' ')) &&
      /Pick reference 1 from: .*logo2/.test(vIdiome.errors.join(' ')),
    true
  )
}

// ── 10bis. LA CLAUSE DE CADRAGE — fond enfoncé, marque lisible à 64 px ──────
// « Mes références ont un fond ENFONCÉ, pas une scène en vitrine. »
check(
  'la clause de cadrage est ajoutée à TOUTES les familles',
  FAMILLES_RENDU.every((f) => buildPromptV6('x', 'NOX', f).includes(CLAUSE_CADRAGE)),
  true
)
check(
  'l\'ordre est S1 · S2 · clause de famille · clause de cadrage · S3',
  buildPromptV6('CONSTRUCTION', 'NOX', 'flat_vector_texture'),
  `${phraseS1('NOX')} CONSTRUCTION. ${CLAUSE_FAMILLE.flat_vector_texture} ${CLAUSE_CADRAGE} ${phraseS3('NOX')}`
)
// La clause de famille porte l'anti-détail demandé le 17/08. Ce sont les
// premières négations réintroduites dans un prompt image depuis le 5.9 : le
// test les fige pour qu'un retour à la formulation positive soit un choix, pas
// une dérive silencieuse.
check(
  'la clause de famille porte l\'anti-détail',
  CLAUSE_FAMILLE.flat_vector_texture?.includes('No inner paneling, no rivets, no gears, no secondary shapes. The mark is one silhouette.'),
  true
)
const cadrageEnDouble = await validateConceptsV6(
  payload(
    trioAvec(0, {
      s2: 'A massive wolf-cut monogram that dominates the frame, drawn in matte vinyl or duotone surfaces under a halftone screen, on a night street',
    })
  ),
  OPTS
)
check('le DA réécrit la clause de cadrage : REJETÉ', 'errors' in cadrageEnDouble, true)

// ── 10ter. UN SUJET, UNE SILHOUETTE — pas de micro-détail ───────────────────
// Relevé sur le rendu vulcain : engrenages, rivets, façade détaillée.
for (const mot of ['gears', 'rivets', 'ornate', 'intricate']) {
  const v = await validateConceptsV6(
    payload(
      trioAvec(0, {
        s2: `A massive wolf-cut monogram with ${mot} locked to a wordmark, drawn in matte vinyl or duotone surfaces under a halftone screen, on a night street`,
      })
    ),
    OPTS
  )
  check(`micro-détail « ${mot} » : REJETÉ`, 'errors' in v, true)
}

// ── 10quater. HERO_MONOGRAM plafonné à 3 lettres ────────────────────────────
// AZURE sortait en A géant surmontant « ZURE » : deux lignes, plus un monogramme.
check('compteLettres ignore espaces et ponctuation', [compteLettres('NOX'), compteLettres('Northside RP')], [3, 11])
check('NOX : le monogramme est proposable', [...rotationPourMot('NOX')].includes('HERO_MONOGRAM'), true)
check('NOX : pas de wordmark pur', [...rotationPourMot('NOX')].includes('WORDMARK_PUR'), false)
check('AZURE : le monogramme est retiré', [...rotationPourMot('AZURE')].includes('HERO_MONOGRAM'), false)
check('AZURE : le wordmark pur entre en rotation', [...rotationPourMot('AZURE')].includes('WORDMARK_PUR'), true)
check('NOX : le pivot est le monogramme', [...archetypesPivotPourMot('NOX')], ['HERO_MONOGRAM'])
check('AZURE : le pivot est wordmark ou enlacé', [...archetypesPivotPourMot('AZURE')], ['WORDMARK_PUR', 'ENTWINED'])

const OPTS_LONG = { ...OPTS, projectName: 'Azure' }
const trioLong = [
  { archetype: 'WORDMARK_PUR', famille_rendu: 'flat_vector_texture', s2: S2.hero.replace('A massive wolf-cut monogram locked to a small wordmark', 'The five letters are cut and joined into one continuous shape') },
  { archetype: 'ENTWINED', famille_rendu: 'texture_fill', s2: S2.fill, blockout },
  { archetype: 'CONTAINER', famille_rendu: 'scene_composite', s2: S2.container, blockout },
]
check('AZURE : un trio sans monogramme est ACCEPTÉ', 'concepts' in (await validateConceptsV6(payload(trioLong), OPTS_LONG)), true)
// WORDMARK_PUR n'a pas d'emblème : la règle de relation ne s'y applique pas.
// Elle avait recalé « the full word is one custom-drawn line of lettering
// reading as a single shape » — une description exacte de l'archétype.
const wordmarkSansRelation = await validateConceptsV6(
  payload([
    {
      archetype: 'WORDMARK_PUR',
      famille_rendu: 'flat_vector_texture',
      s2: 'The full word is one custom-drawn line of lettering reading as a single shape, in matte vinyl or duotone surfaces under a halftone screen, on a night street',
    },
    trioLong[1]!,
    trioLong[2]!,
  ]),
  OPTS_LONG
)
check('WORDMARK_PUR sans verbe de relation : ACCEPTÉ', 'concepts' in wordmarkSansRelation, true)
const azureEnHero = await validateConceptsV6(
  payload([{ ...trioLong[0]!, archetype: 'HERO_MONOGRAM' }, trioLong[1]!, trioLong[2]!]),
  OPTS_LONG
)
check('AZURE en HERO_MONOGRAM : REJETÉ', 'errors' in azureEnHero, true)
if ('errors' in azureEnHero) {
  check(
    'le message donne la longueur et le plafond',
    new RegExp(`is 5 letters — HERO_MONOGRAM is for ${HERO_MONOGRAM_MAX_LETTRES} letters or fewer`).test(azureEnHero.errors.join(' ')),
    true
  )
}
check(
  'WORDMARK_PUR ne porte pas de blockout',
  'concepts' in (await validateConceptsV6(payload(trioLong), OPTS_LONG)) &&
    ((await validateConceptsV6(payload(trioLong), OPTS_LONG)) as { concepts: Array<{ blockout: unknown }> }).concepts[0]!.blockout === null,
  true
)

// ── 10quinquies. REFERENCE 1 est une CIBLE DE COPIE ─────────────────────────
const { LABEL_REFERENCE_1, pickExemplarsParSlugs } = await import('../src/lib/engine/exemplars')
const etiquetees = pickExemplarsParSlugs({
  category: 'logo',
  choix: [
    { slug: 'vulcainlogo', label: 'REFERENCE 1 — ce que le DA avait écrit' },
    { slug: 'black-world1', label: 'REFERENCE 2 — la barre' },
    { slug: 'logotbnnn', label: 'REFERENCE 3 — libre' },
  ],
})
check('le slot 1 porte l\'instruction de copie, pas le texte du DA', etiquetees[0]?.label, LABEL_REFERENCE_1)
check('l\'instruction dit « only the glyph changes »', LABEL_REFERENCE_1.includes('Only the glyph changes'), true)
check('les slots 2 et 3 gardent le texte du DA', etiquetees[1]?.label, 'REFERENCE 2 — la barre')

// ── 11. LE CORPUS RÉEL après le pivot ───────────────────────────────────────
const { goldSlugs, fivemSlugs, horsCorpusReferenceSlugs, listReferenceCatalogue } = await import('../src/lib/engine/exemplars')
const gold = goldSlugs()
const fivem = fivemSlugs()
const horsCorpus = horsCorpusReferenceSlugs()

for (const slug of ['logo', '4409091d08b9cb1da6aa3c72b0e1e0b4', 'logo-sweetylife', 'branding']) {
  check(`${slug} : sorti du corpus de références`, horsCorpus.has(slug), true)
  check(`${slug} : hors gold set`, gold.has(slug), false)
  check(`${slug} : hors idiome`, fivem.has(slug), false)
}

const catalogue = listReferenceCatalogue('logo')
const slugsCatalogue = new Set(catalogue.map((c) => c.slug))
check(
  'aucune pièce hors corpus n\'est joignable',
  [...horsCorpus].filter((s) => slugsCatalogue.has(s)),
  []
)
check(
  'les 5 pièces d\'idiome intégrées le 17/08 sont joignables',
  ['logotbnnn', 'vulcainlogo', 'gtanewlogo', 'goldenlogo', 'blackstory-rp2'].filter((s) => !slugsCatalogue.has(s)),
  []
)
check(
  'les 2 pièces à trame halftone sont dans la barre',
  ['logotbnnn', 'vulcainlogo'].every((s) => gold.has(s)),
  true
)
check(
  'il reste des pièces à la fois FIVEM et GOLD pour le slot 1',
  [...fivem].filter((s) => gold.has(s)).length >= 2,
  true
)
// La contrainte « REFERENCE 1 dans la famille du concept » doit rester
// satisfaisable pour CHAQUE famille, sinon le DA tourne en rond à 0,016 €/essai.
for (const famille of FAMILLES_RENDU) {
  const candidats = catalogue.filter((c) => c.fivem && c.famille_rendu === famille)
  check(`${famille} : au moins une pièce éligible en REFERENCE 1`, candidats.length >= 1, true)
  // et il reste assez de gold ailleurs pour tenir le « >= 2 gold sur 3 »
  check(
    `${famille} : au moins 2 gold disponibles pour les slots 2-3`,
    catalogue.filter((c) => c.gold && !candidats.slice(0, 1).some((x) => x.slug === c.slug)).length >= 2,
    true
  )
}
check(
  'chrome_3d reste minoritaire DANS la barre',
  catalogue.filter((c) => c.gold && c.famille_rendu === 'chrome_3d').length <=
    catalogue.filter((c) => c.gold && c.famille_rendu !== 'chrome_3d').length,
  true
)

console.log(failures ? `\n${failures} test(s) en échec` : '\nTous les tests du directeur v6 passent')
process.exit(failures ? 1 : 0)
