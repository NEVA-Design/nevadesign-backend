/*
 * Run 7 — PHASE 5 : LA COMPOSITION, EN CODE. Zéro appel, zéro euro.
 *
 * C'est le point du pari où les deux moteurs se rejoignent. Le fond vient d'un
 * modèle d'image, la marque d'un rasteriseur vectoriel, et l'assemblage n'est
 * confié à personne : sharp pose des calques à des coordonnées calculées depuis
 * les bornes du corpus. Rien ici ne peut « rater » — c'est précisément l'intérêt.
 *
 *   bun run scripts/calibration/v7-compose.ts [--sujets nox,vulcain]
 *
 * Calques, dans l'ordre :
 *   1. le fond, ramené à 1024
 *   2. sa photométrie déjà amenée aux bornes en phase 4 — re-vérifiée ici
 *   3. l'ombre portée douce
 *   4. la marque SVG, dont le plus grand côté couvre la médiane mesurée du corpus
 *   5. la trame en surimpression SI la médiane du corpus en montre une
 *
 * Sur le calque 5, la mesure a tranché contre l'intuition de la session 6 :
 * `trame` vaut « none » sur 49 des 55 pièces mesurées. Il n'y a donc PAS de
 * surimpression. Le code du calque existe et reste inerte : c'est la borne qui
 * l'éteint, pas un oubli, et une autre mesure le rallumerait.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import sharp from 'sharp'
import { setPhase, V7_DIR } from './budget7'
import { chargeRegles, SUJETS, type Sujet } from './v7-sujets'
import { arrondi, boiteMasque, masqueOpacite, mesureFond, renduSvg, type Box2d } from './v7-lib'

setPhase('p5-compose')

const args = process.argv.slice(2)
const valeur = (nom: string): string | null => {
  const i = args.indexOf(nom)
  return i >= 0 ? (args[i + 1] ?? null) : null
}
const filtre = valeur('--sujets')
const sujets = filtre ? SUJETS.filter((s) => filtre.split(',').includes(s.id)) : SUJETS

const regles = chargeRegles()
const b = regles.bornes
const TAILLE = 1024

// ─── L'ombre portée ──────────────────────────────────────────────────────────

/*
 * Le seul calque de cette phase qui ne sort PAS d'une mesure : le corpus n'a pas
 * été interrogé sur l'ombre portée, elle est demandée par le mandat. Réglée bas
 * (flou 14 px, 45 % d'opacité, 10 px de décalage) et dite ici pour qu'on sache
 * quoi retirer si le verdict pointe cet endroit.
 */
async function ombrePortee(markPng: Buffer, taille: number): Promise<Buffer> {
  const alpha = await sharp(markPng).extractChannel('alpha').toBuffer()
  const noir = await sharp({ create: { width: taille, height: taille, channels: 3, background: '#000000' } })
    .png()
    .toBuffer()
  return sharp(noir)
    .joinChannel(alpha)
    .blur(14)
    .png()
    .toBuffer()
}

// ─── Le choix de la variante de fond, en code ────────────────────────────────

type Variante = { nom: string; chemin: string; meta: { plaque_nue: boolean | null; correction: { apres: { luminance: number; contraste: number; saturation: number } } } }

/**
 * La variante retenue est celle dont la photométrie est la plus proche de la
 * médiane du corpus, chaque écart divisé par l'écart interquartile de son axe.
 * Une plaque non nue (texte, marque ou sujet central détecté) prend une pénalité
 * qui la met hors course sans la supprimer — si les DEUX sont non nues, on
 * compose quand même la moins mauvaise et on le dit.
 */
function choisitVariante(variantes: Variante[]): { retenue: Variante; scores: Array<{ nom: string; score: number }> } {
  const iqr = (r: { p25: number; p75: number }) => Math.max(1e-4, r.p75 - r.p25)
  const scores = variantes.map((v) => {
    const a = v.meta.correction.apres
    let s =
      Math.abs(a.luminance - b.luminance_fond.mediane) / iqr(b.luminance_fond) +
      Math.abs(a.contraste - b.contraste_fond.mediane) / iqr(b.contraste_fond) +
      Math.abs(a.saturation - b.saturation_fond.mediane) / iqr(b.saturation_fond)
    if (v.meta.plaque_nue === false) s += 10
    return { nom: v.nom, score: arrondi(s, 4) }
  })
  const ordre = [...scores].sort((x, y) => x.score - y.score)
  return { retenue: variantes.find((v) => v.nom === ordre[0]!.nom)!, scores }
}

