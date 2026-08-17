/*
 * Run 7 — PHASE 3 : LA MARQUE EN SVG. Zéro appel image.
 *
 * C'est le cœur du pari de la session. Un modèle d'image PEINT ; ici le modèle
 * ÉCRIT des courbes, et un rasteriseur les trace. La question n'est pas « le
 * rendu est-il beau » mais « la géométrie est-elle propre » — et cette question
 * se mesure.
 *
 *   bun run scripts/calibration/v7-svg.ts [--sujets nox,vulcain] [--tours 8] [--fresh]
 *
 * La boucle, par sujet, jusqu'à 8 tours :
 *   1. le modèle écrit le SVG (pro, raisonnement élevé)
 *   2. sharp le rend en 1024 et en 64 sur fond neutre
 *   3. gemini-3.5-flash le compare à la cible, côte à côte
 *   4. le CODE tranche ; si une garde échoue, le modèle reçoit la critique ET
 *      le montage côte à côte, et corrige
 *   5. sortie au premier tour où tout passe, sinon au dernier avec le meilleur
 *      état mesuré
 *
 * Répartition des rôles, sans ambiguïté : le code mesure le nombre d'éléments
 * (composantes connexes), le nombre de couleurs (histogramme du rendu), la
 * lisibilité à 64 px (IoU) et la conformité de palette. Le modèle de vision ne
 * juge que ce qu'aucun code de cette taille ne sait voir : la propreté des
 * courbes et la constance des épaisseurs. Aucun chiffre du modèle n'entre dans
 * une décision.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import sharp from 'sharp'
import {
  installBudgetGuard,
  PhaseBudgetError,
  PLAFONDS_PHASE,
  setBudgetLabel,
  setPhase,
  spentForPhase,
  V7_DIR,
} from './budget7'
import { chargeRegles, SUJETS, type Sujet } from './v7-sujets'
import { jointure, mesureSvg, partNeutreRendu, regionsCouleur, renduSvg, renduSvgSurNeutre, extraitSvg, type MesureSvg, type RegionCouleur } from './v7-lib'
import { choisis, decisionGlyphes, decisionSujet, gardes, normalise, score, type Critique, type Garde } from './v7-gardes'
import type { SortieDa, Piste } from './v7-da'
import { geminiMultimodal, type GeminiPart } from '../../src/lib/ai/gemini'
import { visionJson } from './v7-vision'

installBudgetGuard()
setPhase('p3-svg')

const args = process.argv.slice(2)
const fresh = args.includes('--fresh')
const valeur = (nom: string): string | null => {
  const i = args.indexOf(nom)
  return i >= 0 ? (args[i + 1] ?? null) : null
}
const TOURS_MAX = Number(valeur('--tours') ?? '8')
const filtre = valeur('--sujets')
const sujets = filtre ? SUJETS.filter((s) => filtre.split(',').includes(s.id)) : SUJETS

const MODELE_TRACEUR = 'gemini-3.1-pro-preview'
const MODELE_JUGE = 'gemini-3.5-flash'
const MAX_TOKENS = 28000

const regles = chargeRegles()
const b = regles.bornes

/*
 * L'échelle de composition, dérivée du corpus : le plus grand côté de la marque
 * couvre `cote_marque_cadre` du cadre. Elle sert DEUX fois — ici, pour mesurer la
 * lisibilité de la marque telle qu'elle sera composée, et en phase 5 pour la
 * poser. Mesurer la lisibilité sur un SVG cadré autrement mesurerait autre chose
 * que le livrable.
 */
const COTE_CIBLE = b.cote_marque_cadre.mediane

/*
 * Le plancher d'accent : p10 de la distribution mesurée des parts d'accent des
 * 36 pièces du corpus à deux couleurs ou plus. Calculé une fois, écrit ici en
 * constante avec sa provenance — le champ n'existe pas dans corpus-regles.json
 * parce qu'il ne se calcule que sur le sous-ensemble bicolore.
 *   p10 0,0881 · p25 0,2028 · médiane 0,4663 · p75 0,7704
 *   black-world1 (la cible de NOX) : 0,136 — sous le p25, au-dessus du p10.
 */
const ACCENT_MIN = 0.088

// ─── La critique de forme (avis, pas verdict) ────────────────────────────────

