/*
 * Run 6 — EXPÉRIENCE E1 : calibrer l'instrument AVANT de mesurer.
 *
 * Zéro image générée. On rejoue la mesure v6 (§7.1 overlap_ratio + §7.2 duel
 * forcé contre le gold set) sur des images DÉJÀ EN BOÎTE :
 *   - les 2 gagnants du test plafond (_plafond-run59/) — la seule chose qui
 *     ait jamais produit le niveau cible ;
 *   - les 3 rendus intégraux du run 5.10 (integ1-3) — notés 8-9/10 et aveugle
 *     0/3 par le jury, REJETÉS par l'opérateur ;
 *   - les pièces du gold set elles-mêmes, en témoin de borne haute.
 *
 * LA QUESTION TRANCHÉE : la mesure classe-t-elle enfin les gagnants du plafond
 * au-dessus des rejetés ? Si NON, on arrête tout et on répare la mesure avant
 * de dépenser un euro en images (§9 du document v6).
 *
 *   bun run scripts/calibration/e1-mesure.ts [--sans-duels] [--sans-gold]
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { installBudgetGuard, spentEur, CAP_EUR, CALIBRATION_DIR } from './budget6'
import {
  mesureComposition,
  duelContreGold,
  chargeCandidat,
  MESURE_VERSION,
  OVERLAP_PASSAGE,
  OVERLAP_ELIMINATOIRE,
  type CompositionMesure,
  type DuelResultat,
} from './mesure-v6'
import { goldSetImages } from './corpus'

installBudgetGuard()

const args = process.argv.slice(2)
const sansDuels = args.includes('--sans-duels')
const sansGold = args.includes('--sans-gold')

const SORTIE_DIR = join(CALIBRATION_DIR, '_mesure-v6')

type Sujet = {
  cle: string
  titre: string
  /** 'plafond' = la barre atteinte · 'rejete' = refusé par l'opérateur · 'gold' = témoin */
  groupe: 'plafond' | 'rejete' | 'gold'
  chemin: string
}

const SUJETS: Sujet[] = [
  {
    cle: 'plafond-A-texte-puis-images',
    titre: 'Plafond variante A — texte puis images (52 mots)',
    groupe: 'plafond',
    chemin: join(CALIBRATION_DIR, '_plafond-run59', 'minimal-texte-puis-images.png'),
  },
  {
    cle: 'plafond-B-images-etiquetees',
    titre: 'Plafond variante B — images étiquetées d\'abord (52 mots)',
    groupe: 'plafond',
    chemin: join(CALIBRATION_DIR, '_plafond-run59', 'minimal-images-etiquetees-dabord.png'),
  },
  {
    cle: 'integ1-plat',
    titre: 'Run 5.10 integ1 plat_premium — jury 9/10, aveugle 0/3, REJETÉ',
    groupe: 'rejete',
    chemin: join(CALIBRATION_DIR, 'integ1-510-fruitz-plat', 'candidate.png'),
  },
  {
    cle: 'integ2-semi',
    titre: 'Run 5.10 integ2 semi_flat_biseau — jury 8/10, aveugle 0/3, REJETÉ',
    groupe: 'rejete',
    chemin: join(CALIBRATION_DIR, 'integ2-510-fruitz-semi', 'candidate.png'),
  },
  {
    cle: 'integ3-dim',
    titre: 'Run 5.10 integ3 dimensionnelle — jury 9/10, aveugle 0/3, REJETÉ',
    groupe: 'rejete',
    chemin: join(CALIBRATION_DIR, 'integ3-510-fruitz-dim', 'candidate.png'),
  },
]

type Resultat = Sujet & {
  composition: CompositionMesure
  duel: DuelResultat | null
}

