/*
 * Run 7 — CALIBRAGE de la garde « sujet_lisible », avant de la laisser décider.
 *
 * Leçon E1 du run 6, littéralement : « un instrument qui valide n'est pas un
 * instrument qui prédit ». Cette garde est neuve, elle est sémantique, et elle
 * va refuser des candidats. On la passe donc d'abord sur des pièces dont on
 * connaît la réponse :
 *
 *   - les deux CIBLES du mandat et trois exemplaires canoniques → doivent PASSER,
 *     ce sont des marques réelles qui représentent quelque chose ;
 *   - le candidat VULCAIN du tour précédent (aplat orange percé d'un trou) →
 *     doit ÉCHOUER, c'est précisément le cas qui a motivé la garde.
 *
 * Si un seul de ces six verdicts tombe à l'envers, la garde n'est pas utilisable
 * et il faut le savoir AVANT de payer huit tours de traceur.
 *
 *   bun run scripts/calibration/v7-calibre-sujet.ts
 *
 * Coût : six appels flash, ~0,004 €.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import sharp from 'sharp'
import { installBudgetGuard, setBudgetLabel, setPhase, spentForPhase, V7_DIR } from './budget7'
import { chargeRegles, DOSSIER_LOGOS, SUJETS } from './v7-sujets'
import { decisionSujet } from './v7-gardes'
import { renduSvg } from './v7-lib'
import { visionJson } from './v7-vision'

installBudgetGuard()
setPhase('p3-svg')
setBudgetLabel('p3-calibrage-sujet')

const MODELE = 'gemini-3.5-flash'
const CONSIGNE = `Look at this shape. Name what it DEPICTS, in one or two words - the thing a stranger would say it is.

Judge only the drawn shape. If it depicts nothing you can name, answer exactly "nothing". Do not invent a meaning, do not guess a brand, do not describe the geometry unless geometry is genuinely all there is.

Return this JSON and nothing else: {"nom": "...", "sur_de_soi": true}`

async function nomme(jpg: Buffer): Promise<{ nom: string } | null> {
  const r = await visionJson<{ nom: string }>({
    model: MODELE,
    imageBase64: jpg.toString('base64'),
    mimeType: 'image/jpeg',
    prompt: CONSIGNE,
    maxOutputTokens: 700,
  })
  if (!r.valeur) console.log(`      ⚠ illisible (${r.raison}) : ${r.brut.slice(0, 200)}`)
  return r.valeur
}

const regles = chargeRegles()

type Cas = { nom: string; chemin: string; svg?: boolean; attendu: 'passe' | 'echoue' }

const CAS: Cas[] = [
  ...SUJETS.map((s) => ({ nom: `cible ${s.cible}`, chemin: s.cibleChemin, attendu: 'passe' as const })),
  ...regles.canoniques.slice(0, 3).map((c) => ({ nom: `canonique ${c.slug}`, chemin: c.chemin, attendu: 'passe' as const })),
  {
    nom: 'candidat VULCAIN du tour précédent (aplat percé)',
    chemin: join(V7_DIR, 'svg', 'vulcain', 'mark.svg'),
    svg: true,
    attendu: 'echoue',
  },
]

console.log(`\n═══ CALIBRAGE de la garde « sujet_lisible » ═══`)
console.log(`  ${MODELE} · le modèle NOMME, le code tranche sur le lexique\n`)

const resultats: Array<{ cas: string; nom_lu: string; verdict: string; attendu: string; conforme: boolean }> = []

for (const c of CAS) {
  if (!existsSync(c.chemin)) {
    console.log(`  — ${c.nom} : absent (${c.chemin})`)
    continue
  }
  const jpg = c.svg
    ? await sharp(await renduSvg(readFileSync(c.chemin, 'utf-8'), 512)).flatten({ background: '#3a3a3a' }).jpeg({ quality: 92 }).toBuffer()
    : await sharp(c.chemin).resize(512, 512, { fit: 'cover' }).jpeg({ quality: 92 }).toBuffer()

  const lu = await nomme(jpg)
  const d = decisionSujet(lu?.nom)
  const verdict = lu === null ? 'indisponible' : d.passe ? 'passe' : 'echoue'
  const conforme = verdict === c.attendu
  resultats.push({ cas: c.nom, nom_lu: lu?.nom ?? '—', verdict, attendu: c.attendu, conforme })
  console.log(`  ${conforme ? '✓' : '✗'} ${c.nom}`)
  console.log(`      nommé « ${lu?.nom ?? '—'} » → ${verdict} (attendu ${c.attendu}) · ${d.detail}`)
}

const bons = resultats.filter((r) => r.conforme).length
writeFileSync(
  join(V7_DIR, 'calibrage-sujet.json'),
  JSON.stringify({ modele: MODELE, consigne: CONSIGNE, resultats, conformes: bons, total: resultats.length }, null, 2)
)
console.log(`\n  ${bons}/${resultats.length} verdicts conformes · ${spentForPhase('p3-svg').toFixed(4)} € sur la phase 3`)
console.log(
  bons === resultats.length
    ? `  → l'instrument sépare les deux populations. Utilisable.`
    : `  → ⚠ l'instrument NE sépare pas : ${resultats.filter((r) => !r.conforme).map((r) => `${r.cas} (lu « ${r.nom_lu} »)`).join(' · ')}`
)
