/**
 * Run 5.7 — LOT 3.3 : test dédié de l'OCR d'exclusion (liste blanche stricte).
 * Fonction pure ocrDecision — zéro appel API. Le cas de non-régression majeur
 * est le bug « The Ocean Swell » du 5.6 : les bons mots présents + des mots
 * parasites passaient la porte.
 * Usage : bun scripts/test-ocr-exclusion.ts
 */
import { ocrDecision } from '../src/lib/engine/ocr-gate'

type Cas = {
  nom: string
  lu: string[]
  attendus: string[]
  forbidAnyText?: boolean
  expectedOptional?: boolean
  attenduOk: boolean
}

const CAS: Cas[] = [
  // ── le bug du 5.6 : mots EN TROP ──
  { nom: 'ocean-swell (bug 5.6)', lu: ['AZURE BAY', 'The Ocean Swell'], attendus: ['AZURE BAY'], attenduOk: false },
  { nom: 'slogan parasite', lu: ['FRUITZ', 'EST 2024'], attendus: ['FRUITZ'], attenduOk: false },
  { nom: 'watermark parasite', lu: ['FRUITZ', 'shutterstock'], attendus: ['FRUITZ'], attenduOk: false },
  // ── conformes ──
  { nom: 'exact simple', lu: ['FRUITZ'], attendus: ['FRUITZ'], attenduOk: true },
  { nom: 'casse et accents', lu: ['fruitz'], attendus: ['FRUITZ'], attenduOk: true },
  { nom: 'deux attendus', lu: ['AZURE', 'BAY'], attendus: ['AZURE BAY'], attenduOk: true },
  { nom: 'lecture en bloc', lu: ['AZUREBAY'], attendus: ['AZURE BAY'], attenduOk: true },
  { nom: 'fragment lu séparément', lu: ['FRU', 'ITZ'], attendus: ['FRUITZ'], attenduOk: true },
  { nom: 'concat de 2 attendus', lu: ['FRUITZRP'], attendus: ['FRUITZ', 'RP'], attenduOk: true },
  // ── orthographe ──
  { nom: 'lettre doublée', lu: ['FRUITZZ'], attendus: ['FRUITZ'], attenduOk: false },
  { nom: 'lettre manquante', lu: ['FRUTZ'], attendus: ['FRUITZ'], attenduOk: false },
  { nom: 'rien lu', lu: [], attendus: ['FRUITZ'], attenduOk: false },
  // ── micro-marques tolérées (< 3 caractères) ──
  { nom: 'micro-marque 2 lettres', lu: ['FRUITZ', 'XY'], attendus: ['FRUITZ'], attenduOk: true },
  // ── run 5.8 : lockup monogramme (présence non exigée, mots en trop rejetés) ──
  { nom: 'monogramme : rien lu', lu: [], attendus: ['F'], expectedOptional: true, attenduOk: true },
  { nom: 'monogramme : lettre lue', lu: ['F'], attendus: ['F'], expectedOptional: true, attenduOk: true },
  { nom: 'monogramme : mot parasite', lu: ['FLASH'], attendus: ['F'], expectedOptional: true, attenduOk: false },
  // ── mode exclusion totale (calques IA : fond, emblème) ──
  { nom: 'exclusion : propre', lu: [], attendus: [], forbidAnyText: true, attenduOk: true },
  { nom: 'exclusion : micro-marque', lu: ['ab'], attendus: [], forbidAnyText: true, attenduOk: true },
  { nom: 'exclusion : un mot', lu: ['OCEAN'], attendus: [], forbidAnyText: true, attenduOk: false },
  { nom: 'exclusion : phrase', lu: ['The Ocean Swell'], attendus: [], forbidAnyText: true, attenduOk: false },
]

let echecs = 0
for (const c of CAS) {
  const d = ocrDecision(c.lu, c.attendus, { forbidAnyText: c.forbidAnyText, expectedOptional: c.expectedOptional })
  const ok = d.ok === c.attenduOk
  if (!ok) echecs++
  console.log(
    `${ok ? 'PASS' : 'ÉCHEC'}  ${c.nom} — lu [${c.lu.join(', ')}] attendus [${c.attendus.join(', ')}]${c.forbidAnyText ? ' (exclusion)' : ''} → ok=${d.ok}${d.motsEnTrop.length ? ` motsEnTrop=[${d.motsEnTrop.join(',')}]` : ''}${d.attendusManquants.length ? ` manquants=[${d.attendusManquants.join(',')}]` : ''}`
  )
}
console.log(echecs ? `\n${echecs} ÉCHEC(S)` : `\n${CAS.length}/${CAS.length} PASS`)
process.exit(echecs ? 1 : 0)
