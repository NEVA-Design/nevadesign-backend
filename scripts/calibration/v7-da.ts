/*
 * Run 7 — PHASE 2 : direction artistique, raisonnement long, un appel par sujet.
 *
 * Ce que cette phase change par rapport aux six sessions précédentes : elle ne
 * produit AUCUN prompt d'image. Elle produit la description d'UNE forme, destinée
 * à un traceur — la phase 3 l'écrira en SVG. Le DA n'a plus à faire tenir une
 * matière, une lumière et un fond dans 120 mots.
 *
 * Et elle contient l'opération qui a manqué pendant six sessions : une PASSE DE
 * RÉDUCTION explicite. Pour chaque piste, le modèle liste ce qu'il RETIRE et
 * pourquoi, puis réécrit la phrase. Un graphiste enlève.
 *
 *   bun run scripts/calibration/v7-da.ts [--sujets nox,vulcain] [--fresh]
 *
 * Sélection : EN CODE, sur les bornes mesurées. Le modèle propose, il ne choisit
 * pas — c'est la pente qui a fait choisir, au run 6, le candidat qui se mesurait
 * le mieux plutôt que celui qui ressemblait à la cible.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  installBudgetGuard,
  PhaseBudgetError,
  PLAFONDS_PHASE,
  setBudgetLabel,
  setPhase,
  spentForPhase,
  V7_DIR,
} from './budget7'
import { blocBornes, chargeRegles, etiquetteCanonique, SUJETS, type Sujet } from './v7-sujets'
import { jointure } from './v7-lib'
import { choisis, violations, mots, type Piste, type Reduction, type Verdict } from './v7-gardes'

// Les types et la règle de sélection vivent dans `v7-gardes.ts` (module pur) —
// réexportés ici pour les phases qui lisent une sortie de DA.
export type { Piste, Reduction, Verdict }
import { geminiMultimodal, type GeminiPart } from '../../src/lib/ai/gemini'

installBudgetGuard()
setPhase('p2-da')

const args = process.argv.slice(2)
const fresh = args.includes('--fresh')
const valeur = (nom: string): string | null => {
  const i = args.indexOf(nom)
  return i >= 0 ? (args[i + 1] ?? null) : null
}
const filtre = valeur('--sujets')
const sujets = filtre ? SUJETS.filter((s) => filtre.split(',').includes(s.id)) : SUJETS

const MODELE = 'gemini-3.1-pro-preview'
/*
 * Piège n°13 et n°16 : en raisonnement élevé, maxOutputTokens borne le
 * RAISONNEMENT et la sortie sur le même budget. Le mandat impose 24000 minimum ;
 * on met 28000 et on lit finishReason, seul signal fiable de troncature.
 */
const MAX_TOKENS = 28000

mkdirSync(V7_DIR, { recursive: true })
const regles = chargeRegles()
const b = regles.bornes

export type SortieDa = {
  sujet: string
  modele: string
  genere_le: string
  tentatives: number
  pistes: Piste[]
  choisie: Verdict
  ce_que_la_cible_fait: string
}

// ─── Le gabarit ──────────────────────────────────────────────────────────────

const SYSTEME = `You are the art director of a small logo house whose only client base is FiveM / GTA RP server owners. You have one job in this task and it is not the usual one: you do NOT write prompts for an image model. You describe ONE SHAPE, precisely enough that a draughtsman can trace it in vector curves.

Everything you already know about lighting, materials, chrome, atmosphere and rendering is irrelevant here. A separate stage makes the background. You make the shape.

Three things decide whether your work is any good:
  1. The shape reads at 64 pixels. Anything that needs 300 pixels to be seen does not exist.
  2. The shape obeys the measured bounds of the real corpus, which are hard limits enforced in code afterwards. A track that breaks them is discarded without being looked at.
  3. The shape is ONE idea. Not a good idea plus a supporting idea.

Then you do the operation that separates a designer from a generator: you REMOVE. For each track you list what you take out and why, and you rewrite the sentence shorter. You are not allowed to add anything during the reduction pass.

One thing you may never remove: THE SUBJECT. A mark depicts something - a wing, an anvil, a mountain, a letterform. Removing the three notches that made a shape a volcano leaves a semi-circle on a trapezoid: shorter, simpler, and meaningless. That reduction is rejected by code, which compares the subject you declare before and after.

Answer in JSON only. Write in English.`