/*
 * ⚠ Aucun commentaire `//` dans ce gabarit, et c'est la raison d'être de cette
 * note. La première version en portait un par champ, pour être claire ; le
 * modèle les RECOPIAIT dans sa réponse, ce qui donne un JSON invalide, donc un
 * `null`, donc une critique muette à chaque tour — et `formeOk` restant faux, la
 * boucle ne pouvait PAS converger, quoi que le traceur produise. Les champs se
 * décrivent en prose au-dessus du gabarit.
 */
const CONSIGNE_JUGE = `The image is a side-by-side montage. LEFT is a candidate logo mark, freshly traced in vector curves. RIGHT is the reference piece it must be able to hang next to. Below the candidate, the same candidate shown at 64 pixels wide.

You are a draughtsman inspecting curves, not a critic judging taste. Report only what is drawn.

What each field means:
- courbes_propres: are the outlines smooth — no kink where two curve segments meet, no flat facet where a curve is expected, no wobble.
- epaisseur_constante: does the weight of the form stay even along its length. A deliberate, smooth taper is fine; a random bulge is not.
- nb_elements: how many separated shapes the candidate is made of. Touching or cut-out parts count as one.
- nb_couleurs: distinct colours in the candidate mark.
- lisible_a_64px: at the small size shown below, is it still the same shape.
- ecart_principal_en_une_phrase: the single biggest difference between candidate and reference, one short sentence, naming a geometric fact.

Return this JSON and nothing else, with no comments inside it:
{"courbes_propres": true, "epaisseur_constante": true, "nb_elements": 1, "nb_couleurs": 2, "lisible_a_64px": true, "ecart_principal_en_une_phrase": "..."}`

async function critique(montage: Buffer): Promise<Critique | null> {
  const r = await visionJson<Critique>({
    model: MODELE_JUGE,
    imageBase64: montage.toString('base64'),
    mimeType: 'image/jpeg',
    prompt: CONSIGNE_JUGE,
    maxOutputTokens: 1600,
  })
  if (!r.valeur) console.log(`        ⚠ critique illisible (${r.raison}) · brut de ${r.brut.length} car. : ${r.brut.slice(0, 400)}`)
  return r.valeur
}

/*
 * La TRANSCRIPTION des glyphes. Le modèle ne reçoit JAMAIS le mot attendu — c'est
 * la faute exacte du run 5.8, où l'OCR lisait le mot espéré au lieu des lettres
 * dessinées et validait « FRU VTZ ». On demande ce qui est lu, le code compare.
 */
const CONSIGNE_GLYPHES = `Look at this mark. It may contain letters, or none at all.

Transcribe EVERY letter you can actually READ in it. Judge the drawn shapes, not what a brand might be called: if a shape only vaguely suggests a letter, do not report it. If you can read no letters, return an empty array.

Return this JSON and nothing else: {"lettres": ["A", "B"], "lecture_en_un_coup_d_oeil": "what a stranger would say this reads as, in three words or fewer"}`

async function litGlyphes(png: Buffer): Promise<{ lettres: string[]; lecture_en_un_coup_d_oeil: string } | null> {
  const jpg = await sharp(png).flatten({ background: '#3a3a3a' }).jpeg({ quality: 92 }).toBuffer()
  const r = await visionJson<{ lettres: string[]; lecture_en_un_coup_d_oeil: string }>({
    model: MODELE_JUGE,
    imageBase64: jpg.toString('base64'),
    mimeType: 'image/jpeg',
    prompt: CONSIGNE_GLYPHES,
    maxOutputTokens: 900,
  })
  if (!r.valeur) console.log(`        ⚠ lecture illisible (${r.raison}) · brut de ${r.brut.length} car. : ${r.brut.slice(0, 400)}`)
  return r.valeur
}

/*
 * La NOMINATION du sujet. Meme dispositif que la lecture des glyphes : le modele
 * ne recoit jamais la reponse attendue, il NOMME ce qu'il voit, et le code
 * tranche sur le nom avec un lexique de mots qui ne designent aucun sujet.
 * Ne s'applique qu'aux emblemes purs : sur un monogramme, la garde de glyphes est
 * deja la garde semantique.
 */
const CONSIGNE_SUJET = `Look at this shape. Name what it DEPICTS, in one or two words - the thing a stranger would say it is.

Judge only the drawn shape. If it depicts nothing you can name, answer exactly "nothing". Do not invent a meaning, do not guess a brand, do not describe the geometry unless geometry is genuinely all there is.

Return this JSON and nothing else: {"nom": "...", "sur_de_soi": true}`

