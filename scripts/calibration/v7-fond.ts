/*
 * Run 7 — PHASE 4 : LE FOND SEUL. Un lieu, et rien d'autre.
 *
 * `gemini-3-pro-image` ne reçoit plus la marque, ni le nom du serveur, ni une
 * matière, ni une composition. Il reçoit un LIEU en une phrase et la consigne
 * photométrique mesurée au corpus. C'est la moitié du pari : un modèle d'image
 * peint très bien un décor ; c'est le lettrage qu'il rate.
 *
 *   bun run scripts/calibration/v7-fond.ts [--sujets nox,vulcain] [--fresh]
 *
 * Deux variantes par sujet, deux lieux différents. Le choix du lieu est écrit en
 * CODE, pas demandé au DA : c'est un décor, pas une identité, et un décor qui
 * sort d'un aller-retour de modèle coûte un appel pour rien.
 *
 * Rien n'est régénéré pour cause de photométrie. Un fond trop clair ou trop
 * contrasté se CORRIGE en sharp — une correction linéaire coûte 0 € et atteint
 * la borne exactement, là où une régénération coûte 0,139 € et retombe où le
 * modèle veut.
 *
 * ⚠ Aucune clause négative dans ces prompts (règle de la session, et leçon du
 * run 5.8 où « contour blanc épais » écrit en négation a été exécuté à la
 * lettre). Tout est demandé en positif, y compris le vide.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs'
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
import { arrondi, mesureFond, type MesureFond } from './v7-lib'
import { geminiImageEditRich } from '../../src/lib/ai/gemini'
import { visionJson } from './v7-vision'

installBudgetGuard()
setPhase('p4-fond')

const args = process.argv.slice(2)
const fresh = args.includes('--fresh')
const valeur = (nom: string): string | null => {
  const i = args.indexOf(nom)
  return i >= 0 ? (args[i + 1] ?? null) : null
}
const filtre = valeur('--sujets')
const sujets = filtre ? SUJETS.filter((s) => filtre.split(',').includes(s.id)) : SUJETS
const RESOLUTION = (valeur('--resolution') ?? '2K') as '1K' | '2K'

const MODELE_IMAGE = 'gemini-3-pro-image'
const MODELE_JUGE = 'gemini-3.5-flash'

const regles = chargeRegles()
const b = regles.bornes

/*
 * Les lieux. Deux par sujet, choisis dans le registre du corpus (scène nocturne
 * urbaine ou industrielle, vue de loin, hors mise au point) et accrochés au nom
 * du serveur sans jamais le nommer dans le prompt : NOX est la nuit, VULCAIN la
 * forge. Un décor ne porte pas l'identité, il la laisse respirer.
 */
const LIEUX: Record<string, [string, string]> = {
  nox: [
    'A distant city skyline at night, deep blue-black, seen far away and far out of focus.',
    // « deserted » et pas « empty » : au run 5.5 le verdict client était « fond
    // bleu nuit VIDE ». Le mot décrit ici un lieu désert, mais il a déjà été lu
    // par un modèle comme une consigne de vide — un synonyme coûte zéro.
    'A deserted rooftop parking deck at night, cold grey-blue, seen far out of focus.',
  ],
  vulcain: [
    'A dark foundry hall at night, deep charcoal, a faint ember warmth low in the depth, seen far out of focus.',
    'A basalt cliff face under a night sky, deep charcoal and slate, seen far out of focus.',
  ],
}

/*
 * La clause photométrique, écrite par le CODE depuis les bornes mesurées. C'est
 * la leçon du piège n°20 : ce qui est la DÉFINITION d'une contrainte ne se
 * demande pas à un modèle de texte, il s'écrit en dur. La luminance et le
 * contraste médians du corpus sont des nombres ; ils entrent dans le prompt
 * comme des nombres.
 */
function clausePhotometrique(): string {
  return (
    `The whole frame stays evenly dark and quiet: mean brightness around ${b.luminance_fond.mediane} on a 0 to 1 scale, ` +
    `variation across the frame around ${b.contraste_fond.mediane}, colour held gently at around ${b.saturation_fond.mediane} saturation. ` +
    `This is a bare background plate: the place alone, its detail dissolving into depth toward the middle of the frame, ready for a mark to be laid over it later. Square image.`
  )
}

function prompt(lieu: string): string {
  return `${lieu} ${clausePhotometrique()}`
}

// ─── La porte « plaque nue » ─────────────────────────────────────────────────