function gabarit(s: Sujet): string {
  const sujetBloc = s.lettrage
    ? `SUBJECT — a server named "${s.nom}". The mark is a MONOGRAM built on the letters ${s.lettrage.split('').join('-')}. No other lettering, no tagline, no second line.`
    : `SUBJECT — a server named "${s.nom}". The mark is an EMBLEM ONLY: zero lettering, not a single letter anywhere in the shape.`

  return `${sujetBloc}

${blocBornes(b)}

COLOUR — measured, not chosen by taste. ${Math.round(b.palette_marque.part_neutre * 100)}% of the ${b.palette_marque.entrees} palette entries of the real corpus are NEUTRAL (white, grey, near-white; dominant ${b.palette_marque.neutre_dominant}). At least ONE of your colours must be neutral. Any saturated colour must sit in a hue family the corpus actually carries, measured in 30-degree bands: ${b.palette_marque.familles_accent.filter(([, n]) => n >= 4).map(([f, n]) => `${f}-${f + 30} degrees (${n} pieces)`).join(', ')}. Code checks this and discards a track that breaks it.

WHAT THE ATTACHED IMAGES ARE
The CANONICAL pieces are the ten pieces of the real corpus closest to its median on every measured axis at once. They are not the prettiest ones; they are the most typical ones. That is deliberate: the language you must speak is the median of this corpus, not its exception.
The TARGET is the single piece this mark has to be able to hang next to. Look at how few decisions it contains.

YOUR ANSWER — exactly this JSON shape:
{
  "ce_que_la_cible_fait": "one sentence: what the target achieves that a written description cannot capture",
  "pistes": [
    {
      "nom": "two or three words naming the track",
      "forme": "ONE sentence describing ONE shape. Geometry only: what is drawn, how the parts meet, where the negative space is. No mood, no material, no lighting, no background.",
      "sujet": "one or two words: what the shape DEPICTS. A wing, an anvil, a mountain, a letterform. Not a shape, not a circle, not a logo.",
      "nb_elements": <integer: how many SEPARATED shapes the mark is made of; parts that touch, overlap or are cut out of one another count as ONE>,
      "nb_couleurs": <integer: distinct mark colours, outline excluded>,
      "construction_geometrique": "how a draughtsman lays it out: the underlying grid or axis, the proportions, which strokes are straight and which are curved, where the cuts fall",
      "reduction": {
        "retire": ["each thing you remove from the sentence above", "..."],
        "pourquoi": "one sentence: why each removal makes the mark stronger at 64 pixels",
        "forme_reduite": "the sentence rewritten, shorter, after the removals. You may not add anything.",
        "sujet": "the same one or two words: what the shape STILL depicts after your removals. If your removals took the subject away, you removed the wrong thing - go back and remove something else.",
        "nb_elements": <integer, after reduction>,
        "nb_couleurs": <integer, after reduction>,
        "palette_hex": ["#rrggbb", ...] <exactly nb_couleurs entries, the mark colours, outline excluded; at least ONE must be neutral, and the neutral must be the DOMINANT area of the mark>
      }
    },
    ... exactly THREE tracks, describing three genuinely different shapes ...
  ]
}

Three tracks that are variations of the same shape count as one track and waste the brief.`
}

// ─── L'appel ─────────────────────────────────────────────────────────────────

async function appelle(s: Sujet, corrections: string[]): Promise<{ pistes: Piste[]; cible: string } | null> {
  const parts: GeminiPart[] = []

  for (let i = 0; i < regles.canoniques.length; i += 1) {
    const c = regles.canoniques[i]!
    parts.push({ text: etiquetteCanonique(c, i) })
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: await jointure(c.chemin, 512, 85) } })
  }
  parts.push({
    text: `TARGET — "${s.cible}", the one piece this mark must be able to hang next to. To the eye: ${s.cibleNote}.`,
  })
  parts.push({ inlineData: { mimeType: 'image/jpeg', data: await jointure(s.cibleChemin, 768, 88) } })

  let texte = gabarit(s)
  if (corrections.length) {
    texte += `\n\nYOUR PREVIOUS ANSWER WAS REJECTED BY THE CODE THAT CHECKS THE BOUNDS. Every track broke at least one hard bound. The exact failures, quoted:\n${corrections.map((c) => `  - ${c}`).join('\n')}\nFix these. Do not argue with the bounds, they come from the corpus you can see.`
  }
  parts.push({ text: texte })

  let finish = ''
  const brut = await geminiMultimodal({
    model: MODELE,
    parts,
    systemInstruction: SYSTEME,
    temperature: 0.7,
    maxOutputTokens: MAX_TOKENS,
    json: true,
    thinkingLevel: 'high',
    onFinishReason: (r) => {
      finish = r
    },
  })
  try {
    const parsed = JSON.parse(brut) as { pistes?: Piste[]; ce_que_la_cible_fait?: string }
    if (!Array.isArray(parsed.pistes) || parsed.pistes.length < 1) throw new Error('champ pistes absent ou vide')
    return { pistes: parsed.pistes, cible: parsed.ce_que_la_cible_fait ?? '' }
  } catch (err) {
    console.log(
      `    ⚠ JSON illisible : ${(err as Error).message}` +
        (finish === 'MAX_TOKENS'
          ? ' — TRONQUÉ (finishReason MAX_TOKENS, le raisonnement a mangé le budget de sortie)'
          : ` (finishReason ${finish || 'inconnu'})`) +
        `\n      ${brut.slice(0, 300)}`
    )
    return null
  }
}

