/*
 * Run 5.6 — UNE itération de calibration = un lancement de ce script.
 *
 * Usage :
 *   bun run scripts/calibration/iterate.ts --label=iter1 --brief=fruitz \
 *     [--famille=plat_premium|semi_flat_biseau|dimensionnelle] \
 *     [--fond=motif|scene|texture] [--extra=<bloc du registre>] \
 *     [--resolution=1K|2K] [--critic-regen] [--concept=N] [--fresh-concepts] \
 *     [--hypothese="…"] [--changement="…"]
 *   Modes spéciaux :
 *     --calibrate-jury=<slug>     : note un VRAI logo du corpus (sanity du jury)
 *     --score-only=<chemin.png>   : jury seul sur une image existante
 *     --derive-from=<label>       : dérive la version alpha du candidat <label>
 *
 * Chaque lancement : garde budget installée AVANT tout appel, candidat +
 * prompt + verdicts archivés dans captures/calibration/<label>/, section
 * ajoutée au journal calibration-log-2.md (coût cumulé en tête mis à jour).
 * La DÉCISION de l'itération est écrite à la main dans le journal par
 * l'opérateur après lecture des notes — le script ne conclut pas à sa place.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import {
  installBudgetGuard,
  spentEur,
  spentForLabel,
  CAP_EUR,
  CHECKPOINT_EUR,
  STOP_SANS_CONVERGENCE_EUR,
  CALIBRATION_DIR,
} from './budget4'
import { BRIEFS } from './briefs'
import { generateCandidate, DERIVE_ALPHA_VERSION, type FondImpose } from './generate'
import type { LogoFamilleRendu } from '../../src/lib/engine/logo-director'
import { LOGO_FAMILLES_RENDU } from '../../src/lib/engine/logo-director'
import { scoreCandidate, blindTest, JURY_PROMPT_VERSION, BLIND_VERSION, JURY_MODEL, type JuryScores } from './jury'
import { loadCorpusImage, mulberry32, toCorpusEncoding } from './corpus'
import sharp from 'sharp'

// ── Run 5.9 : le panel du jury EST le gold set (_gold-set.json) ──────────────
// Le panel « médian » du 5.5-5.8 notait contre la moyenne du corpus — c'est
// comme ça qu'un sticker à contour blanc a pris 9/10 (iter10b, checkpoint
// rejeté par l'opérateur). Le jury note désormais contre les pépites niveau
// cible, jamais contre la moyenne. FIXE pour la comparabilité inter-itérations.
export const JURY_REFS = ['logo', '4409091d08b9cb1da6aa3c72b0e1e0b4', 'branding', 'logo2', 'logo-sweetylife', 'c837de5b0bc55867b68557dc928c6c6c', 'flashmood-rp2', 'nin3plaz-1460350845051863082']

// Run 5.9 : journal 4 — les logs 5.5 (calibration-log.md), 5.6 (-2) et
// 5.7-5.8 (-3) restent intacts pour l'historique.
const JOURNAL_PATH = resolve(import.meta.dir, '../../../calibration-log-4.md')

type Args = Record<string, string | boolean>
function parseArgs(): Args {
  const out: Args = {}
  for (const raw of process.argv.slice(2)) {
    const m = raw.match(/^--([^=]+)(?:=(.*))?$/)
    if (m) out[m[1]!] = m[2] ?? true
  }
  return out
}

function hashSeed(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function fmtScores(s: JuryScores): string {
  const sig = s.signature_2015?.detectee ? ` · **SIGNATURE 2015 DÉTECTÉE** (${s.signature_2015.marqueurs.join(' ; ') || 'sans marqueur nommé'})` : ''
  return `relief_3d ${s.relief_3d} · glow ${s.glow} · matières ${s.matieres} · fond/présentation ${s.fond_presentation} · **fond travaillé ${s.fond_travaille}** · construction ${s.construction} · **FiveM-ness ${s.fivemness}/10**${sig}`
}

function ensureJournal() {
  if (existsSync(JOURNAL_PATH)) return
  writeFileSync(
    JOURNAL_PATH,
    [
      '# Calibration Run 5.7 — journal (session 3, pipeline par calques superposés)',
      '',
      `**Coût cumulé : 0.0000 € / plafond ${CAP_EUR.toFixed(2)} €** (garde dure : \`nevadesign-backend/scripts/calibration/budget.ts\` — refus avant envoi, grand livre \`captures/calibration/budget-ledger-3.json\`)`,
      '',
      'Préalable LOT 4 : clone test `logo_gtanew` RÉUSSI (captures/calibration/clone-gtanew/, 0,4164 €). Candidats produits par le pipeline calques (fond IA + emblème IA détouré + lettrage typographié local).',
      '',
      `Checkpoint obligatoire à ${CHECKPOINT_EUR.toFixed(2)} € · stop volontaire à ${STOP_SANS_CONVERGENCE_EUR.toFixed(2)} € sans convergence.`,
      `Jury : ${JURY_MODEL}, prompts ${JURY_PROMPT_VERSION}. Panel fixe : ${JURY_REFS.join(', ')}.`,
      '',
      '---',
      '',
    ].join('\n')
  )
}

function appendJournal(section: string) {
  ensureJournal()
  let content = readFileSync(JOURNAL_PATH, 'utf-8')
  content = content.replace(/\*\*Coût cumulé : [\d.]+ €/, `**Coût cumulé : ${spentEur().toFixed(4)} €`)
  writeFileSync(JOURNAL_PATH, content + section + '\n')
}

async function main() {
  installBudgetGuard()
  const args = parseArgs()
  const label = String(args.label ?? `iter-${Date.now()}`)
  const dir = join(CALIBRATION_DIR, label)
  mkdirSync(dir, { recursive: true })

  const before = spentEur()
  console.log(`── Budget : ${before.toFixed(4)} € dépensés / ${CAP_EUR.toFixed(2)} € (checkpoint ${CHECKPOINT_EUR} €, stop ${STOP_SANS_CONVERGENCE_EUR} € sans convergence)`)

  // Un flag de mode spécial passé SANS valeur (--calibrate-jury logo,
  // --score-only sans =) basculait silencieusement en génération payante
  // complète : on refuse net avant tout appel.
  for (const key of ['calibrate-jury', 'score-only', 'derive-from'] as const) {
    if (args[key] !== undefined && typeof args[key] !== 'string') {
      throw new Error(`--${key} exige une valeur avec = (ex. --${key}=<valeur>) — refus avant tout appel payant`)
    }
  }

  const rand = mulberry32(hashSeed(label))
  // Si la pièce sondée en mode calibrate-jury appartient au panel, elle en
  // sort le temps de l'appel (remplacée par l'ancre de réserve youso1).
  const probeSlug = typeof args['calibrate-jury'] === 'string' ? String(args['calibrate-jury']) : null
  const panelSlugs = JURY_REFS.includes(probeSlug ?? '')
    ? [...JURY_REFS.filter((s) => s !== probeSlug), 'youso1']
    : JURY_REFS
  const juryRefs = panelSlugs.map(loadCorpusImage)

  let candidatePng: Buffer
  let contexteLines: string[] = []

  if (typeof args['calibrate-jury'] === 'string') {
    // Sanity du jury : un VRAI logo du corpus doit scorer haut et passer l'aveugle
    const slug = String(args['calibrate-jury'])
    candidatePng = await sharp(loadCorpusImage(slug).jpeg).png().toBuffer()
    contexteLines = [`Mode : **calibrage du jury** — le « candidat » est le logo corpus \`${slug}\` (attendu : notes hautes, aveugle réussi).`]
  } else if (typeof args['score-only'] === 'string') {
    candidatePng = readFileSync(String(args['score-only']))
    contexteLines = [`Mode : **score-only** sur \`${args['score-only']}\`.`]
  } else if (typeof args['derive-from'] === 'string') {
    // Run 5.7 : la dérivation alpha est LOCALE et GRATUITE — le calque
    // lettrage+emblème sans fond (candidate-alpha.png) est déjà écrit par
    // l'itération source. Plus aucune « seconde passe » API.
    const fromLabel = String(args['derive-from'])
    const alphaPath = join(CALIBRATION_DIR, fromLabel, 'candidate-alpha.png')
    if (!existsSync(alphaPath)) {
      throw new Error(`${alphaPath} introuvable — l'itération source date d'avant le pipeline par calques (run 5.7) : régénère-la`)
    }
    candidatePng = readFileSync(alphaPath)
    contexteLines = [
      `Mode : **dérivation alpha** depuis \`${fromLabel}\` — ${DERIVE_ALPHA_VERSION} (lecture du calque, zéro appel).`,
    ]
  } else {
    const briefId = String(args.brief ?? 'fruitz')
    const brief = BRIEFS[briefId]
    if (!brief) throw new Error(`brief inconnu : ${briefId}`)
    const resolution = args.resolution === '2K' ? '2K' as const : '1K' as const
    const famille = typeof args.famille === 'string' && (LOGO_FAMILLES_RENDU as readonly string[]).includes(args.famille)
      ? (args.famille as LogoFamilleRendu)
      : undefined
    if (args.famille && !famille) throw new Error(`famille inconnue : ${args.famille} (${LOGO_FAMILLES_RENDU.join(' | ')})`)
    const fondImpose = typeof args.fond === 'string' && ['motif', 'scene', 'texture'].includes(args.fond)
      ? (args.fond as FondImpose)
      : undefined
    if (args.fond && !fondImpose) throw new Error(`fond inconnu : ${args.fond} (motif | scene | texture)`)
    const result = await generateCandidate({
      brief,
      label,
      resolution,
      famille,
      fondImpose,
      extra: typeof args.extra === 'string' ? args.extra : undefined,
      // Run 5.9 : la régénération ciblée est ACTIVE PAR DÉFAUT, comme en prod.
      // Le run 5.8 la laissait éteinte (flag --critic-regen jamais passé) : le
      // journal vantait un filet qui ne tournait pas. --no-critic-regen pour
      // l'éteindre explicitement dans une expérience contrôlée.
      criticRegen: !args['no-critic-regen'],
      // Run 5.9 : --lockup-libre = variante de comparaison (génération 5.8
      // sans base typographique) ; défaut = base typo locale.
      lockupBase: !args['lockup-libre'],
      conceptIndex: args.concept !== undefined ? Number(args.concept) : undefined,
      freshConcepts: Boolean(args['fresh-concepts']),
    })
    candidatePng = result.png
    // Run 5.8 : les calques de la pile sont archivés avec le candidat —
    // l'alpha sert à la dérivation gratuite, fond/lockup/emblème au
    // diagnostic, les prompts calques réels au rejeu.
    writeFileSync(join(dir, 'candidate-alpha.png'), result.alphaPng)
    if (result.fondPng) writeFileSync(join(dir, 'calque-fond.png'), result.fondPng)
    if (result.lockupPng) writeFileSync(join(dir, 'calque-lockup.png'), result.lockupPng)
    if (result.emblemePng) writeFileSync(join(dir, 'calque-embleme.png'), result.emblemePng)
    writeFileSync(join(dir, 'prompt.txt'), result.prompt)
    writeFileSync(join(dir, 'prompts-calques.json'), JSON.stringify(result.promptsCalques, null, 2))
    writeFileSync(
      join(dir, 'pipeline.json'),
      JSON.stringify(
        {
          brief: briefId,
          resolution,
          famille: famille ?? null,
          fondImpose: fondImpose ?? null,
          extra: result.extraVersion,
          concept: { index: result.conceptIndex, nom: result.concept.nom, famille: result.concept.famille, rendu: result.concept.rendu, source: result.conceptSource },
          referencesJointes: result.referencesSlugs,
          ocrRejects: result.ocrRejects,
          modeLockup: result.modeLockup,
          lockupBaseUtilisee: result.lockupBaseUtilisee,
          fallbackLettrageLocal: result.fallbackLettrageLocal,
          criticRegen: !args['no-critic-regen'],
          regenere: result.regenere,
          calqueRegenere: result.calqueRegenere,
          critic: { ok: result.critic.ok, adnOk: result.critic.adnOk, fondOk: result.critic.fondOk, serveurLogo: result.critic.serveurLogo, lisible64: result.critic.lisible64, scores: result.critic.scores, defauts: result.critic.defauts },
        },
        null,
        2
      )
    )
    contexteLines = [
      `Brief : **${briefId}** · famille : **${result.concept.famille}** · fond imposé : **${fondImpose ?? 'libre (DA)'}**${result.extraVersion ? ` · extra : ${result.extraVersion}` : ''} · résolution ${resolution} · concept #${result.conceptIndex} « ${result.concept.nom} » (${result.conceptSource}) · réfs jointes : ${result.referencesSlugs.join(', ')}`,
      `Marque : **${result.modeLockup ? 'lockup fusionné IA' : result.fallbackLettrageLocal ? 'FALLBACK lettrage local (orthographe lockup 3× KO)' : 'emblème + lettrage local'}** · OCR : ${result.ocrRejects} rejet(s) · critique production : ok=${result.critic.ok} (fond=${result.critic.fondOk}, adn=${result.critic.adnOk}, relief ${result.critic.scores.relief}, glow ${result.critic.scores.glow})${result.regenere ? ` · régénéré 1× (${result.calqueRegenere})` : ''}`,
    ]
  }

  writeFileSync(join(dir, 'candidate.png'), candidatePng)

  // ── Jury : notation comparative + test à l'aveugle ─────────────────────────
  const scores = await scoreCandidate({ candidatePng, refs: juryRefs, label: `${label}-jury` })
  // La pièce sondée (calibrate-jury) est EXCLUE de ses propres trios d'aveugle.
  const blind = await blindTest({ candidatePng, rand, label: `${label}-aveugle`, exclude: probeSlug ? [probeSlug] : [] })
  writeFileSync(join(dir, 'jury.json'), JSON.stringify({ juryVersion: JURY_PROMPT_VERSION, blindVersion: BLIND_VERSION, panel: panelSlugs, scores, blind }, null, 2))

  const after = spentEur()
  const iterCost = spentForLabel(label) + spentForLabel(`${label}-jury`) + spentForLabel(`${label}-aveugle`)

  console.log(`\n── Notes jury : ${fmtScores(scores)}`)
  for (const d of scores.defauts) console.log(`   ✗ ${d.critere} — ${d.defaut}`)
  console.log(`── Aveugle : intrus identifié ${blind.identifiedCount}/3 → ${blind.passed ? 'PASSE dans la famille' : 'REPÉRÉ comme intrus'}`)
  for (const r of blind.rounds) console.log(`   manche : candidat en ${r.candidatePosition}, choisi ${r.intrusChoisi} — ${r.raison}`)
  console.log(`── Coût itération : ${iterCost.toFixed(4)} € · cumulé : ${after.toFixed(4)} €`)

  if (after >= CHECKPOINT_EUR) console.log(`\n⚠ CHECKPOINT ${CHECKPOINT_EUR} € franchi — bilan intermédiaire OBLIGATOIRE au journal.`)
  if (after >= STOP_SANS_CONVERGENCE_EUR) console.log(`⚠ SEUIL ${STOP_SANS_CONVERGENCE_EUR} € franchi — STOP volontaire si pas de convergence.`)

  // ── Journal ────────────────────────────────────────────────────────────────
  const hypothese = typeof args.hypothese === 'string' ? args.hypothese : '(itération sans hypothèse déclarée — à compléter)'
  const changement = typeof args.changement === 'string' ? args.changement : '(aucun changement déclaré)'
  appendJournal(
    [
      `## ${label}`,
      '',
      `- **Coût** : itération ${iterCost.toFixed(4)} € · cumulé ${after.toFixed(4)} € / ${CAP_EUR.toFixed(2)} €`,
      `- **Hypothèse** : ${hypothese}`,
      `- **Changement (diff exact)** : ${changement}`,
      ...contexteLines.map((l) => `- ${l}`),
      `- **Notes jury** (${JURY_PROMPT_VERSION}, panel ${JURY_REFS.join('/')}) : ${fmtScores(scores)}`,
      ...(scores.defauts.length ? [`- **Défauts nommés** :`, ...scores.defauts.map((d) => `  - ${d.critere} — ${d.defaut}`)] : ['- Aucun défaut nommé.']),
      `- **Aveugle** (${BLIND_VERSION}) : identifié ${blind.identifiedCount}/3 → ${blind.passed ? '**PASSE**' : '**repéré**'} (${blind.rounds.map((r) => `${r.identified ? '✗' : '✓'} ${r.raison}`).join(' · ')})`,
      `- **Décision** : _(à écrire par l'opérateur)_`,
      '',
    ].join('\n')
  )
  console.log(`\nArchivé : ${dir}\nJournal : ${JOURNAL_PATH}`)
}

await main()
