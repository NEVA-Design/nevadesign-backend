/*
 * Run 5.6 — LE CHECK ANTI-RÉGRESSION DE LA CALIBRATION, rejouable à volonté.
 *
 * Après TOUT futur changement du pipeline logo (gabarit, ADN, exemplars,
 * blocs du compilateur, modèles), relancer :
 *
 *   bun run scripts/calibration-check.ts            → protocole + coût, ZÉRO appel
 *   bun run scripts/calibration-check.ts --run      → exécute le check complet
 *   options : --brief=fruitz|azure|all (défaut all) · --resolution=1K|2K (défaut 1K)
 *
 * Le check rejoue les DEUX briefs de la definition of done avec le pipeline
 * de production (concepts frais, critique+régén), puis le jury figé de la
 * calibration (jury-v3, aveugle-v3.2, panel fixe) :
 *   PASS = FiveM-ness >= 8/10 ET fond travaillé >= 8/10 ET intrus <= 1/3.
 * Run 5.6 : le rubric a gagné le critère fond_travaille (un fond vide
 * plafonne la note globale à 6 EN CODE) — les candidats « fond bleu nuit
 * vide » qui passaient le check du 5.5 ne peuvent structurellement plus
 * passer. Un seuil raté = régression — comparer avec calibration-log-2.md
 * avant de committer le changement.
 *
 * La garde budget de la calibration s'applique (plafond dur partagé,
 * grand livre captures/calibration/budget-ledger-2.json).
 */

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { installBudgetGuard, spentEur, CAP_EUR, CALIBRATION_DIR } from './calibration/budget'
import { BRIEFS } from './calibration/briefs'
import { generateCandidate } from './calibration/generate'
import { scoreCandidate, blindTest, JURY_PROMPT_VERSION, BLIND_VERSION } from './calibration/jury'
import { loadCorpusImage, mulberry32 } from './calibration/corpus'

// Le panel FIXE du jury — identique à la calibration (iterate.ts).
const JURY_REFS = ['logo', 'venezia7', 'logo-sweetylife', 'adversitylife', 'logo2']

// Graine FIXE : les trios de l'aveugle sont rejouables d'un check à l'autre.
const CHECK_SEED = 20260816

const SEUIL_FIVEMNESS = 8
const SEUIL_FOND_TRAVAILLE = 8
const SEUIL_AVEUGLE = 1

type CheckArgs = { run: boolean; briefs: string[]; resolution: '1K' | '2K' }

function parseArgs(): CheckArgs {
  const argv = process.argv.slice(2)
  const briefArg = argv.find((a) => a.startsWith('--brief='))?.slice(8) ?? 'all'
  const resolution = argv.includes('--resolution=2K') ? '2K' as const : '1K' as const
  return {
    run: argv.includes('--run'),
    briefs: briefArg === 'all' ? ['fruitz', 'azure'] : [briefArg],
    resolution,
  }
}

// Coût mesuré pendant la calibration (grand livre) : génération 1K/2K avec
// concepts frais + critique ≈ 0,15-0,30 €, jury + aveugle ≈ 0,02 €.
const COST_PER_BRIEF_EUR = 0.32

async function main() {
  const args = parseArgs()

  console.log('═ CALIBRATION-CHECK (run 5.6) — anti-régression du pipeline logo ═')
  console.log(`Briefs : ${args.briefs.join(', ')} · résolution ${args.resolution}`)
  console.log(`Jury figé : ${JURY_PROMPT_VERSION} · ${BLIND_VERSION} · panel ${JURY_REFS.join(', ')}`)
  console.log(`Seuils : FiveM-ness >= ${SEUIL_FIVEMNESS}/10 ET fond travaillé >= ${SEUIL_FOND_TRAVAILLE}/10 ET aveugle <= ${SEUIL_AVEUGLE}/3`)
  console.log(`COÛT ESTIMÉ : ~${(COST_PER_BRIEF_EUR * args.briefs.length).toFixed(2)} € (${args.briefs.length} brief(s) × ~${COST_PER_BRIEF_EUR.toFixed(2)} €)`)
  console.log(`Budget calibration : ${spentEur().toFixed(4)} € déjà dépensés / plafond dur ${CAP_EUR.toFixed(2)} €`)

  if (!args.run) {
    console.log('\nZéro appel API effectué. Relance avec --run pour exécuter le check.')
    return
  }

  installBudgetGuard()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const juryRefs = JURY_REFS.map(loadCorpusImage)
  let regression = false

  for (const briefId of args.briefs) {
    const brief = BRIEFS[briefId]
    if (!brief) {
      console.error(`brief inconnu : ${briefId}`)
      continue
    }
    const label = `check-${stamp}-${briefId}`
    const dir = join(CALIBRATION_DIR, label)
    mkdirSync(dir, { recursive: true })

    console.log(`\n── ${briefId} : génération (pipeline de production 5.6, concepts frais)…`)
    const result = await generateCandidate({
      brief,
      label,
      resolution: args.resolution,
      criticRegen: true,
      freshConcepts: true,
    })
    writeFileSync(join(dir, 'candidate.png'), result.png)
    writeFileSync(join(dir, 'prompt.txt'), result.prompt)

    const scores = await scoreCandidate({ candidatePng: result.png, refs: juryRefs, label: `${label}-jury` })
    const blind = await blindTest({ candidatePng: result.png, rand: mulberry32(CHECK_SEED), label: `${label}-aveugle` })
    writeFileSync(join(dir, 'jury.json'), JSON.stringify({ juryVersion: JURY_PROMPT_VERSION, blindVersion: BLIND_VERSION, scores, blind }, null, 2))

    const notesOk = scores.fivemness >= SEUIL_FIVEMNESS
    const fondOk = scores.fond_travaille >= SEUIL_FOND_TRAVAILLE
    const aveugleOk = blind.identifiedCount <= SEUIL_AVEUGLE
    const pass = notesOk && fondOk && aveugleOk
    if (!pass) regression = true

    console.log(`   FiveM-ness ${scores.fivemness}/10 (${notesOk ? 'ok' : 'SOUS LE SEUIL'}) · fond travaillé ${scores.fond_travaille}/10 (${fondOk ? 'ok' : 'SOUS LE SEUIL'}) · aveugle ${blind.identifiedCount}/3 (${aveugleOk ? 'ok' : 'REPÉRÉ'})`)
    for (const d of scores.defauts) console.log(`   ✗ ${d.critere} — ${d.defaut}`)
    console.log(`   → ${pass ? '✓ PASS' : '✗ RÉGRESSION SUSPECTÉE'} — archivé : ${dir}`)
    console.log(`   NB : 1 tirage = 1 mesure bruitée. Un échec isolé se confirme par une relance avant conclusion (la calibration a mesuré ~1 faux négatif d'aveugle sur 3 tirages).`)
  }

  console.log(`\nBudget après check : ${spentEur().toFixed(4)} € / ${CAP_EUR.toFixed(2)} €`)
  if (regression) {
    console.log('✗ AU MOINS UN BRIEF SOUS LES SEUILS — comparer avec calibration-log-2.md avant de committer.')
    process.exitCode = 1
  } else {
    console.log('✓ Check complet : les acquis de la calibration run 5.6 tiennent.')
  }
}

await main()