/* Pas de commentaire `//` dans le gabarit : le modèle les recopie et le JSON
 * devient illisible (constaté sur la critique de forme de la phase 3, où ça
 * bloquait la convergence de la boucle entière). Les champs se décrivent avant. */
const CONSIGNE_PLAQUE = `This image is meant to be a bare background plate for a logo composition: a place, out of focus, and nothing else.

What each field means:
- contient_du_texte: any letters, words, numbers or signage anywhere in the frame.
- contient_une_marque: any logo, emblem, badge or symbol.
- sujet_central: one object or figure clearly occupying the centre as the subject.
- lieu_lu: the place you see, five words or fewer.

Return this JSON and nothing else, with no comments inside it:
{"contient_du_texte": false, "contient_une_marque": false, "sujet_central": false, "lieu_lu": "..."}`

type Plaque = { contient_du_texte: boolean; contient_une_marque: boolean; sujet_central: boolean; lieu_lu: string }

async function porteePlaque(png: Buffer): Promise<Plaque | null> {
  const jpg = await sharp(png).resize(640, 640, { fit: 'inside' }).jpeg({ quality: 88 }).toBuffer()
  const r = await visionJson<Plaque>({
    model: MODELE_JUGE,
    imageBase64: jpg.toString('base64'),
    mimeType: 'image/jpeg',
    prompt: CONSIGNE_PLAQUE,
    maxOutputTokens: 900,
  })
  if (!r.valeur) console.log(`        ⚠ porte plaque illisible (${r.raison}) : ${r.brut.slice(0, 300)}`)
  return r.valeur
}

// ─── La correction photométrique, en sharp ───────────────────────────────────

export type Correction = {
  applique: boolean
  gainContraste: number
  decalage: number
  gainSaturation: number
  avant: MesureFond
  apres: MesureFond
  dansLesBornes: boolean
}

/**
 * Amène luminance, contraste et saturation dans les bornes du corpus, sans
 * jamais régénérer. Ordre : correction linéaire d'abord (elle déplace la
 * luminance ET le contraste), puis la saturation — l'inverse ferait dériver la
 * saturation par la correction linéaire, qui touche les trois canaux.
 *
 * La borne est un INTERVALLE [p25, p75] : on ne corrige que si on en sort, et on
 * vise la médiane. Corriger un fond déjà conforme, c'est aplatir une matière
 * pour faire bouger un chiffre — c'est le piège n°15 du run 6.
 */
export async function corrigePhotometrie(
  png: Buffer,
  bornes: { luminance: { p25: number; mediane: number; p75: number }; contraste: { p25: number; mediane: number; p75: number }; saturation: { p25: number; mediane: number; p75: number } }
): Promise<{ png: Buffer; correction: Correction }> {
  const avant = await mesureFond(png)
  const dedansL = avant.luminance >= bornes.luminance.p25 && avant.luminance <= bornes.luminance.p75
  const dedansC = avant.contraste >= bornes.contraste.p25 && avant.contraste <= bornes.contraste.p75
  const dedansS = avant.saturation >= bornes.saturation.p25 && avant.saturation <= bornes.saturation.p75

  if (dedansL && dedansC && dedansS) {
    return {
      png,
      correction: { applique: false, gainContraste: 1, decalage: 0, gainSaturation: 1, avant, apres: avant, dansLesBornes: true },
    }
  }

  const a = Math.max(0.35, Math.min(2.5, avant.contraste > 1e-4 ? bornes.contraste.mediane / avant.contraste : 1))
  const offset = (bornes.luminance.mediane - a * avant.luminance) * 255
  const kSat = Math.max(0.25, Math.min(2.2, avant.saturation > 1e-4 ? bornes.saturation.mediane / avant.saturation : 1))

  let pipe = sharp(png).linear(a, offset)
  if (!dedansS) pipe = pipe.modulate({ saturation: kSat })
  const corrige = await pipe.png().toBuffer()
  const apres = await mesureFond(corrige)

  return {
    png: corrige,
    correction: {
      applique: true,
      gainContraste: arrondi(a, 4),
      decalage: arrondi(offset, 2),
      gainSaturation: dedansS ? 1 : arrondi(kSat, 4),
      avant,
      apres,
      dansLesBornes:
        apres.luminance >= bornes.luminance.p25 &&
        apres.luminance <= bornes.luminance.p75 &&
        apres.contraste >= bornes.contraste.p25 &&
        apres.contraste <= bornes.contraste.p75,
    },
  }
}

// ─── La passe ────────────────────────────────────────────────────────────────