// ─── Boucle ──────────────────────────────────────────────────────────────────

console.log(`\n═══ PHASE 2 — DIRECTION ARTISTIQUE ═══`)
console.log(`  modèle ${MODELE} · raisonnement élevé · maxOutputTokens ${MAX_TOKENS}`)
console.log(`  bornes : ${b.nb_elements_max} élément(s) max · ${b.nb_couleurs_max} couleur(s) max · contour ${b.contour} · trame ${b.trame}`)
console.log(`  ${regles.canoniques.length} exemplaires canoniques joints, + la cible du sujet`)
console.log(`  plafond de phase ${PLAFONDS_PHASE['p2-da']!.toFixed(2)} € · déjà dépensé ${spentForPhase('p2-da').toFixed(4)} €\n`)

for (const s of sujets) {
  const chemin = join(V7_DIR, `da-${s.id}.json`)
  if (existsSync(chemin) && !fresh) {
    console.log(`  ${s.id} : déjà présent (${chemin}) — --fresh pour rejouer.`)
    continue
  }
  setBudgetLabel(`p2-da-${s.id}`)
  console.log(`  ── ${s.nom} (${s.archetype}, cible ${s.cible}) ──`)

  let resultat: { pistes: Piste[]; cible: string } | null = null
  let verdict: Verdict | null = null
  let tentatives = 0
  let corrections: string[] = []

  // 2 tentatives : la 2e reçoit les violations CITÉES (piège n°4 — sans citation
  // du fragment fautif, le modèle répète la même faute).
  while (tentatives < 2) {
    tentatives += 1
    try {
      resultat = await appelle(s, corrections)
    } catch (err) {
      if (err instanceof PhaseBudgetError) {
        console.log(`    ⛔ ${err.message}`)
        break
      }
      console.log(`    ⚠ appel en échec : ${(err as Error).message}`)
      continue
    }
    if (!resultat) continue
    verdict = choisis(resultat.pistes, b.nb_elements_max, b.nb_couleurs_max, b.palette_marque)
    if (!verdict.hors_bornes.length) break
    corrections = resultat.pistes.flatMap((p, i) =>
      violations(p, b.nb_elements_max, b.nb_couleurs_max, b.palette_marque).map(
        (v) => `track ${i + 1} "${p.nom}" — ${v} · the offending sentence was: "${p.reduction?.forme_reduite ?? p.forme}"`
      )
    )
    console.log(`    tentative ${tentatives} : aucune piste dans les bornes, on rejoue avec les violations citées`)
  }

  if (!resultat || !verdict) {
    console.log(`    ✗ ${s.id} : pas de sortie DA exploitable.`)
    continue
  }

  const sortie: SortieDa = {
    sujet: s.id,
    modele: MODELE,
    genere_le: new Date().toISOString(),
    tentatives,
    pistes: resultat.pistes,
    choisie: verdict,
    ce_que_la_cible_fait: resultat.cible,
  }
  writeFileSync(chemin, JSON.stringify(sortie, null, 2))

  for (let i = 0; i < resultat.pistes.length; i += 1) {
    const p = resultat.pistes[i]!
    const v = violations(p, b.nb_elements_max, b.nb_couleurs_max, b.palette_marque)
    const marque = i === verdict.index ? '→' : ' '
    console.log(`   ${marque} piste ${i + 1} « ${p.nom} » — ${p.nb_elements}→${p.reduction?.nb_elements} élém, ${p.nb_couleurs}→${p.reduction?.nb_couleurs} coul${v.length ? ` · HORS BORNES : ${v.join(' ; ')}` : ''}`)
    console.log(`        avant   : ${p.forme}`)
    console.log(`        retiré  : ${(p.reduction?.retire ?? []).join(' · ')}`)
    console.log(`        après   : ${p.reduction?.forme_reduite}`)
  }
  console.log(`    RETENUE : piste ${verdict.index + 1} — ${verdict.motif}`)
  console.log(`    la cible, par le DA : ${resultat.cible}`)
  console.log(`    → ${chemin} · phase 2 : ${spentForPhase('p2-da').toFixed(4)} €\n`)
}

console.log(`  dépensé phase 2 : ${spentForPhase('p2-da').toFixed(4)} € / ${PLAFONDS_PHASE['p2-da']!.toFixed(2)} €\n`)
