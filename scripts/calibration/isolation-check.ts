/*
 * Run 5.10 (chantier 2) — PREUVE D'ISOLATION sur un candidat réel.
 *
 * Usage :
 *   bun run scripts/calibration/isolation-check.ts --from=<label> [--mot=FRUITZ] [--resolution=2K]
 *
 * Lit captures/calibration/<label>/candidate.png (un rendu intégral), puis :
 *   1. appel d'ÉDITION d'isolation (re-rendu exact sur fond plat #F2F2F2,
 *      2 tentatives max, verdicts fond plat + glyphes en code) ;
 *   2. détourage DÉCONTAMINÉ → alpha ;
 *   3. sorties visuelles dans _pivot-510/ : rendu isolé, alpha posé sur
 *      fond sombre, et un comparatif zoomé ancien détourage vs décontaminé
 *      (le liseré blanc doit avoir disparu).
 * Le verdict reste à l'opérateur — ce script montre, il ne valide pas.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import sharp from 'sharp'
import { composeAlphaLocale, isolateLogoRender, poseSurCanevasCarre } from '../../src/lib/engine/logo-isolate'
import { cutoutFlatBackground, cutoutDecontamine } from '../../src/lib/engine/cutout'
import type { LogoConcept } from '../../src/lib/engine/logo-director'
import { installBudgetGuard, setBudgetLabel, spentEur, CALIBRATION_DIR } from './budget5'

installBudgetGuard()

type Args = Record<string, string | boolean>
const args: Args = {}
for (const raw of process.argv.slice(2)) {
  const m = raw.match(/^--([^=]+)(?:=(.*))?$/)
  if (m) args[m[1]!] = m[2] ?? true
}

const fromLabel = typeof args.from === 'string' ? args.from : null
if (!fromLabel) throw new Error('usage : --from=<label> [--mot=FRUITZ] [--resolution=2K]')
const mot = typeof args.mot === 'string' ? args.mot : 'FRUITZ'
const resolution = args.resolution === '4K' ? '4K' as const : args.resolution === '1K' ? '1K' as const : '2K' as const

const candidatePath = join(CALIBRATION_DIR, fromLabel, 'candidate.png')
if (!existsSync(candidatePath)) throw new Error(`${candidatePath} introuvable`)
const OUT = join(CALIBRATION_DIR, '_pivot-510')
mkdirSync(OUT, { recursive: true })

// ── La démo du chemin de production après 2 échecs : base typo locale ────────
async function demoFallback(): Promise<void> {
  const demoPath = typeof args['fallback-demo'] === 'string' ? String(args['fallback-demo']) : null
  if (!demoPath) return
  const famille = String(args['fallback-famille'] ?? 'dimensionnelle') as LogoConcept['famille']
  const cache = JSON.parse(readFileSync(join(CALIBRATION_DIR, demoPath), 'utf-8')) as { concepts: LogoConcept[] }
  const concept = cache.concepts.find((c) => c.famille === famille)
  if (!concept) throw new Error(`aucun concept de famille ${famille} dans ${demoPath}`)
  setBudgetLabel(`${fromLabel}-fallback`)
  console.log(`→ fallback base typographique locale (concept « ${concept.nom} », police ${concept.calques.lettrage?.police}) …`)
  const local = await composeAlphaLocale({
    recette: concept.calques,
    famille,
    palette: ['#FF6B4A', '#FFC4A3'],
    taille: 2048,
    log: { userId: 'calibration-run5.10', projectId: null, assetId: null, kind: `fallback_${fromLabel}` },
  })
  writeFileSync(join(OUT, `${fromLabel}-fallback-alpha.png`), local.alphaPng)
  await sharp({ create: { width: 2048, height: 2048, channels: 3, background: '#0b0e14' } })
    .composite([{ input: local.alphaPng }])
    .jpeg({ quality: 92 })
    .toFile(join(OUT, `${fromLabel}-fallback-alpha-sur-sombre.jpg`))
  console.log(`✓ fallback composé (emblème IA : ${local.emblemeGenere ? 'oui' : 'non'}) — ${join(OUT, `${fromLabel}-fallback-alpha-sur-sombre.jpg`)}`)
}

// --fallback-only : les 2 échecs d'isolation sont déjà constatés (archivés) —
// on démontre directement le chemin de production, sans repayer l'édition.
if (args['fallback-only']) {
  await demoFallback()
  console.log(`Dépense : ${spentEur().toFixed(4)} €`)
  process.exit(0)
}

setBudgetLabel(`${fromLabel}-isolation`)
const candidate = readFileSync(candidatePath)
console.log(`→ isolation de ${fromLabel} (mot « ${mot} », ${resolution}) …`)

const isolation = await isolateLogoRender({
  renderDataUrl: `data:image/png;base64,${candidate.toString('base64')}`,
  expectedWord: mot,
  resolution,
  log: { userId: 'calibration-run5.10', projectId: null, assetId: null, kind: `isolation_${fromLabel}` },
})

if (!isolation.ok) {
  console.error(`✗ isolation ÉCHOUÉE après ${isolation.tentatives} tentatives : ${isolation.raison}`)
  if (isolation.dernierIsolePng) {
    writeFileSync(join(OUT, `${fromLabel}-echec-rendu.png`), isolation.dernierIsolePng)
    console.error(`  Dernier rendu archivé : ${join(OUT, `${fromLabel}-echec-rendu.png`)}`)
  }
  // Le chemin de production après 2 échecs : la base typographique locale
  // composée comme aujourd'hui (--fallback-demo=concepts-<brief>-integral.json).
  await demoFallback()
  console.log(`Dépense : ${spentEur().toFixed(4)} €`)
  process.exit(2)
}

console.log(`✓ isolée en ${isolation.tentatives} tentative(s) — fond ${(isolation.cutout.fondRatio * 100).toFixed(1)} %, bbox ${(isolation.cutout.bboxFraction.width * 100).toFixed(0)}×${(isolation.cutout.bboxFraction.height * 100).toFixed(0)} %`)

writeFileSync(join(OUT, `${fromLabel}-isole.png`), isolation.isolePng)

// L'alpha posé sur canevas, puis sur fond sombre (le test visuel de la frange).
const alpha = await poseSurCanevasCarre(isolation.cutout.png, 2048, 0.72)
writeFileSync(join(OUT, `${fromLabel}-alpha.png`), alpha)
const surSombre = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: '#0b0e14' } })
  .composite([{ input: alpha }])
  .jpeg({ quality: 92 })
  .toFile(join(OUT, `${fromLabel}-alpha-sur-sombre.jpg`))
void surSombre

// Comparatif zoomé : ANCIEN détourage (flood-fill nu) vs DÉCONTAMINÉ, tous
// deux sur fond sombre, zoom ×2 sur le bord gauche de la marque — le liseré
// blanc de l'ancien chemin doit être visible à gauche et absent à droite.
const ancien = await cutoutFlatBackground(isolation.isolePng)
const decontamine = isolation.cutout
async function bordZoom(cutPng: Buffer): Promise<Buffer> {
  const posed = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#0b0e14' } })
    .composite([{ input: await sharp(cutPng).resize(760, 760, { fit: 'inside' }).png().toBuffer(), left: 132, top: 132 }])
    .png()
    .toBuffer()
  // zoom ×2,5 sur une fenêtre du bord gauche de la marque
  return sharp(posed).extract({ left: 96, top: 342, width: 340, height: 340 }).resize(850, 850, { kernel: 'nearest' }).png().toBuffer()
}
const zoomAncien = await bordZoom(ancien.png)
const zoomNeuf = await bordZoom(decontamine.png)
const barre = (texte: string) =>
  Buffer.from(
    `<svg width="850" height="56"><rect width="850" height="56" fill="#111"/><text x="16" y="38" font-family="Arial" font-size="30" fill="#fff">${texte}</text></svg>`
  )
await sharp({ create: { width: 1720, height: 906, channels: 3, background: '#111' } })
  .composite([
    { input: barre('ANCIEN détourage (flood-fill nu)'), left: 0, top: 0 },
    { input: zoomAncien, left: 0, top: 56 },
    { input: barre('DÉCONTAMINÉ (érosion + bords repris)'), left: 870, top: 0 },
    { input: zoomNeuf, left: 870, top: 56 },
  ])
  .jpeg({ quality: 92 })
  .toFile(join(OUT, `${fromLabel}-bords-avant-apres.jpg`))

console.log(`Sorties : ${OUT}\\${fromLabel}-isole.png · -alpha.png · -alpha-sur-sombre.jpg · -bords-avant-apres.jpg`)
console.log(`Dépense session 5 : ${spentEur().toFixed(4)} €`)