console.log(`\n═══ PHASE 4 — LE FOND SEUL ═══`)
console.log(`  ${MODELE_IMAGE} · ${RESOLUTION} · 2 variantes par sujet, un lieu chacune`)
console.log(`  bornes de fond : luminance ${b.luminance_fond.mediane} [${b.luminance_fond.p25} · ${b.luminance_fond.p75}] · contraste ${b.contraste_fond.mediane} [${b.contraste_fond.p25} · ${b.contraste_fond.p75}] · saturation ${b.saturation_fond.mediane} [${b.saturation_fond.p25} · ${b.saturation_fond.p75}]`)
console.log(`  plafond de phase ${PLAFONDS_PHASE['p4-fond']!.toFixed(2)} € · déjà dépensé ${spentForPhase('p4-fond').toFixed(4)} €\n`)

const bornesFond = {
  luminance: b.luminance_fond,
  contraste: b.contraste_fond,
  saturation: b.saturation_fond,
}

for (const s of sujets) {
  const dossier = join(V7_DIR, 'fonds', s.id)
  mkdirSync(dossier, { recursive: true })
  const lieux = LIEUX[s.id] ?? LIEUX.nox!
  console.log(`  ── ${s.nom} ──`)

  for (let v = 0; v < lieux.length; v += 1) {
    const nom = `fond-${v + 1}`
    const cible = join(dossier, `${nom}.png`)
    if (existsSync(cible) && !fresh) {
      console.log(`     ${nom} : déjà généré — --fresh pour rejouer.`)
      continue
    }
    setBudgetLabel(`p4-fond-${s.id}-${v + 1}`)
    const p = prompt(lieux[v]!)

    let brut: Buffer
    try {
      const res = await geminiImageEditRich({
        model: MODELE_IMAGE,
        prompt: p,
        imageConfig: { aspectRatio: '1:1', imageSize: RESOLUTION },
        thinkingLevel: 'high',
      })
      brut = Buffer.from(res.dataUrl.split(',')[1]!, 'base64')
    } catch (err) {
      if (err instanceof PhaseBudgetError) {
        console.log(`     ⛔ ${err.message}`)
        break
      }
      console.log(`     ⚠ ${nom} : génération en échec — ${(err as Error).message}`)
      continue
    }

    // Piège n°22 : une image payée touche le disque AVANT tout autre appel.
    await sharp(brut).png().toFile(join(dossier, `${nom}-brut.png`))

    const mille = await sharp(brut).resize(1024, 1024, { fit: 'cover' }).png().toBuffer()
    const { png: corrige, correction } = await corrigePhotometrie(mille, bornesFond)
    await sharp(corrige).png().toFile(cible)

    let plaque: Plaque | null = null
    try {
      plaque = await porteePlaque(corrige)
    } catch (err) {
      if (err instanceof PhaseBudgetError) console.log(`     ⛔ porte plaque refusée : ${err.message}`)
      else console.log(`     ⚠ porte plaque en échec : ${(err as Error).message}`)
    }

    const nue = plaque === null ? null : !plaque.contient_du_texte && !plaque.contient_une_marque && !plaque.sujet_central
    writeFileSync(
      join(dossier, `${nom}.json`),
      JSON.stringify({ sujet: s.id, variante: v + 1, lieu: lieux[v], prompt: p, resolution: RESOLUTION, correction, plaque, plaque_nue: nue }, null, 2)
    )

    console.log(
      `     ${nom} : L ${correction.avant.luminance}→${correction.apres.luminance} · C ${correction.avant.contraste}→${correction.apres.contraste} · S ${correction.avant.saturation}→${correction.apres.saturation}` +
        (correction.applique ? ` (gain ${correction.gainContraste}, décalage ${correction.decalage}, sat ${correction.gainSaturation})` : ' (déjà dans les bornes)') +
        ` · ${correction.dansLesBornes ? 'DANS LES BORNES' : '⚠ HORS BORNES après correction'}`
    )
    console.log(
      `        plaque : ${plaque === null ? 'non vérifiée' : `${nue ? 'NUE' : '⚠ NON NUE'} — texte ${plaque.contient_du_texte} · marque ${plaque.contient_une_marque} · sujet central ${plaque.sujet_central} · lu « ${plaque.lieu_lu} »`}`
    )
    console.log(`        ${spentForPhase('p4-fond').toFixed(4)} € / ${PLAFONDS_PHASE['p4-fond']!.toFixed(2)} €`)
  }
  console.log('')
}

console.log(`  dépensé phase 4 : ${spentForPhase('p4-fond').toFixed(4)} € / ${PLAFONDS_PHASE['p4-fond']!.toFixed(2)} €\n`)