async function litSujet(png: Buffer): Promise<{ nom: string; sur_de_soi: boolean } | null> {
  const jpg = await sharp(png).flatten({ background: '#3a3a3a' }).jpeg({ quality: 92 }).toBuffer()
  const r = await visionJson<{ nom: string; sur_de_soi: boolean }>({
    model: MODELE_JUGE,
    imageBase64: jpg.toString('base64'),
    mimeType: 'image/jpeg',
    prompt: CONSIGNE_SUJET,
    maxOutputTokens: 700,
  })
  if (!r.valeur) console.log(`        ! nomination illisible (${r.raison}) : ${r.brut.slice(0, 300)}`)
  return r.valeur
}

/** Le montage candidat | cible, plus la vignette 64 px sous le candidat. */
async function montageCoteACote(svgNorm: string, cibleChemin: string): Promise<Buffer> {
  const cand = await renduSvgSurNeutre(svgNorm, 512, '#3a3a3a')
  const petit = await sharp(await renduSvg(svgNorm, 64))
    .flatten({ background: '#3a3a3a' })
    .resize(128, 128, { kernel: 'nearest' })
    .png()
    .toBuffer()
  const cible = await sharp(cibleChemin).resize(512, 512, { fit: 'cover' }).png().toBuffer()
  return sharp({ create: { width: 1024, height: 660, channels: 3, background: '#1b1b1b' } })
    .composite([
      { input: cand, left: 0, top: 0 },
      { input: cible, left: 512, top: 0 },
      { input: petit, left: 192, top: 520 },
    ])
    .jpeg({ quality: 90 })
    .toBuffer()
}

// ─── Le traceur ──────────────────────────────────────────────────────────────

function systemeTraceur(nbElementsMax: number, nbCouleursMax: number, palette: string[]): string {
  return `You are a vector draughtsman. You draw logo marks by hand in SVG, the way a designer draws with the pen tool. You do not paint, you do not render, you do not describe: you emit path data.

HARD RULES. Code checks every one of them on your output and throws the answer away if one breaks:

  1. Root exactly: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  2. <path> elements only. No <rect>, <circle>, <ellipse>, <polygon>, <line>.
  3. No <text>, no <tspan>, no font-family. Letters are TRACED as outlines — you write their contours yourself.
  4. No <linearGradient>, no <radialGradient>, no url(#...), no <filter>, no blur, no drop shadow, no opacity below 1. Flat fills only.
  5. No stroke at all. Every shape is a filled contour. The corpus median carries no outline; a keyline would be measured and rejected.
  6. At most ${nbCouleursMax} colour${nbCouleursMax > 1 ? 's' : ''}, and only these, spelled exactly: ${palette.join(' and ')}.
  7. At most ${nbElementsMax} SEPARATED shape${nbElementsMax > 1 ? 's' : ''}. Parts that touch, overlap, or are cut out of one another count as ONE — code counts the connected components of your rendered result, so a shape whose pieces meet is one shape. Use fill-rule="evenodd" on a single path to cut counters and holes.

CRAFT — this is what separates a traced mark from a generated one:

  * Continuous tangents. Where two cubic segments meet at an anchor, the incoming control point, the anchor and the outgoing control point are COLINEAR. Write the coordinates so this holds. A kink at a join is the single most visible amateur tell.
  * Even weight. The arm of a letter, the limb of a shape, keeps the same visual thickness along its length. If you taper, taper smoothly and on purpose.
  * Extremes on the axes. Put your anchors at the topmost, bottommost, leftmost and rightmost points of each curve, on horizontal or vertical tangents. Two segments per quarter turn at most.
  * Survive at 64 pixels. No feature thinner than 20 user units. A notch of 6 units does not exist at 64 pixels; it becomes grey mud.
  * IT MUST DEPICT SOMETHING. A stranger will be asked to name what your shape is. "Nothing", "an abstract shape", "an octagon inside a circle" all fail, and code checks the answer against a list of words that name no subject. Conformity is not a design: a compliant shape that means nothing is rejected.
  * THE SECOND COLOUR IS AN AREA, NOT A CONFETTI. If you use two colours, the smaller one must cover at least ${ACCENT_MIN} of the mark's ink — measured on the corpus, the reference for this brief carries 0.136. A 4% chip reads as a leftover, not a decision.
  * AND IT MUST AFFLEURE THE EDGE. Every colour of your mark must touch the outer boundary of the silhouette somewhere, the way the cyan lobe of the reference bites into its lower right edge. An island of one colour sitting in the middle of a field of the other is rejected in code.
  * MASS. Your mark's own ink must fill at least ${b.taux_remplissage_boite.p25} of its bounding box — the corpus median is ${b.taux_remplissage_boite.mediane}. This is measured in code and it is the one bound that is not about hygiene: heavy, compact, load-bearing forms. A ring crossed by a bar is clean, conformant, and does not belong to this corpus. Solid over outlined, thick over thin, one mass over an arrangement.
  * Fill the frame. The mark's longest side spans roughly ${Math.round(COTE_CIBLE * 512)} of the 512 units, centred.

OUTPUT FORMAT, nothing else:
PLAN: two sentences on how you laid out the geometry — the axis, the proportions, where the cuts fall.
<svg ...>...</svg>`
}

