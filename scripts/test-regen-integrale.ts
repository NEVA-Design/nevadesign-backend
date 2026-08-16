/*
 * Run 5.10 (chantier 3) — LA PREUVE que la régénération se déclenche.
 * On a déjà été brûlés deux fois : le criticRegen jamais passé par la
 * calibration 5.8, et la regex « motif » qui visait le mauvais calque.
 * Ce script teste les DEUX décisions pures, sans aucun appel API :
 *   1. decideRegenIntegral (chemin intégral 5.10) — tout verdict en échec
 *      avec défauts nommés relance l'appel intégral ;
 *   2. buildRegenPromptIntegral — les défauts sont réellement INJECTÉS ;
 *   3. decideRegen / calqueCible (chemin calques, filet du fallback).
 *
 *   bun run scripts/test-regen-integrale.ts
 */

import { decideRegenIntegral, buildRegenPromptIntegral } from '../src/lib/engine/logo-integral'
import { decideRegen, calqueCible } from '../src/lib/engine/logo-pipeline'

let failures = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`}`)
  if (!ok) failures += 1
}

// ── 1. decideRegenIntegral — le chemin intégral 5.10 ─────────────────────────
check('intégral : verdict ok → pas de régénération', decideRegenIntegral({ ok: true, defauts: [] }), false)
check(
  'intégral : échec + défauts nommés → RÉGÉNÉRATION',
  decideRegenIntegral({ ok: false, defauts: ['quiet the backdrop'] }),
  true
)
check(
  'intégral : échec éliminatoire (sticker) → RÉGÉNÉRATION',
  decideRegenIntegral({ ok: false, defauts: ['remove the single thick border around the whole lockup — outline each letterform separately instead'] }),
  true
)
check('intégral : échec sans défaut nommé → pas de cible, pas de régénération', decideRegenIntegral({ ok: false, defauts: [] }), false)

// ── 2. buildRegenPromptIntegral — l'injection réelle des défauts ─────────────
const promptBase = 'Design a premium logo for a FiveM/GTA RP server named "FRUITZ", spelled F-R-U-I-T-Z.'
const defauts = ['deepen the bevel and extrusion of the lettering', 'quiet the backdrop: deep dark base']
const regen = buildRegenPromptIntegral(promptBase, defauts)
check('injection : le prompt de base survit', regen.startsWith(promptBase), true)
check('injection : chaque défaut est présent', defauts.every((d) => regen.includes(`- ${d}`)), true)
check('injection : la consigne de correction encadre les défauts', /CRITIC PASS FAILED/.test(regen), true)

// ── 3. decideRegen / calqueCible — le filet du chemin calques (fallback) ─────
check(
  'calques : calqueFautif structuré fait foi',
  decideRegen({ ok: false, calqueFautif: 'fond', defauts: ['motif emblem wrong'] }, { lockupMode: true, hasFond: true, hasEmbleme: false }),
  'fond'
)
check(
  'calques : « motif » seul ne cible plus le fond (piège 5.8)',
  calqueCible(['replace the wheat ear motif with a citrus slice'], { lockupMode: true }),
  'lockup'
)
check(
  'calques : verdict ok → null',
  decideRegen({ ok: true, calqueFautif: null, defauts: [] }, { lockupMode: true, hasFond: true, hasEmbleme: false }),
  null
)
check(
  'calques : cible indisponible → null (pas de régénération fantôme)',
  decideRegen({ ok: false, calqueFautif: null, defauts: ['fix the dolphin emblem silhouette'] }, { lockupMode: false, hasFond: false, hasEmbleme: false }),
  null
)

if (failures) {
  console.error(`\n${failures} échec(s) — la régénération N'EST PAS prouvée.`)
  process.exit(1)
}
console.log('\nTous les verdicts de régénération sont prouvés (intégral + calques).')