// ─── Composition ─────────────────────────────────────────────────────────────

console.log(`\n═══ PHASE 5 — COMPOSITION EN CODE (0 €) ═══`)
console.log(`  échelle : le plus grand côté de la marque couvre ${b.cote_marque_cadre.mediane} du cadre (médiane du corpus)`)
console.log(`  trame en surimpression : « ${b.trame} » → ${b.trame === 'none' ? 'AUCUNE (49 pièces sur 55 sans trame)' : b.trame}\n`)

for (const s of sujets) {
  const dossierFonds = join(V7_DIR, 'fonds', s.id)
  const markSvg = join(V7_DIR, 'svg', s.id, 'mark.svg')
  const sortie = join(V7_DIR, 'v7', s.id)
  mkdirSync(sortie, { recursive: true })

  if (!existsSync(markSvg)) {
    console.log(`  ✗ ${s.id} : pas de marque SVG (${markSvg}) — phase 3 non jouée.`)
    continue
  }

  const variantes: Variante[] = []
  for (const n of [1, 2]) {
    const chemin = join(dossierFonds, `fond-${n}.png`)
    const metaChemin = join(dossierFonds, `fond-${n}.json`)
    if (!existsSync(chemin) || !existsSync(metaChemin)) continue
    variantes.push({ nom: `fond-${n}`, chemin, meta: JSON.parse(readFileSync(metaChemin, 'utf-8')) })
  }
  if (!variantes.length) {
    console.log(`  ✗ ${s.id} : aucun fond disponible — phase 4 non jouée.`)
    continue
  }

  const { retenue, scores } = choisitVariante(variantes)
  console.log(`  ── ${s.nom} ── fond retenu ${retenue.nom} (scores : ${scores.map((x) => `${x.nom} ${x.score}`).join(' · ')})`)

  const svg = readFileSync(markSvg, 'utf-8')
  const marque = await renduSvg(svg, TAILLE)
  const ombre = await ombrePortee(marque, TAILLE)
  const fond = await sharp(retenue.chemin).resize(TAILLE, TAILLE, { fit: 'cover' }).png().toBuffer()

  const calques: Array<{ input: Buffer; left: number; top: number; blend: 'over' | 'overlay' }> = [
    { input: ombre, left: 0, top: 10, blend: 'over' },
    { input: marque, left: 0, top: 0, blend: 'over' },
  ]
  // Calque 5, inerte tant que la médiane du corpus vaut « none » (voir en-tête).
  if (b.trame !== 'none') {
    const trame = await trameSurimpression(b.trame, TAILLE)
    if (trame) calques.push({ input: trame, left: 0, top: 0, blend: 'overlay' })
  }

  const composee = await sharp(fond).composite(calques).png().toBuffer()
  await sharp(composee).png().toFile(join(sortie, 'v7-1024.png'))
  await sharp(composee).resize(64, 64, { fit: 'cover' }).png().toFile(join(sortie, 'v7-64.png'))

  // ── Mesures de contrôle sur le LIVRABLE, pas sur ses ingrédients ──
  const mMarque = await masqueOpacite(marque, 512)
  const boite = boiteMasque(mMarque)
  const box: Box2d | null = boite
    ? [Math.round(boite.y0 * 1000), Math.round(boite.x0 * 1000), Math.round(boite.y1 * 1000), Math.round(boite.x1 * 1000)]
    : null
  const fondFinal = await mesureFond(composee, box ?? undefined)
  const cadreEntier = await mesureFond(composee)

  // Le contraste marque/fond : la marque est-elle lisible là où elle est posée ?
  const lumMarque = await luminanceSousMasque(composee, mMarque, true)
  const lumDessous = await luminanceSousMasque(fond, mMarque, true)
  const contrasteMarqueFond = arrondi(Math.abs(lumMarque - lumDessous), 4)

  const dansBornes =
    fondFinal.luminance >= b.luminance_fond.p25 &&
    fondFinal.luminance <= b.luminance_fond.p75 &&
    fondFinal.contraste >= b.contraste_fond.p25 &&
    fondFinal.contraste <= b.contraste_fond.p75

  writeFileSync(
    join(sortie, 'compose.json'),
    JSON.stringify(
      {
        sujet: s.id,
        fond_retenu: retenue.nom,
        scores_variantes: scores,
        marque_svg: markSvg,
        echelle_cote: b.cote_marque_cadre.mediane,
        trame: b.trame,
        ombre_portee: { flou: 14, decalage_y: 10, source: 'mandat, pas une mesure' },
        boite_marque: boite,
        fond_hors_marque: fondFinal,
        cadre_entier: cadreEntier,
        luminance_marque: arrondi(lumMarque, 4),
        luminance_sous_la_marque: arrondi(lumDessous, 4),
        contraste_marque_fond: contrasteMarqueFond,
        fond_dans_les_bornes: dansBornes,
      },
      null,
      2
    )
  )

  console.log(`     fond hors marque : L ${fondFinal.luminance} · C ${fondFinal.contraste} · S ${fondFinal.saturation} → ${dansBornes ? 'DANS LES BORNES' : '⚠ HORS BORNES'}`)
  console.log(`     marque : L ${arrondi(lumMarque, 3)} sur un fond local à L ${arrondi(lumDessous, 3)} → contraste ${contrasteMarqueFond}`)
  console.log(`     boîte de la marque : ${boite ? `${arrondi((boite.x1 - boite.x0) * 100, 1)} % × ${arrondi((boite.y1 - boite.y0) * 100, 1)} % du cadre` : 'aucune'}`)
  console.log(`     → ${join(sortie, 'v7-1024.png')} + v7-64.png\n`)
}

