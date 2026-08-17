/*
 * Run 7 — RE-JUGEMENT des tours archivés, à ZÉRO appel.
 *
 *   bun run scripts/calibration/v7-rejuge.ts [--sujets nox,vulcain]
 *
 * Pourquoi ce mode existe. Une garde de la phase 3 s'est révélée mal calibrée en
 * cours de route : « un emblème ne doit porter AUCUNE lettre » a refusé, au tour 2
 * de VULCAIN, un V ailé d'une seule silhouette — la meilleure pièce de la série et
 * la plus proche de la cible — puis la boucle s'est éloignée (un U, un écusson à
 * étoile) et a convergé sur le pire des trois. Corriger la garde et rejouer la
 * boucle coûterait quatre appels de traceur et redistribuerait les dés.
 *
 * Or tout est sur le disque : les SVG de chaque tour, et les mesures de vision
 * de chaque tour dans `boucle.json`. Les gardes de CODE se recalculent en local, la
 * lecture des glyphes et la critique de forme se relisent. Le verdict se refait
 * donc entièrement hors ligne — c'est la même règle qu'ailleurs dans cette
 * session : faire évoluer du code ne doit pas coûter un appel.
 *
 * Ce mode ne fabrique rien. Il re-décide, et il ÉCRIT ce qu'il a changé.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import sharp from 'sharp'
import { setPhase, V7_DIR } from './budget7'
import { chargeRegles, SUJETS } from './v7-sujets'
import { decisionGlyphes, decisionSujet, gardes, score, type Critique, type Garde } from './v7-gardes'
import { mesureSvg, partNeutreRendu, regionsCouleur, renduSvg, type MesureSvg, type RegionCouleur } from './v7-lib'

setPhase('p5-compose') // aucun appel : phase à plafond nul, la garde le confirmera

const args = process.argv.slice(2)
const valeur = (nom: string): string | null => {
  const i = args.indexOf(nom)
  return i >= 0 ? (args[i + 1] ?? null) : null
}
const filtre = valeur('--sujets')
const sujets = filtre ? SUJETS.filter((s) => filtre.split(',').includes(s.id)) : SUJETS

const regles = chargeRegles()
const b = regles.bornes

type TourArchive = {
  tour: number
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
type Boucle = {
  sujet: string
  piste: string
  forme: string
  palette: string[]
  bornes: Record<string, unknown>
  tours_joues: number
  tour_retenu: number
  converge: boolean
  cout_eur: number
  historique: TourArchive[]
  rejuge?: unknown
}

console.log(`\n═══ RE-JUGEMENT des tours archivés (0 appel, 0 €) ═══\n`)

for (const s of sujets) {
  const dossier = join(V7_DIR, 'svg', s.id)
  const cheminBoucle = join(dossier, 'boucle.json')
  if (!existsSync(cheminBoucle)) {
    console.log(`  ✗ ${s.id} : pas de boucle archivée.`)
    continue
  }
  const bo = JSON.parse(readFileSync(cheminBoucle, 'utf-8')) as Boucle
  console.log(`  ── ${s.nom} · ${bo.historique.length} tour(s) archivé(s) · retenu à l'origine : tour ${bo.tour_retenu} ──`)

  const refaits: TourArchive[] = []
  for (const h of bo.historique) {
    const cheminSvg = join(dossier, `tour-${h.tour}.svg`)
    if (!existsSync(cheminSvg)) {
      console.log(`     tour ${h.tour} : SVG absent, conservé tel quel`)
      refaits.push(h)
      continue
    }
    const svg = readFileSync(cheminSvg, 'utf-8')
    // Les mesures de CODE sont refaites depuis le SVG — aucune n'est relue.
    const mesure = await mesureSvg(svg)
    const alpha = mesure.parse ? await renduSvg(svg, 512) : null
    const partNeutre = alpha ? await partNeutreRendu(alpha) : null
    const regions: RegionCouleur[] = alpha ? await regionsCouleur(alpha) : []
    const g = gardes(
      mesure,
      bo.palette,
      b.nb_elements_max,
      b.nb_couleurs_max,
      b.palette_marque,
      b.contour,
      b.taux_remplissage_boite.p25,
      0.088,
      regions
    )
    // Les mesures de VISION sont RELUES de l'archive, jamais redemandées.
    const dg = decisionGlyphes(h.lecture?.lettres ?? [], s.lettrage)
    g.push({
      nom: 'glyphes',
      passe: h.lecture === null ? true : dg.passe,
      mesure: h.lecture === null ? 'lecture indisponible — garde neutralisée' : dg.detail,
      attendu: s.lettrage ? `exactement les lettres ${s.lettrage.split('').join('-')}` : 'au plus une forme-de-lettre (zéro LETTRAGE)',
    })
    const formeOk = h.critique === null ? true : h.critique.courbes_propres === true && h.critique.epaisseur_constante === true
    const echecs = g.filter((x) => !x.passe)
    const passe = echecs.length === 0 && formeOk
    const nouveau: TourArchive = { ...h, mesure, gardes: g, partNeutre, regions, score: score(g, h.critique, mesure), passe }
    refaits.push(nouveau)

    const change = passe !== h.passe
    console.log(
      `     tour ${h.tour} : ${g.filter((x) => x.passe).length}/${g.length} gardes · ${passe ? 'PASSE' : 'échoue'}${change ? `  ⇄ CHANGÉ (était ${h.passe ? 'PASSE' : 'échoue'})` : ''}` +
        (s.lettrage === null ? ` · nommé « ${h.nomination?.nom ?? '—'} » (mesure, pas garde : ${decisionSujet(h.nomination?.nom).passe ? 'porte un sujet' : 'que de la géométrie'})` : '')
    )
    if (echecs.length) console.log(`        échecs : ${echecs.map((x) => `${x.nom} (${x.mesure})`).join(' · ')}`)
    if (!formeOk && h.critique) console.log(`        critique de forme : courbes ${h.critique.courbes_propres} / épaisseur ${h.critique.epaisseur_constante}`)
  }

  /*
   * Le tour retenu : le PREMIER qui passe tout (c'est la règle de la boucle en
   * vol — « on sort dès que tout passe »), sinon le meilleur score. Prendre le
   * meilleur score parmi les passants changerait la règle en cours de route.
   */
  const premierPassant = refaits.find((x) => x.passe)
  const meilleur = premierPassant ?? refaits.reduce((a, x) => (x.score > a.score ? x : a), refaits[0]!)
  const svgRetenu = readFileSync(join(dossier, `tour-${meilleur.tour}.svg`), 'utf-8')

  writeFileSync(join(dossier, 'mark.svg'), svgRetenu)
  await sharp(await renduSvg(svgRetenu, 1024)).png().toFile(join(dossier, 'mark-1024.png'))
  await sharp(await renduSvg(svgRetenu, 64)).png().toFile(join(dossier, 'mark-64.png'))
  writeFileSync(
    cheminBoucle,
    JSON.stringify(
      {
        ...bo,
        tour_retenu: meilleur.tour,
        converge: meilleur.passe,
        historique: refaits,
        rejuge: {
          le: new Date().toISOString(),
          motif:
            'garde `glyphes` recalibrée sur la cible : un emblème tolère UNE forme-de-lettre, il refuse du LETTRAGE (2+). ' +
            'La version stricte refusait `vulcainlogo` elle-même au calibrage, et avait écarté le meilleur tour de la série.',
          tour_retenu_avant: bo.tour_retenu,
          tour_retenu_apres: meilleur.tour,
          appels: 0,
        },
      },
      null,
      2
    )
  )
  console.log(
    `     RETENU après re-jugement : tour ${meilleur.tour}${meilleur.tour !== bo.tour_retenu ? ` (était ${bo.tour_retenu})` : ' (inchangé)'} · ${meilleur.passe ? 'CONVERGÉ' : 'meilleur état'}\n`
  )
}

console.log(`  Aucun appel passé. Grand livre inchangé.\n`)