function premierTour(s: Sujet, piste: Piste): string {
  const forme = piste.reduction?.forme_reduite || piste.forme
  return [
    s.lettrage
      ? `The mark is a MONOGRAM for a FiveM / GTA RP server named "${s.nom}", built on the letters ${s.lettrage.split('').join('-')}. No other lettering anywhere.`
      : `The mark is an EMBLEM for a FiveM / GTA RP server named "${s.nom}". Zero lettering: not one letter in the shape.`,
    ``,
    `THE SHAPE TO TRACE, as the art direction settled it after its reduction pass:`,
    `  ${forme}`,
    ``,
    `HOW TO LAY IT OUT:`,
    `  ${piste.construction_geometrique}`,
    ``,
    s.lettrage === null
      ? `THE SUBJECT of this mark is: ${piste.reduction?.sujet ?? piste.sujet}. A stranger will be asked to name what your shape depicts, and their answer must name that thing. A shape that reads as pure geometry fails.`
      : ``,
    s.lettrage
      ? `A stranger will be asked which letters they read in your mark. Every one of ${s.lettrage.split('').join(', ')} must be readable, and no other letter may appear. A letter buried inside another shape until it is unrecognisable fails this — code compares the transcription to the expected set.`
      : `A stranger will be asked which letters they read in your mark. The answer must be NONE. Any shape that reads as a letter fails.`,
    ``,
    `The attached image is the REFERENCE piece this mark must be able to hang next to. Match its level of decision-making: count how few decisions it contains. Do not copy its subject.`,
    ``,
    `Trace it.`,
  ].join('\n')
}

function tourDeCorrection(gardesEchouees: Garde[], c: Critique | null, svgPrecedent: string, m: MesureSvg): string {
  const lignes: string[] = []
  lignes.push(`Your previous SVG was measured. Here is what failed, quoted from the measuring code:`)
  for (const g of gardesEchouees) {
    lignes.push(`  FAILED [${g.nom}] — measured: ${g.mesure} · required: ${g.attendu}`)
  }
  if (c) {
    lignes.push(``)
    lignes.push(`A draughtsman looked at the render next to the reference and reported:`)
    lignes.push(`  clean curves: ${c.courbes_propres} · even weight: ${c.epaisseur_constante} · still readable at 64px: ${c.lisible_a_64px}`)
    lignes.push(`  biggest gap to the reference: ${c.ecart_principal_en_une_phrase}`)
  }
  lignes.push(``)
  lignes.push(
    `Measured facts about your previous answer: ${m.analyse.nbPaths} path(s), ${m.nbElements} connected component(s), ` +
      `${m.nbCouleursRendu} colour(s) at ${m.couleursRendu.map((x: { hex: string }) => x.hex).join(' / ')}, ` +
      `ink covering ${m.encre512} of the frame, IoU between the 512px and the 64px render ${m.iou64}.`
  )
  lignes.push(``)
  lignes.push(`The montage attached shows your render on the left, the reference on the right, and your mark at 64 pixels below.`)
  lignes.push(``)
  lignes.push(`Your previous SVG, to correct rather than restart — keep what works:`)
  lignes.push(svgPrecedent)
  lignes.push(``)
  lignes.push(`Emit the corrected SVG in the same output format.`)
  return lignes.join('\n')
}