// ─── Utilitaires ─────────────────────────────────────────────────────────────

/** Luminance moyenne des pixels du cadre situés SOUS le masque (ou hors). */
async function luminanceSousMasque(
  png: Buffer,
  masque: { w: number; h: number; m: Uint8Array },
  dedans: boolean
): Promise<number> {
  const { data } = await sharp(png)
    .resize(masque.w, masque.h, { fit: 'fill' })
    .flatten({ background: '#000000' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let somme = 0
  let n = 0
  for (let i = 0; i < masque.w * masque.h; i += 1) {
    if (Boolean(masque.m[i]) !== dedans) continue
    somme += (0.2126 * data[i * 3]! + 0.7152 * data[i * 3 + 1]! + 0.0722 * data[i * 3 + 2]!) / 255
    n += 1
  }
  return n ? somme / n : NaN
}

/**
 * La trame de surimpression, si un jour la borne du corpus en demande une.
 * Écrite parce qu'un calque prévu par le mandat et absent du code est un oubli
 * silencieux ; éteinte parce que la mesure dit « none ».
 */
async function trameSurimpression(type: string, taille: number): Promise<Buffer | null> {
  const pas = 6
  let motif = ''
  if (type === 'halftone') {
    for (let y = pas / 2; y < taille; y += pas) {
      for (let x = pas / 2; x < taille; x += pas) motif += `<circle cx="${x}" cy="${y}" r="1.2" fill="#ffffff"/>`
    }
  } else if (type === 'scanlines') {
    for (let y = 0; y < taille; y += pas) motif += `<rect x="0" y="${y}" width="${taille}" height="1.5" fill="#ffffff"/>`
  } else if (type === 'grille') {
    for (let y = 0; y < taille; y += pas * 3) motif += `<rect x="0" y="${y}" width="${taille}" height="1" fill="#ffffff"/>`
    for (let x = 0; x < taille; x += pas * 3) motif += `<rect x="${x}" y="0" width="1" height="${taille}" fill="#ffffff"/>`
  } else {
    return null
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${taille}" height="${taille}"><g opacity="0.10">${motif}</g></svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}