async function main() {
  console.log(`\n═══ E1 — calibration de l'instrument (${MESURE_VERSION})`)
  console.log(`Grand livre session 6 : ${spentEur().toFixed(4)} € / ${CAP_EUR.toFixed(2)} €\n`)

  const manquants = SUJETS.filter((s) => !existsSync(s.chemin))
  if (manquants.length) {
    console.error('Images introuvables :\n' + manquants.map((m) => `  - ${m.chemin}`).join('\n'))
    process.exit(1)
  }

  const resultats: Resultat[] = []

  // ── §7.1 sur les sujets ────────────────────────────────────────────────────
  console.log('── §7.1 overlap_ratio (emblème ∩ lettrage / lettrage) ──')
  for (const sujet of SUJETS) {
    const png = await chargeCandidat(sujet.chemin)
    const composition = await mesureComposition({ png, label: `e1_overlap_${sujet.cle}` })
    console.log(
      `  ${sujet.cle.padEnd(30)} overlap ${composition.overlapRatio.toFixed(3).padStart(6)}  ${composition.verdict.padEnd(13)} [${composition.essais} essai(s)] ${composition.note}`
    )
    resultats.push({ ...sujet, composition, duel: null })
  }

  // ── témoin : les pièces gold, borne haute annoncée 0,4-0,8 ─────────────────
  const temoinsGold: Array<{ slug: string; composition: CompositionMesure }> = []
  if (!sansGold) {
    console.log('\n── témoin : les pièces du gold set (borne haute de l\'instrument) ──')
    for (const gold of goldSetImages()) {
      const composition = await mesureComposition({ png: gold.jpeg, label: `e1_overlap_gold_${gold.slug}` })
      console.log(
        `  ${gold.slug.slice(0, 30).padEnd(30)} overlap ${composition.overlapRatio.toFixed(3).padStart(6)}  ${composition.verdict.padEnd(13)} [${composition.essais} essai(s)] ${composition.note}`
      )
      temoinsGold.push({ slug: gold.slug, composition })
    }
  }

  // ── §7.2 duels forcés ──────────────────────────────────────────────────────
  if (!sansDuels) {
    console.log('\n── §7.2 duel forcé contre le gold set (chaque duel joué A/B puis B/A) ──')
    for (const r of resultats) {
      const png = await chargeCandidat(r.chemin)
      const duel = await duelContreGold({ candidatPng: png, label: `e1_duel_${r.cle}` })
      r.duel = duel
      console.log(
        `  ${r.cle.padEnd(30)} ${duel.victoires}/${duel.duels} victoires · ${duel.coherents}/${duel.duels} verdicts cohérents · ${duel.verdict}`
      )
    }
  }

  // ── LE VERDICT DE L'INSTRUMENT ─────────────────────────────────────────────
  const plafond = resultats.filter((r) => r.groupe === 'plafond')
  const rejetes = resultats.filter((r) => r.groupe === 'rejete')
  const minOverlapPlafond = Math.min(...plafond.map((r) => r.composition.overlapRatio))
  const maxOverlapRejete = Math.max(...rejetes.map((r) => r.composition.overlapRatio))
  const overlapSepare = minOverlapPlafond > maxOverlapRejete

  const victoires = (r: Resultat) => r.duel?.victoires ?? -1
  const minVictoiresPlafond = plafond.length ? Math.min(...plafond.map(victoires)) : -1
  const maxVictoiresRejete = rejetes.length ? Math.max(...rejetes.map(victoires)) : -1
  const duelSepare = !sansDuels && minVictoiresPlafond > maxVictoiresRejete

  const moyenneGold = temoinsGold.length
    ? Math.round((temoinsGold.reduce((s, t) => s + t.composition.overlapRatio, 0) / temoinsGold.length) * 1000) / 1000
    : null

  console.log('\n═══ VERDICT E1')
  console.log(`  overlap : plafond min ${minOverlapPlafond.toFixed(3)} vs rejetés max ${maxOverlapRejete.toFixed(3)} → ${overlapSepare ? 'SÉPARE' : 'NE SÉPARE PAS'}`)
  if (moyenneGold !== null) console.log(`  overlap : moyenne du gold set ${moyenneGold.toFixed(3)} (borne haute annoncée 0,4-0,8)`)
  if (!sansDuels) {
    console.log(`  duels   : plafond min ${minVictoiresPlafond} vs rejetés max ${maxVictoiresRejete} → ${duelSepare ? 'SÉPARE' : 'NE SÉPARE PAS'}`)
  }
  const instrumentValide = overlapSepare || duelSepare
  console.log(
    instrumentValide
      ? '  → INSTRUMENT VALIDE sur au moins un critère : E2-E4 peuvent être payés.'
      : "  → INSTRUMENT INVALIDE : ni l'overlap ni les duels ne classent le plafond au-dessus des rejetés.\n    ARRÊT. Réparer la mesure avant toute dépense image (§9, E1 avant tout appel payant)."
  )
  console.log(`\nGrand livre session 6 après E1 : ${spentEur().toFixed(4)} € / ${CAP_EUR.toFixed(2)} €`)

  // ── rapport ────────────────────────────────────────────────────────────────
  mkdirSync(SORTIE_DIR, { recursive: true })
  const rapport = {
    experience: 'E1 — calibration de la mesure sur images déjà en boîte',
    version: MESURE_VERSION,
    seuils: { overlapPassage: OVERLAP_PASSAGE, overlapEliminatoire: OVERLAP_ELIMINATOIRE },
    lance_le: new Date().toISOString(),
    verdict: {
      overlapSepare,
      duelSepare: sansDuels ? null : duelSepare,
      instrumentValide,
      minOverlapPlafond,
      maxOverlapRejete,
      moyenneOverlapGold: moyenneGold,
      minVictoiresPlafond: sansDuels ? null : minVictoiresPlafond,
      maxVictoiresRejete: sansDuels ? null : maxVictoiresRejete,
    },
    sujets: resultats.map((r) => ({
      cle: r.cle,
      titre: r.titre,
      groupe: r.groupe,
      chemin: r.chemin,
      composition: r.composition,
      duel: r.duel,
    })),
    temoinsGold,
    coutSessionEur: spentEur(),
  }
  const jsonPath = join(SORTIE_DIR, 'e1-rapport.json')
  writeFileSync(jsonPath, JSON.stringify(rapport, null, 2))

  const md = [
    `# E1 — calibration de la mesure v6 (${new Date().toISOString().slice(0, 10)})`,
    '',
    `Instrument : ${MESURE_VERSION}`,
    `Seuils overlap : passage ≥ ${OVERLAP_PASSAGE} · éliminatoire < ${OVERLAP_ELIMINATOIRE}`,
    '',
    '| sujet | groupe | overlap | verdict | duels (victoires/joués) | cohérents |',
    '|---|---|---|---|---|---|',
    ...resultats.map(
      (r) =>
        `| ${r.cle} | ${r.groupe} | ${r.composition.overlapRatio.toFixed(3)} | ${r.composition.verdict} | ${
          r.duel ? `${r.duel.victoires}/${r.duel.duels} (${r.duel.verdict})` : '—'
        } | ${r.duel ? `${r.duel.coherents}/${r.duel.duels}` : '—'} |`
    ),
    '',
    '## Témoins gold (borne haute)',
    '',
    '| pièce | overlap | verdict |',
    '|---|---|---|',
    ...temoinsGold.map((t) => `| ${t.slug} | ${t.composition.overlapRatio.toFixed(3)} | ${t.composition.verdict} |`),
    '',
    '## Verdict',
    '',
    `- overlap sépare plafond/rejetés : **${overlapSepare ? 'OUI' : 'NON'}** (plafond min ${minOverlapPlafond.toFixed(3)} vs rejetés max ${maxOverlapRejete.toFixed(3)})`,
    sansDuels ? '- duels : non joués' : `- duels séparent : **${duelSepare ? 'OUI' : 'NON'}** (plafond min ${minVictoiresPlafond} vs rejetés max ${maxVictoiresRejete})`,
    `- **instrument ${instrumentValide ? 'VALIDE' : 'INVALIDE'}**`,
    '',
    `Coût session 6 après E1 : ${spentEur().toFixed(4)} € / ${CAP_EUR.toFixed(2)} €`,
  ].join('\n')
  writeFileSync(join(SORTIE_DIR, 'e1-rapport.md'), md)
  console.log(`\nRapport écrit : ${jsonPath}`)
}

main().catch((err) => {
  console.error('\nE1 interrompu :', (err as Error).message)
  process.exit(1)
})