async function trace(
  s: Sujet,
  piste: Piste,
  palette: string[],
  tour: number,
  correction: { texte: string; montage: Buffer } | null
): Promise<{ svg: string; plan: string } | null> {
  const parts: GeminiPart[] = []
  if (correction) {
    parts.push({ text: 'MONTAGE — your previous render (left), the reference (right), your mark at 64 pixels (below):' })
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: correction.montage.toString('base64') } })
    parts.push({ text: correction.texte })
  } else {
    parts.push({ text: `REFERENCE — "${s.cible}", the piece this mark must hang next to:` })
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: await jointure(s.cibleChemin, 768, 88) } })
    parts.push({ text: premierTour(s, piste) })
  }

  let finish = ''
  const brut = await geminiMultimodal({
    model: MODELE_TRACEUR,
    parts,
    systemInstruction: systemeTraceur(b.nb_elements_max, b.nb_couleurs_max, palette),
    temperature: tour === 1 ? 0.6 : 0.35,
    maxOutputTokens: MAX_TOKENS,
    // Tour 1 en raisonnement élevé (la géométrie se conçoit), corrections en
    // moyen : une correction part d'une géométrie existante, et le raisonnement
    // est facturé au prix de la sortie — huit tours en « high » ne tiennent pas
    // dans le plafond de phase.
    thinkingLevel: tour === 1 ? 'high' : 'medium',
    onFinishReason: (r) => {
      finish = r
    },
  })
  const svg = extraitSvg(brut)
  if (!svg) {
    console.log(
      `      ⚠ aucun bloc <svg> dans la réponse` +
        (finish === 'MAX_TOKENS' ? ' — TRONQUÉ (finishReason MAX_TOKENS)' : ` (finishReason ${finish || 'inconnu'})`) +
        ` : ${brut.slice(0, 200)}`
    )
    return null
  }
  const plan = (brut.match(/PLAN\s*:\s*([^\n]*(?:\n(?!<svg)[^\n]*)*)/i)?.[1] ?? '').trim()
  return { svg, plan }
}

// ─── Un tour complet ─────────────────────────────────────────────────────────

type Etat = {
  tour: number
  svg: string
  svgNormalise: string
  plan: string
  mesure: MesureSvg
  gardes: Garde[]
  critique: Critique | null
  lecture: { lettres: string[]; lecture_en_un_coup_d_oeil: string } | null
  nomination: { nom: string; sur_de_soi: boolean } | null
  partNeutre: number | null
  regions: RegionCouleur[]
  score: number
  passe: boolean
}

// ─── Boucle par sujet ────────────────────────────────────────────────────────

console.log(`\n═══ PHASE 3 — LA MARQUE EN SVG (zéro appel image) ═══`)
console.log(`  traceur ${MODELE_TRACEUR} · juge de forme ${MODELE_JUGE}`)
console.log(`  bornes : ${b.nb_elements_max} élément(s) · ${b.nb_couleurs_max} couleur(s) · contour ${b.contour} · côte cible ${COTE_CIBLE}`)
console.log(`  plafond de phase ${PLAFONDS_PHASE['p3-svg']!.toFixed(2)} € · déjà dépensé ${spentForPhase('p3-svg').toFixed(4)} €\n`)

const PART_PAR_SUJET = PLAFONDS_PHASE['p3-svg']! / Math.max(1, sujets.length)

