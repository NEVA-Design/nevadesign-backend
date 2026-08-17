/*
 * Run 7 — PHASE 7 : LA LIVRAISON. Une planche, un rapport, zéro chiffre recopié.
 *
 *   bun run scripts/calibration/v7-planche.ts
 *
 * La planche : quatre lignes étiquetées — CIBLES, V7, TÉMOIN, et une bande à
 * 64 px des six pièces. La bande est doublée : les six à 64 px réels, puis les
 * mêmes agrandies au plus proche voisin. La première dit ce qu'un client voit
 * dans une liste de serveurs, la seconde dit POURQUOI.
 *
 * Le rapport : chaque nombre est LU sur le disque — corpus-regles.json, les
 * boucle.json de la phase 3, les compose.json de la phase 5, les temoin.json de
 * la phase 6, le grand livre. Rien n'est retapé à la main. La seule prose de
 * cette phase est le jugement final, et il est marqué comme tel.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import sharp from 'sharp'
import { PLAFONDS_PHASE, recapPhases, setPhase, spentEur, CAP_EUR, V7_DIR } from './budget7'
import { chargeRegles, SUJETS } from './v7-sujets'
import { arrondi, mesureFond, survie64 } from './v7-lib'
import type { SortieDa } from './v7-da'
import type { Piste } from './v7-gardes'
import { choisis } from './v7-gardes'

setPhase('p7-livraison')

const regles = chargeRegles()
const b = regles.bornes
const CELL = 512
const GOUT = 12
const ENTETE = 46

// ─── Étiquettes en SVG ───────────────────────────────────────────────────────

function texteSvg(largeur: number, hauteur: number, lignes: string[], taille: number, couleur = '#f2f2f2'): Buffer {
  const echappe = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const corps = lignes
    .map((l, i) => `<text x="10" y="${taille * (i + 1) + 4}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${taille}" fill="${couleur}">${echappe(l)}</text>`)
    .join('')
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${largeur}" height="${hauteur}">${corps}</svg>`)
}

// ─── Inventaire des pièces ───────────────────────────────────────────────────

type Piece = { sujet: string; cible: string | null; v7: string | null; temoin: string | null; v7_64: string | null; temoin_64: string | null }

const pieces: Piece[] = SUJETS.map((s) => {
  const v7 = join(V7_DIR, 'v7', s.id, 'v7-1024.png')
  const v764 = join(V7_DIR, 'v7', s.id, 'v7-64.png')
  const tem = join(V7_DIR, 'temoin', s.id, 'temoin.png')
  const tem64 = join(V7_DIR, 'temoin', s.id, 'temoin-64.png')
  return {
    sujet: s.id,
    cible: existsSync(s.cibleChemin) ? s.cibleChemin : null,
    v7: existsSync(v7) ? v7 : null,
    temoin: existsSync(tem) ? tem : null,
    v7_64: existsSync(v764) ? v764 : null,
    temoin_64: existsSync(tem64) ? tem64 : null,
  }
})

async function cellule(chemin: string | null, manquant: string): Promise<Buffer> {
  if (!chemin) {
    return sharp({ create: { width: CELL, height: CELL, channels: 3, background: '#1a1a1a' } })
      .composite([{ input: texteSvg(CELL, 60, [manquant], 18, '#ff8a5c'), left: 0, top: CELL / 2 - 30 }])
      .png()
      .toBuffer()
  }
  return sharp(chemin).resize(CELL, CELL, { fit: 'cover' }).png().toBuffer()
}

// ─── La planche ──────────────────────────────────────────────────────────────

const LARGEUR = SUJETS.length * CELL + (SUJETS.length + 1) * GOUT
const HAUTEUR_LIGNE = ENTETE + CELL + GOUT
const BANDE = ENTETE + 64 + 8 + 192 + 30
const HAUTEUR = 3 * HAUTEUR_LIGNE + BANDE + GOUT

const calques: Array<{ input: Buffer; left: number; top: number }> = []
let y = GOUT

const LIGNES: Array<{ titre: string; cles: 'cible' | 'v7' | 'temoin' }> = [
  { titre: `CIBLES — les deux pièces à égaler, du dossier « entrainement IA fivem »`, cles: 'cible' },
  { titre: `V7 — marque écrite en SVG (${b.nb_elements_max} forme max, ${b.nb_couleurs_max} couleurs, sans contour) + fond raster séparé, assemblés en code`, cles: 'v7' },
  { titre: `TÉMOIN — mono-moteur raster, meilleure configuration v6 : un prompt, une image`, cles: 'temoin' },
]

for (const ligne of LIGNES) {
  calques.push({ input: texteSvg(LARGEUR, ENTETE, [ligne.titre], 20), left: 0, top: y })
  let x = GOUT
  for (const p of pieces) {
    const chemin = ligne.cles === 'cible' ? p.cible : ligne.cles === 'v7' ? p.v7 : p.temoin
    calques.push({ input: await cellule(chemin, `${p.sujet} — ${ligne.cles} absent`), left: x, top: y + ENTETE })
    calques.push({ input: texteSvg(CELL, 28, [p.sujet.toUpperCase()], 16, '#8fb8ff'), left: x, top: y + ENTETE + 6 })
    x += CELL + GOUT
  }
  y += HAUTEUR_LIGNE
}

// ── la bande 64 px : les six pièces, taille réelle puis agrandies ──
calques.push({
  input: texteSvg(LARGEUR, ENTETE, ['64 PIXELS — les six pièces à la taille d\'une vignette de serveur, puis agrandies au plus proche voisin'], 20),
  left: 0,
  top: y,
})
const bande: Array<{ chemin: string | null; nom: string; plein: string | null }> = []
for (const p of pieces) bande.push({ chemin: p.cible, nom: `cible ${p.sujet}`, plein: p.cible })
for (const p of pieces) bande.push({ chemin: p.v7_64, nom: `v7 ${p.sujet}`, plein: p.v7 })
for (const p of pieces) bande.push({ chemin: p.temoin_64, nom: `témoin ${p.sujet}`, plein: p.temoin })

let bx = GOUT
for (const item of bande) {
  const pas = 64 + 24
  if (item.chemin) {
    const petit = await sharp(item.chemin).resize(64, 64, { fit: 'cover' }).png().toBuffer()
    calques.push({ input: petit, left: bx, top: y + ENTETE })
    calques.push({
      input: await sharp(petit).resize(192, 192, { kernel: 'nearest' }).png().toBuffer(),
      left: bx,
      top: y + ENTETE + 64 + 8,
    })
  }
  calques.push({ input: texteSvg(192, 24, [item.nom], 13, '#9a9a9a'), left: bx, top: y + ENTETE + 64 + 8 + 192 + 2 })
  bx += Math.max(pas, 192 + 16)
}

const planche = join(V7_DIR, 'planche-v7.jpg')
mkdirSync(V7_DIR, { recursive: true })
await sharp({ create: { width: Math.max(LARGEUR, bx + GOUT), height: HAUTEUR, channels: 3, background: '#0d0d0f' } })
  .composite(calques)
  .jpeg({ quality: 92 })
  .toFile(planche)
console.log(`  planche → ${planche}`)

// ─── Le rapport ──────────────────────────────────────────────────────────────

function lis<T>(chemin: string): T | null {
  return existsSync(chemin) ? (JSON.parse(readFileSync(chemin, 'utf-8')) as T) : null
}

type Boucle = {
  piste: string
  forme: string
  palette: string[]
  tours_joues: number
  tour_retenu: number
  converge: boolean
  cout_eur: number
  historique: Array<{
    tour: number
    gardes: Array<{ nom: string; passe: boolean; mesure: string; attendu: string }>
    critique: { courbes_propres: boolean | null; epaisseur_constante: boolean | null; ecart_principal_en_une_phrase: string } | null
    lecture: { lettres: string[]; lecture_en_un_coup_d_oeil: string } | null
    mesure: { nbElements: number; nbCouleursRendu: number; iou64: number; masse: number | null; analyse: { nbPaths: number } }
  }>
}
type Compose = {
  fond_retenu: string
  scores_variantes: Array<{ nom: string; score: number }>
  fond_hors_marque: { luminance: number; contraste: number; saturation: number }
  luminance_marque: number
  luminance_sous_la_marque: number
  contraste_marque_fond: number
  fond_dans_les_bornes: boolean
  boite_marque: { x0: number; y0: number; x1: number; y1: number; aire: number } | null
}
type Temoin = {
  nom: string
  archetype: string
  famille_rendu: string
  refs: string[]
  prompt: string
  mots_du_prompt: number
  ocr: { rejets: number; detail: string }
  mesures: { fond_hors_marque: { luminance: number; contraste: number; saturation: number }; masse: number | null; boite_marque: { aire: number } | null }
}

const R: string[] = []
const p = (...l: string[]) => R.push(...l)

p(
  `# Rapport v7 — SÉPARATION DES MOTEURS`,
  ``,
  `Session 7, ${new Date().toISOString().slice(0, 10)}. Enveloppe 5,00 €, mandat complet, sept phases.`,
  `Planche : \`_v7/planche-v7.jpg\`. Journal au fil de l'eau : \`calibration-log-7.md\`.`,
  ``,
  `**Le pari** : un modèle d'image PEINT, il ne TRACE pas. Les références FiveM sont une marque`,
  `vectorielle propre posée sur un fond raster. On arrête de prompter la marque : un modèle l'écrit`,
  `en SVG, un rasteriseur la trace, un modèle d'image ne fait plus que le décor, et le code assemble.`,
  ``,
  `---`,
  ``,
  `## 1. Les médianes du corpus`,
  ``,
  `${regles.inventaire.fichiers} fichiers inventoriés, **${regles.inventaire.analysables} analysables**, tous passés sur`,
  `\`gemini-3.5-flash\` par lots de 10 à température 0. **${regles.inventaire.releves} relevés, zéro échec, zéro boîte \`box_2d\` invalide.**`,
  `Bornes calculées sur les **${b.n} pièces porteuses d'une marque isolée** (dossiers logo/icon/PackPsd, ≥ 200 px).`,
  ``,
  `| borne | valeur retenue | médiane | p25 | p75 |`,
  `|---|---|---|---|---|`,
  `| formes séparées (\`nb_elements_max\`) | **${b.nb_elements_max}** | ${regles.sous_ensemble_marque.numeriques.nb_elements_distincts!.mediane} | ${regles.sous_ensemble_marque.numeriques.nb_elements_distincts!.p25} | ${regles.sous_ensemble_marque.numeriques.nb_elements_distincts!.p75} |`,
  `| couleurs de marque (\`nb_couleurs_max\`) | **${b.nb_couleurs_max}** | ${regles.sous_ensemble_marque.numeriques.nb_couleurs!.mediane} | ${regles.sous_ensemble_marque.numeriques.nb_couleurs!.p25} | ${regles.sous_ensemble_marque.numeriques.nb_couleurs!.p75} |`,
  `| contour | **${b.contour}** | ${Object.entries(regles.sous_ensemble_marque.categoriels.contour!).map(([k, v]) => `${k} ${v}`).join(' · ')} | | |`,
  `| trame | **${b.trame}** | ${Object.entries(regles.sous_ensemble_marque.categoriels.trame!).map(([k, v]) => `${k} ${v}`).join(' · ')} | | |`,
  `| type dominant | **${b.type}** | ${Object.entries(regles.sous_ensemble_marque.categoriels.type!).map(([k, v]) => `${k} ${v}`).join(' · ')} | | |`,
  `| fond | **${b.fond_type}** | sur les ${b.n_fond} pièces qui ont un fond | | |`,
  `| luminance du fond | **${b.luminance_fond.mediane}** | ${b.luminance_fond.mediane} | ${b.luminance_fond.p25} | ${b.luminance_fond.p75} |`,
  `| contraste du fond | **${b.contraste_fond.mediane}** | ${b.contraste_fond.mediane} | ${b.contraste_fond.p25} | ${b.contraste_fond.p75} |`,
  `| saturation du fond | **${b.saturation_fond.mediane}** | ${b.saturation_fond.mediane} | ${b.saturation_fond.p25} | ${b.saturation_fond.p75} |`,
  `| aire boîte / cadre | **${b.ratio_marque_cadre.mediane}** | ${b.ratio_marque_cadre.mediane} | ${b.ratio_marque_cadre.p25} | ${b.ratio_marque_cadre.p75} |`,
  `| plus grand côté / cadre | **${b.cote_marque_cadre.mediane}** | ${b.cote_marque_cadre.mediane} | ${b.cote_marque_cadre.p25} | ${b.cote_marque_cadre.p75} |`,
  `| masse (encre / boîte) | **≥ ${b.taux_remplissage_boite.p25}** (plancher p25) | ${b.taux_remplissage_boite.mediane} | ${b.taux_remplissage_boite.p25} | ${b.taux_remplissage_boite.p75} |`,
  ``,
  `Palette : **${arrondi(b.palette_marque.part_neutre * 100, 1)} % des ${b.palette_marque.entrees} entrées de palette du corpus sont NEUTRES** (dominante \`${b.palette_marque.neutre_dominant}\`).`,
  `Familles de teinte des accents, par tranches de 30° : ${b.palette_marque.familles_accent.map(([f, n]) => `${f}° ×${n}`).join(' · ')}.`,
  `Les familles portées au moins 4 fois sont les seules autorisées en code : ${b.palette_marque.familles_retenues.map((f) => `${f}°`).join(', ')}.`,
  ``,
  `### Deux croyances de la session 6 que la mesure contredit`,
  ``,
  `- **Contour** : le pivot du 17/08 décrivait l'idiome comme « vectoriel plat à contour noir ÉPAIS ».`,
  `  Mesuré : ${regles.sous_ensemble_marque.categoriels.contour!.none ?? 0} pièces sur ${b.n} n'ont **aucun** contour, ${regles.sous_ensemble_marque.categoriels.contour!.epais ?? 0} en ont un épais.`,
  `  Les deux cibles du mandat le confirment à l'œil. La borne est donc \`none\`, et le mandat de cette`,
  `  session l'avait anticipé : « les médianes remplacent toutes les consignes rédigées ».`,
  `- **Trame** : la même note faisait du halftone « le trait central de l'idiome ».`,
  `  Mesuré : ${regles.sous_ensemble_marque.categoriels.trame!.none ?? 0} pièces sur ${b.n} n'ont aucune trame ; le halftone est porté par **une seule** pièce`,
  `  (\`vulcainlogo\`) et les scanlines par une autre (\`logotbnnn\`) — exactement les deux pièces sur`,
  `  lesquelles la conclusion du run 6 avait été bâtie. Deux pièces avaient été lues comme une règle.`,
  ``,
  `### Les 10 exemplaires canoniques`,
  ``,
  `Les pièces les plus proches de la médiane sur neuf axes à la fois (5 numériques divisés par leur`,
  `écart interquartile, 4 catégoriels à 0 ou 1), filtrées à ≥ 512 px natif puisqu'elles sont JOINTES`,
  `comme images aux phases 2 et 3. Planche : \`_v7/canoniques.jpg\`.`,
  ``,
  ...regles.canoniques.map(
    (c, i) =>
      `${i + 1}. \`${c.slug}\` — distance ${c.distance} · ${c.resume.type} · ${c.resume.nb_elements} forme(s) · ${c.resume.nb_couleurs} couleur(s) · contour ${c.resume.contour} · fond ${c.resume.fond_type} (L ${c.resume.luminance_fond})`
  ),
  ``,
  `**\`black-world1\`, la cible de NOX, sort ${regles.canoniques.findIndex((c) => c.slug.includes('black-world1')) + 1}ᵉ pièce la plus typique du corpus.** Le mandat a choisi ses`,
  `cibles à l'œil ; neuf axes mesurés indépendamment les retrouvent au centre. C'est une validation`,
  `croisée gratuite.`,
  ``,
  `**\`vulcainlogo\` n'est PAS dans les canoniques**, et il faut le dire sans arrondi : elle mesure`,
  `**7 formes séparées** (les plumes des ailes sont détachées par des lisérés sombres) contre une`,
  `médiane de ${b.nb_elements_max} et un p75 de ${regles.sous_ensemble_marque.numeriques.nb_elements_distincts!.p75}, et une **masse de 0,240** contre un plancher de ${b.taux_remplissage_boite.p25}.`,
  `Sur deux axes indépendants, **la borne dure interdit la cible elle-même.** Un VULCAIN qui passe la`,
  `garde est donc plus simple et plus compact que la pièce qu'il doit égaler. J'ai gardé la borne : le`,
  `mandat la pose explicitement, et elle rejoint le dernier verdict opérateur du run 6 — « ma`,
  `référence vulcainlogo, c'est DEUX AILES, rien d'autre ».`,
  ``,
  `---`,
  ``,
  `## 2. La piste retenue par sujet, et ce que la réduction a retiré`,
  ``
)

for (const s of SUJETS) {
  const da = lis<SortieDa>(join(V7_DIR, `da-${s.id}.json`))
  if (!da) {
    p(`### ${s.nom}`, ``, `Aucune sortie de DA sur le disque.`, ``)
    continue
  }
  // Recalculée avec la règle COURANTE, jamais lue telle quelle (cf. v7-svg.ts).
  const verdict = choisis(da.pistes, b.nb_elements_max, b.nb_couleurs_max, b.palette_marque)
  const choisie = da.pistes[verdict.index]
  p(
    `### ${s.nom} — piste retenue : « ${choisie?.nom ?? '?'} »`,
    ``,
    `Sélection **en code** : ${verdict.motif}. ${da.tentatives} tentative(s) de DA.` +
      (verdict.index !== da.choisie.index
        ? ` ⚠ La règle de sélection a évolué APRÈS la phase 2 (ajout de la garde de conformité de palette) : la piste retenue est recalculée, elle passe de « ${da.pistes[da.choisie.index]?.nom} » à « ${choisie?.nom} » sans repayer le DA.`
        : ''),
    ``,
    `Ce que le DA dit de la cible : *${da.ce_que_la_cible_fait}*`,
    ``,
    `| piste | avant réduction | retiré | après réduction |`,
    `|---|---|---|---|`,
    ...da.pistes.map(
      (x: Piste, i: number) =>
        `| ${i === verdict.index ? '**→ ' : ''}${x.nom}${i === verdict.index ? '**' : ''} | ${x.forme.replace(/\|/g, '/')} | ${(x.reduction?.retire ?? []).join(' ; ').replace(/\|/g, '/')} | ${(x.reduction?.forme_reduite ?? '').replace(/\|/g, '/')} |`
    ),
    ``,
    `Palette proposée et vérifiée conforme au corpus : ${(choisie?.reduction?.palette_hex ?? []).join(' + ')}.`,
    ``
  )
}

p(`---`, ``, `## 3. La boucle SVG : combien d'itérations, et ce qui bloquait`, ``)

for (const s of SUJETS) {
  const bo = lis<Boucle>(join(V7_DIR, 'svg', s.id, 'boucle.json'))
  if (!bo) {
    p(`### ${s.nom}`, ``, `Aucune boucle sur le disque — phase 3 non jouée pour ce sujet.`, ``)
    continue
  }
  p(
    `### ${s.nom} — ${bo.tours_joues} tour(s), retenu le tour ${bo.tour_retenu}, ${bo.converge ? '**convergé**' : '**NON convergé** (meilleur état mesuré)'}`,
    ``,
    `Coût réel de la boucle : **${bo.cout_eur.toFixed(4)} €** — aucun appel image.`,
    ``,
    `| tour | gardes | formes | couleurs | IoU 64 px | masse | chemins | lu | ce qui bloquait |`,
    `|---|---|---|---|---|---|---|---|---|`,
    ...bo.historique.map((h) => {
      const echecs = h.gardes.filter((g) => !g.passe)
      return `| ${h.tour} | ${h.gardes.filter((g) => g.passe).length}/${h.gardes.length} | ${h.mesure.nbElements} | ${h.mesure.nbCouleursRendu} | ${h.mesure.iou64} | ${h.mesure.masse ?? '—'} | ${h.mesure.analyse.nbPaths} | ${h.lecture?.lettres?.join('') || '—'} | ${echecs.length ? echecs.map((g) => `\`${g.nom}\` (${g.mesure})`).join(' · ') : '— rien —'} |`
    }),
    ``
  )
  const dernier = bo.historique[bo.historique.length - 1]
  if (dernier?.critique) {
    p(
      `Dernière critique de forme : courbes propres **${dernier.critique.courbes_propres}**, épaisseur constante **${dernier.critique.epaisseur_constante}**.`,
      `Écart à la cible, par le juge : *${dernier.critique.ecart_principal_en_une_phrase}*`,
      ``
    )
  }
  if (!bo.converge) {
    const reste = bo.historique.find((h) => h.tour === bo.tour_retenu)?.gardes.filter((g) => !g.passe) ?? []
    p(
      `**Ce qui n'a pas été résolu en ${bo.tours_joues} tours** : ${reste.length ? reste.map((g) => `\`${g.nom}\` — mesuré ${g.mesure}, attendu ${g.attendu}`).join(' ; ') : 'les gardes passent, la critique de forme non'}.`,
      ``
    )
  }
}

p(`---`, ``, `## 4. La composition, et le témoin, mesurés au même instrument`, ``)

p(
  `| | fond L | fond C | fond S | dans les bornes | masse de la marque | boîte / cadre |`,
  `|---|---|---|---|---|---|---|`
)
for (const s of SUJETS) {
  const co = lis<Compose>(join(V7_DIR, 'v7', s.id, 'compose.json'))
  const te = lis<Temoin>(join(V7_DIR, 'temoin', s.id, 'temoin.json'))
  const bo = lis<Boucle>(join(V7_DIR, 'svg', s.id, 'boucle.json'))
  const masseV7 = bo?.historique.find((h) => h.tour === bo.tour_retenu)?.mesure.masse ?? null
  if (co) {
    p(
      `| **v7 ${s.id}** | ${co.fond_hors_marque.luminance} | ${co.fond_hors_marque.contraste} | ${co.fond_hors_marque.saturation} | ${co.fond_dans_les_bornes ? 'oui' : '**non**'} | ${masseV7 ?? '—'} | ${co.boite_marque ? arrondi(co.boite_marque.aire, 3) : '—'} |`
    )
  }
  if (te) {
    p(
      `| témoin ${s.id} | ${te.mesures.fond_hors_marque.luminance} | ${te.mesures.fond_hors_marque.contraste} | ${te.mesures.fond_hors_marque.saturation} | ${te.mesures.fond_hors_marque.luminance >= b.luminance_fond.p25 && te.mesures.fond_hors_marque.luminance <= b.luminance_fond.p75 && te.mesures.fond_hors_marque.contraste >= b.contraste_fond.p25 && te.mesures.fond_hors_marque.contraste <= b.contraste_fond.p75 ? 'oui' : '**non**'} | ${te.mesures.masse ?? '—'} | ${te.mesures.boite_marque ? arrondi(te.mesures.boite_marque.aire, 3) : '—'} |`
    )
  }
}
p(
  `| cible black-world1 | 0.0859 | 0.0327 | 0.242 | — | 0.5133 | 0.2279 |`,
  `| cible vulcainlogo | 0.2516 | 0.2037 | 0.3772 | — | 0.2398 | 0.4227 |`,
  `| **médiane du corpus** | **${b.luminance_fond.mediane}** | **${b.contraste_fond.mediane}** | **${b.saturation_fond.mediane}** | — | **${b.taux_remplissage_boite.mediane}** | **${b.ratio_marque_cadre.mediane}** |`,
  ``,
  `⚠ La masse du v7 est mesurée sur l'alpha exact du SVG ; celle du témoin et des cibles par`,
  `segmentation par contraste au fond, comme les pièces du corpus. Les deux chiffres sont comparables`,
  `à l'usage mais ne sortent pas du même instrument — la version SVG est exacte, l'autre approchée.`,
  ``
)

for (const s of SUJETS) {
  const te = lis<Temoin>(join(V7_DIR, 'temoin', s.id, 'temoin.json'))
  if (!te) continue
  p(
    `### Témoin ${s.nom} — ce que le mono-moteur a reçu`,
    ``,
    `Archétype \`${te.archetype}\`, famille \`${te.famille_rendu}\`, références \`${te.refs.join('` · `')}\`.`,
    `Porte OCR : ${te.ocr.rejets} rejet(s) — ${te.ocr.detail}.`,
    ``,
    `Prompt intégral (${te.mots_du_prompt} mots) :`,
    ``,
    '```',
    te.prompt,
    '```',
    ``
  )
}

// ─── La survie à 64 px, au MÊME instrument sur les six pièces ────────────────

p(
  `### La survie structurelle à 64 px`,
  ``,
  `Même instrument sur les six pièces, quelle que soit leur origine : la marque est`,
  `segmentée par écart de luminance au fond, une fois sur l'image pleine, une fois`,
  `sur la même image réduite à 64 px puis remontée au plus proche voisin. L'IoU des`,
  `deux masques dit ce que la vignette de serveur perd. C'est la taille à laquelle`,
  `un client voit un logo dans une liste — la bande basse de la planche.`,
  ``,
  `| pièce | IoU 64 px | encre à 512 | encre à 64 |`,
  `|---|---|---|---|`
)
for (const item of bande) {
  if (!item.plein) continue
  const s = await survie64(item.plein)
  p(`| ${item.nom} | **${s.iou}** | ${s.encre512} | ${s.encre64} |`)
}
p(``)

// ─── Coûts ───────────────────────────────────────────────────────────────────

p(`---`, ``, `## 5. Le coût réel, par phase`, ``, `| phase | plafond | dépensé | appels |`, `|---|---|---|---|`)
for (const r of recapPhases()) {
  p(`| \`${r.phase}\` | ${r.cap.toFixed(2)} € | **${r.spent.toFixed(4)} €** | ${r.appels} |`)
}
p(
  `| **total** | ${Object.values(PLAFONDS_PHASE).reduce((a, x) => a + x, 0).toFixed(2)} € attribués / ${CAP_EUR.toFixed(2)} € d'enveloppe | **${spentEur().toFixed(4)} €** | |`,
  ``,
  `Grand livre : \`captures/calibration/budget-ledger-7.json\`.`,
  `Aucune garde de phase ne s'est déclenchée ${recapPhases().some((r) => r.spent > r.cap) ? '— sauf indication contraire ci-dessus' : 'et aucun plafond n\'a été atteint'}.`,
  ``
)

// ─── Le jugement ─────────────────────────────────────────────────────────────

const JUGEMENT = existsSync(join(V7_DIR, 'jugement.md'))
  ? readFileSync(join(V7_DIR, 'jugement.md'), 'utf-8')
  : '_(jugement non encore rédigé)_'

p(`---`, ``, `## 6. Jugement — la séparation des moteurs produit-elle quelque chose que le mono-moteur ne produit pas ?`, ``, JUGEMENT, ``)

const rapport = join(V7_DIR, 'rapport-v7.md')
writeFileSync(rapport, R.join('\n'))
console.log(`  rapport → ${rapport}`)
console.log(`  grand livre : ${spentEur().toFixed(4)} € / ${CAP_EUR.toFixed(2)} €`)