for (const s of sujets) {
  const dossier = join(V7_DIR, 'svg', s.id)
  mkdirSync(dossier, { recursive: true })
  const finalSvg = join(dossier, 'mark.svg')
  if (existsSync(finalSvg) && !fresh) {
    console.log(`  ${s.id} : déjà tracé (${finalSvg}) — --fresh pour rejouer.`)
    continue
  }

  const cheminDa = join(V7_DIR, `da-${s.id}.json`)
  if (!existsSync(cheminDa)) {
    console.log(`  ✗ ${s.id} : pas de sortie DA (${cheminDa}) — phase 2 non jouée pour ce sujet.`)
    continue
  }
  const da = JSON.parse(readFileSync(cheminDa, 'utf-8')) as SortieDa
  /*
   * La piste retenue est RECALCULÉE, jamais lue telle quelle. La règle de
   * sélection est du code ; la faire évoluer ne doit pas coûter un appel de DA.
   * Vécu cette session : la garde de conformité de palette a été ajoutée APRÈS
   * la phase 2, et elle change la piste retenue pour VULCAIN — sans recalcul il
   * aurait fallu repayer le DA pour en tenir compte.
   */
  const verdict = choisis(da.pistes, b.nb_elements_max, b.nb_couleurs_max, b.palette_marque)
  if (verdict.index !== da.choisie.index) {
    console.log(
      `  ↻ ${s.id} : piste recalculée — ${da.choisie.index + 1} (« ${da.pistes[da.choisie.index]?.nom} », règle de la phase 2) → ${verdict.index + 1} (« ${da.pistes[verdict.index]?.nom} », règle courante : ${verdict.motif})`
    )
  }
  if (verdict.hors_bornes.length) {
    console.log(`  ⚠ ${s.id} : aucune piste dans les bornes — ${verdict.hors_bornes.join(' ; ')}`)
  }
  const piste = da.pistes[verdict.index]!
  const palette = (piste.reduction?.palette_hex ?? []).map((c) => c.toLowerCase()).slice(0, b.nb_couleurs_max)
  if (!palette.length) {
    console.log(`  ✗ ${s.id} : palette vide dans la sortie DA.`)
    continue
  }

  setBudgetLabel(`p3-svg-${s.id}`)
  const depenseDepart = spentForPhase('p3-svg')
  console.log(`  ── ${s.nom} · piste « ${piste.nom} » · palette ${palette.join(' + ')} ──`)
  console.log(`     forme : ${piste.reduction?.forme_reduite || piste.forme}`)

  let meilleur: Etat | null = null
  let correction: { texte: string; montage: Buffer } | null = null
  const historique: Array<Omit<Etat, 'svg' | 'svgNormalise'>> = []

  for (let tour = 1; tour <= TOURS_MAX; tour += 1) {
    const restant = PART_PAR_SUJET - (spentForPhase('p3-svg') - depenseDepart)
    if (restant < 0.13) {
      console.log(`     ⛔ part de budget du sujet épuisée (${restant.toFixed(4)} € restants, un appel de traceur en demande 0,13) — sortie au tour ${tour - 1}`)
      break
    }

    let ecrit: { svg: string; plan: string } | null = null
    try {
      ecrit = await trace(s, piste, palette, tour, correction)
    } catch (err) {
      if (err instanceof PhaseBudgetError) {
        console.log(`     ⛔ ${err.message}`)
        break
      }
      console.log(`     ⚠ tour ${tour} : appel en échec — ${(err as Error).message}`)
      continue
    }
    if (!ecrit) continue

    const svgNorm = (await normalise(ecrit.svg, COTE_CIBLE)) ?? ecrit.svg
    const mesure = await mesureSvg(svgNorm)
    writeFileSync(join(dossier, `tour-${tour}.svg`), svgNorm)
    let rendu512: Buffer | null = null
    let rendu512Alpha: Buffer | null = null
    if (mesure.parse) {
      rendu512Alpha = await renduSvg(svgNorm, 512)
      rendu512 = await renduSvgSurNeutre(svgNorm, 512, '#3a3a3a')
      await sharp(rendu512).png().toFile(join(dossier, `tour-${tour}.png`))
    }
    const partNeutre = rendu512Alpha ? await partNeutreRendu(rendu512Alpha) : null
    const regions: RegionCouleur[] = rendu512Alpha ? await regionsCouleur(rendu512Alpha) : []
    const gardesTour = gardes(
      mesure,
      palette,
      b.nb_elements_max,
      b.nb_couleurs_max,
      b.palette_marque,
      b.contour,
      b.taux_remplissage_boite.p25,
      ACCENT_MIN,
      regions
    )

    // La lecture des glyphes — mesure du modèle, décision du code.
    let lecture: { lettres: string[]; lecture_en_un_coup_d_oeil: string } | null = null
    if (rendu512) {
      try {
        lecture = await litGlyphes(rendu512)
      } catch (err) {
        if (err instanceof PhaseBudgetError) console.log(`     ⛔ lecture refusée : ${err.message}`)
        else console.log(`     ⚠ lecture en échec : ${(err as Error).message}`)
      }
    }
    if (rendu512 && lecture === null) {
      console.log(`     ⚠ lecture des glyphes indisponible — la garde ne prononce pas sur ce tour`)
    }
    // La nomination du sujet - embleme pur seulement.
    let nomination: { nom: string; sur_de_soi: boolean } | null = null
    if (rendu512 && s.lettrage === null) {
      try {
        nomination = await litSujet(rendu512)
      } catch (err) {
        if (err instanceof PhaseBudgetError) console.log(`     STOP nomination refusee : ${err.message}`)
        else console.log(`     ! nomination en echec : ${(err as Error).message}`)
      }
    }

    const dg = decisionGlyphes(lecture?.lettres ?? [], s.lettrage)
    gardesTour.push({
      nom: 'glyphes',
      // Sans lecture (appel en échec), la garde ne prononce pas : elle passe et
      // c'est tracé. Un instrument muet ne doit pas se transformer en verdict.
      passe: lecture === null ? true : dg.passe,
      mesure: lecture === null ? 'lecture indisponible — garde neutralisée' : dg.detail,
      attendu: s.lettrage ? `exactement les lettres ${s.lettrage.split('').join('-')}` : 'au plus une forme-de-lettre (zéro LETTRAGE)',
    })
    /*
     * `sujet_lisible` est MESURÉ et RAPPORTÉ, il ne décide pas — et c'est un
     * calibrage qui l'a tranché, pas une intuition (`v7-calibre-sujet.ts`,
     * 0,004 €, six pièces de verdict connu) :
     *
     *   black-world1 → « letter B »  passe ✓      vulcainlogo → « letter V »  passe ✓
     *   pnl-rp-v2-4  → « visage »    passe ✓      aplat orange → « nothing »  échoue ✓
     *   valesia-rp1  → « nothing »   ÉCHOUE ✗ alors que c'est la pièce la plus
     *                  typique du corpus sur neuf axes mesurés.
     *
     * Cinq verdicts sur six. Le sixième suffit à disqualifier la garde : le corpus
     * contient des marques ABSTRAITES légitimes — un ruban, une volute — et la
     * nommabilité ne sépare donc pas le bon du mauvais. En garde dure, elle
     * refuserait l'exemplaire canonique n°1.
     *
     * Ce qui sépare, mesuré sur les mêmes pièces : la DOMINANCE DU NEUTRE.
     * valesia 0,693 · candidat NOX 0,872 · aplat orange 0,249, plancher 0,424.
     * La garde reste donc `dominance_neutre` ; la nomination est archivée à côté
     * pour que la prochaine session sache que la piste sémantique a été essayée,
     * réfutée, et à quel prix.
     */
    if (s.lettrage === null) {
      const ds = decisionSujet(nomination?.nom)
      console.log(`        sujet nommé (mesure, PAS une garde — calibrage 5/6) : ${ds.detail}`)
    }
    const echouees = gardesTour.filter((g) => g.passe === false)

    let c: Critique | null = null
    let montage: Buffer | null = null
    if (mesure.parse) {
      montage = await montageCoteACote(svgNorm, s.cibleChemin)
      await sharp(montage).toFile(join(dossier, `tour-${tour}-montage.jpg`))
      try {
        c = await critique(montage)
      } catch (err) {
        if (err instanceof PhaseBudgetError) console.log(`     ⛔ critique refusée : ${err.message}`)
        else console.log(`     ⚠ critique en échec : ${(err as Error).message}`)
      }
    }

    /*
     * Une critique indisponible ne PRONONCE pas — même principe que la garde de
     * glyphes. Ça a été appris à la dure ce tour-ci : avec `formeOk = false` sur
     * critique nulle, un gabarit JSON fautif rendait la convergence
     * mathématiquement impossible, sans que rien ne le dise dans le journal.
     * Un instrument muet est un instrument absent, pas un verdict négatif — mais
     * il est ÉCRIT, à chaque tour, pour qu'on ne lise pas un « tout passe »
     * comme un « tout a été vérifié ».
     */
    if (mesure.parse && c === null) {
      console.log(`     ⚠ critique de forme indisponible — courbes et épaisseur NON vérifiées sur ce tour`)
    }
    const formeOk = c === null ? true : c.courbes_propres === true && c.epaisseur_constante === true
    const passe = echouees.length === 0 && formeOk
    const etat: Etat = {
      tour,
      svg: ecrit.svg,
      svgNormalise: svgNorm,
      plan: ecrit.plan,
      mesure,
      gardes: gardesTour,
      critique: c,
      lecture,
      nomination,
      partNeutre,
      regions,
      score: score(gardesTour, c, mesure),
      passe,
    }
    historique.push({ tour, plan: etat.plan, mesure, gardes: gardesTour, critique: c, lecture, nomination, partNeutre, regions, score: etat.score, passe })
    if (!meilleur || etat.score > meilleur.score) meilleur = etat

    console.log(
      `     tour ${tour} : ${gardesTour.filter((g) => g.passe).length}/${gardesTour.length} gardes` +
        ` · ${mesure.nbElements} élém · ${mesure.nbCouleursRendu} coul · IoU64 ${mesure.iou64} · masse ${mesure.masse}` +
        ` · courbes ${c?.courbes_propres ?? '?'} / épaisseur ${c?.epaisseur_constante ?? '?'}` +
        ` · lu « ${lecture?.lettres?.join('') ?? '?'} »` +
        (s.lettrage === null ? ` · nommé « ${nomination?.nom ?? '?'} »` : '') +
        ` · neutre ${partNeutre ?? '?'} · accent ${regions.length > 1 ? Math.min(...regions.map((r) => r.part)) : '—'}` +
        ` · score ${etat.score.toFixed(2)}${passe ? '  ✅ TOUT PASSE' : ''}`
    )
    if (echouees.length) console.log(`        échecs : ${echouees.map((g) => `${g.nom} (${g.mesure})`).join(' · ')}`)
    if (lecture) console.log(`        au premier coup d'œil : « ${lecture.lecture_en_un_coup_d_oeil} »`)
    if (c) console.log(`        écart cible : ${c.ecart_principal_en_une_phrase}`)

    if (passe) break

    correction = montage
      ? { texte: tourDeCorrection(echouees.length ? echouees : gardesTour.filter((g) => !g.passe), c, ecrit.svg, mesure), montage }
      : null
    // Sans montage (SVG non rasterisable), la correction part du texte seul.
    if (!correction) {
      const faux = echouees.length ? echouees : [{ nom: 'rendu', passe: false, mesure: `échec : ${mesure.erreurRendu}`, attendu: 'un SVG que librsvg trace' }]
      correction = { texte: tourDeCorrection(faux, null, ecrit.svg, mesure), montage: await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).jpeg().toBuffer() }
    }
  }

  if (!meilleur) {
    console.log(`     ✗ ${s.id} : aucun SVG exploitable en ${TOURS_MAX} tours.\n`)
    continue
  }

  writeFileSync(finalSvg, meilleur.svgNormalise)
  writeFileSync(join(dossier, 'mark-source.svg'), meilleur.svg)
  await sharp(await renduSvg(meilleur.svgNormalise, 1024)).png().toFile(join(dossier, 'mark-1024.png'))
  await sharp(await renduSvg(meilleur.svgNormalise, 64)).png().toFile(join(dossier, 'mark-64.png'))
  writeFileSync(
    join(dossier, 'boucle.json'),
    JSON.stringify(
      {
        sujet: s.id,
        piste: piste.nom,
        forme: piste.reduction?.forme_reduite ?? piste.forme,
        palette,
        bornes: { nb_elements_max: b.nb_elements_max, nb_couleurs_max: b.nb_couleurs_max, contour: b.contour, cote_cible: COTE_CIBLE },
        tours_joues: historique.length,
        tour_retenu: meilleur.tour,
        converge: meilleur.passe,
        cout_eur: Math.round((spentForPhase('p3-svg') - depenseDepart) * 10_000) / 10_000,
        historique,
      },
      null,
      2
    )
  )
  console.log(
    `     RETENU : tour ${meilleur.tour}/${historique.length} · ${meilleur.passe ? 'CONVERGÉ' : 'NON CONVERGÉ (meilleur état)'}` +
      ` · ${meilleur.gardes.filter((g) => g.passe).length}/${meilleur.gardes.length} gardes` +
      ` · ${(spentForPhase('p3-svg') - depenseDepart).toFixed(4)} €`
  )
  if (!meilleur.passe) {
    console.log(`        ce qui bloque encore : ${meilleur.gardes.filter((g) => !g.passe).map((g) => `${g.nom} (${g.mesure})`).join(' · ') || 'les gardes passent, la critique de forme non'}`)
  }
  console.log(`     → ${finalSvg}\n`)
}

console.log(`  dépensé phase 3 : ${spentForPhase('p3-svg').toFixed(4)} € / ${PLAFONDS_PHASE['p3-svg']!.toFixed(2)} €\n`)
