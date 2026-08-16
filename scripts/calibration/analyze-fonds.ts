/*
 * Run 5.6, LOT 1 — L'ANALYSE DÉDIÉE DES FONDS des 59 logos du corpus.
 *
 * Le verdict client du run 5.5 (« rien à voir avec la qualité demandée ») a
 * révélé le trou : l'entraînement v4 n'a JAMAIS persisté l'analyse du fond
 * des logos (fond: null dans le manifest). La doctrine client : le fond n'est
 * jamais vide — motifs, ou scène avec personnages/ville, avec des nuances de
 * couleur, le tout quasi invisible (« on les voit presque pas »).
 *
 * Ce script :
 *   1. décrit le fond de CHAQUE logo en 3 couches — base (couleur/dégradé/
 *      vignette, direction de lumière), texture (halftone, topo, grain, arcs,
 *      particules), scène (palmiers, skyline, silhouettes, feuillage) — avec
 *      OPACITÉ ESTIMÉE par couche (attendu corpus : 8-20 %) et palette ;
 *   2. synthétise EN CODE la nouvelle clé `fonds` de logo.json : taxonomie
 *      chiffrée des 3 familles (motif thématique / micro-scène contextuelle /
 *      texture graphique), fréquences, combinaisons, opacités moyennes ;
 *   3. calcule aussi la clé `familles_rendu` (clusters mécaniques du manifest
 *      v4 : plat premium relief<=2, semi-flat biseauté 3-5, dimensionnelle
 *      >=6) — la matière du LOT 2 (abrogation de la règle relief >= 2/3).
 *
 * Usage :  bun run scripts/calibration/analyze-fonds.ts [--dry]
 * Garde budget run 5.6 (6 €) active — chaque appel passe par le grand livre.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import sharp from 'sharp'
import { geminiMultimodal, type GeminiPart } from '../../src/lib/ai/gemini'
import { installBudgetGuard, setBudgetLabel, spentEur, CAP_EUR, CALIBRATION_DIR } from './budget'

const MODEL = 'gemini-3.5-flash'
const CHUNK_SIZE = 3
const EXEMPLARS_DIR = resolve(import.meta.dir, '../../src/engine/exemplars/fivem/logo')
const SOURCE_DIR = resolve(import.meta.dir, '../../../entrainement IA fivem/logo serveur fivem gtarp')
const LOGO_GUIDE_PATH = resolve(import.meta.dir, '../../src/engine/styles/fivem/logo.json')
const OUTPUT_PATH = join(CALIBRATION_DIR, 'fonds-analysis.json')

const FAMILLES_FOND = ['motif_thematique', 'micro_scene', 'texture_graphique', 'combinaison', 'vide'] as const
export type FamilleFond = (typeof FAMILLES_FOND)[number]

export type FondAnalysis = {
  base: { description: string; type: string; couleurs: string[]; lumiere: string }
  texture: { presente: boolean; elements: string; opacite_pct: number }
  scene: { presente: boolean; elements: string; opacite_pct: number }
  famille: FamilleFond
  nuances: string
  desaturation: string
}

type ManifestEntry = { slug: string; source: string; scores?: { relief_3d?: number; glow?: number } }

const SYSTEM = `You are a senior art director analyzing ONLY THE BACKGROUND of premium FiveM/GTA RP server logos. Ignore the mark/lettering itself entirely — describe what sits BEHIND it.

For EACH image provided (in order), return one JSON object:
{
  "base": {
    "description": "the base plane in one line: solid/gradient/vignette, which colors, where the light comes from",
    "type": "one of: degrade_directionnel | degrade_radial | vignette_sombre | aplat_nuance | clair",
    "couleurs": ["#RRGGBB", "#RRGGBB"],
    "lumiere": "light/glow direction and color in a few words, or 'none'"
  },
  "texture": {
    "presente": true/false,
    "elements": "graphic texture elements if any: halftone dots, topographic/marbled lines, grain, thin arcs/rings, sparse particles, diagonal streaks... ('none' if absent)",
    "opacite_pct": 0-100 — how VISIBLE this layer is over the base (0 = absent, 10 = barely visible, 100 = fully opaque)
  },
  "scene": {
    "presente": true/false,
    "elements": "scenic/motif elements if any: palm trees, city skyline, buildings, human silhouettes, foliage, doodle motifs, objects... ('none' if absent)",
    "opacite_pct": 0-100 — same visibility scale
  },
  "famille": "one of: motif_thematique (repeated doodles/motifs derived from a theme) | micro_scene (a contextual scene: palms, skyline, characters, environment) | texture_graphique (abstract graphic texture only) | combinaison (texture AND scene/motif together) | vide (base alone, nothing else)",
  "nuances": "the color nuance work of the backdrop in one line: gradient direction, vignette, glow halo, hue shifts",
  "desaturation": "one line: how discreet/desaturated the texture+scene layers are vs the base (e.g. 'heavily darkened, nearly invisible' / 'loud and sharp')"
}
MEASURE what you see — opacity percentages are estimates of visibility, be honest and precise (most premium corpus backgrounds keep these layers at 8-20%). Answer with a JSON array, one object per image, nothing else.`

function loadManifest(): ManifestEntry[] {
  const manifest = JSON.parse(readFileSync(join(EXEMPLARS_DIR, '_manifest.json'), 'utf-8')) as {
    exemplaires: ManifestEntry[]
  }
  return manifest.exemplaires
}

// L'image ANALYSÉE est la source haute résolution quand elle existe (les
// exemplars 768 px suffisent en secours) — un fond à 8-20 % d'opacité se lit
// mal sur une vignette Discord de 2 Ko.
async function toAnalysisJpeg(entry: ManifestEntry): Promise<Buffer> {
  const sourcePath = join(SOURCE_DIR, entry.source)
  const path = existsSync(sourcePath) ? sourcePath : join(EXEMPLARS_DIR, `${entry.slug}.jpg`)
  return sharp(path)
    .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#000000' })
    .jpeg({ quality: 82 })
    .toBuffer()
}

function isFondAnalysis(v: unknown): v is FondAnalysis {
  const a = v as FondAnalysis | null
  return Boolean(
    a && a.base && typeof a.base.description === 'string' && a.texture && a.scene &&
    typeof a.famille === 'string' && (FAMILLES_FOND as readonly string[]).includes(a.famille)
  )
}

function clampPct(n: unknown): number {
  const v = Number(n)
  return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 0
}

async function analyzeChunk(chunk: ManifestEntry[], jpegs: Buffer[]): Promise<Array<FondAnalysis | null>> {
  const parts: GeminiPart[] = [
    { text: `Analyze the BACKGROUND of these ${chunk.length} FiveM server logos, in order.` },
    ...jpegs.map((b) => ({ inlineData: { mimeType: 'image/jpeg', data: b.toString('base64') } })),
  ]
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const text = await geminiMultimodal({
        model: MODEL,
        parts,
        systemInstruction: SYSTEM,
        json: true,
        temperature: 0.1,
        maxOutputTokens: 2600,
        thinkingBudget: 0,
      })
      const parsed = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim())
      const items = (Array.isArray(parsed) ? parsed : [parsed]) as unknown[]
      if (items.length === chunk.length && items.every(isFondAnalysis)) return items as FondAnalysis[]
    } catch {
      // nouvelle tentative du lot
    }
  }
  // repli 100 % couverture : image par image
  const out: Array<FondAnalysis | null> = []
  for (let i = 0; i < chunk.length; i += 1) {
    try {
      const text = await geminiMultimodal({
        model: MODEL,
        parts: [
          { text: 'Analyze the BACKGROUND of this single FiveM server logo.' },
          { inlineData: { mimeType: 'image/jpeg', data: jpegs[i]!.toString('base64') } },
        ],
        systemInstruction: SYSTEM,
        json: true,
        temperature: 0.1,
        maxOutputTokens: 900,
        thinkingBudget: 0,
      })
      const parsed = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim())
      const item = Array.isArray(parsed) ? parsed[0] : parsed
      out.push(isFondAnalysis(item) ? item : null)
    } catch {
      out.push(null)
    }
  }
  return out
}

// ── Synthèse EN CODE (jamais des adjectifs) ──────────────────────────────────
function pct(part: number, total: number): number {
  return total ? Math.round((part / total) * 100) : 0
}

function mean(values: number[]): number {
  return values.length ? Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10 : 0
}

export function synthesizeFonds(analyses: Record<string, FondAnalysis>) {
  const list = Object.values(analyses)
  const n = list.length
  const parFamille = Object.fromEntries(
    FAMILLES_FOND.map((f) => [f, pct(list.filter((a) => a.famille === f).length, n)])
  ) as Record<FamilleFond, number>
  const textures = list.filter((a) => a.texture.presente && a.texture.opacite_pct > 0)
  const scenes = list.filter((a) => a.scene.presente && a.scene.opacite_pct > 0)
  const combinaisons = list.filter((a) => a.texture.presente && a.scene.presente)
  const nonVides = list.filter((a) => a.famille !== 'vide')
  const opaciteTexture = mean(textures.map((a) => a.texture.opacite_pct))
  const opaciteScene = mean(scenes.map((a) => a.scene.opacite_pct))
  // fourchette 10-90e percentile des opacités observées (toutes couches)
  const opacites = [...textures.map((a) => a.texture.opacite_pct), ...scenes.map((a) => a.scene.opacite_pct)].sort((x, y) => x - y)
  const p = (q: number) => opacites[Math.min(opacites.length - 1, Math.floor((q / 100) * opacites.length))] ?? 0

  return {
    images: n,
    fonds_non_vides_pct: pct(nonVides.length, n),
    familles: parFamille,
    texture_presente_pct: pct(textures.length, n),
    scene_presente_pct: pct(scenes.length, n),
    combinaison_texture_scene_pct: pct(combinaisons.length, n),
    opacite_moyenne_texture_pct: opaciteTexture,
    opacite_moyenne_scene_pct: opaciteScene,
    opacite_p10_p90_pct: [p(10), p(90)] as [number, number],
    resume_en:
      `${pct(nonVides.length, n)}% of corpus logo backgrounds are WORKED, never empty: ` +
      `${pct(scenes.length, n)}% carry a contextual micro-scene layer (palms, skyline, silhouettes, foliage — mean visibility ${opaciteScene}%), ` +
      `${pct(textures.length, n)}% a graphic texture layer (halftone, topo/marbled lines, arcs, grain, particles — mean visibility ${opaciteTexture}%), ` +
      `${pct(combinaisons.length, n)}% combine both. ` +
      `Layers sit at ${p(10)}-${p(90)}% visibility over a nuanced base (directional gradient, vignette, glow) and are desaturated: the backdrop is sensed, never watched.`,
  }
}

// Clusters de familles de RENDU — mécaniques, depuis les scores du manifest v4.
// C'est la donnée qui remplace la règle abrogée « >= 2 relief sur 3 ».
export function synthesizeFamillesRendu(entries: ManifestEntry[]) {
  const n = entries.length
  const relief = (e: ManifestEntry) => e.scores?.relief_3d ?? 0
  const plat = entries.filter((e) => relief(e) <= 2)
  const semi = entries.filter((e) => relief(e) >= 3 && relief(e) <= 5)
  const dim = entries.filter((e) => relief(e) >= 6)
  const glowPct = (list: ManifestEntry[]) => pct(list.filter((e) => (e.scores?.glow ?? 0) >= 5).length, list.length)
  return {
    source: 'manifest v4, seuils relief_3d <=2 / 3-5 / >=6',
    familles: [
      { famille: 'plat_premium', pct: pct(plat.length, n), glow_pct: glowPct(plat), description: 'flat premium silhouette/lettering, satin-matte fills, clean thick contours, optional soft glow' },
      { famille: 'semi_flat_biseau', pct: pct(semi.length, n), glow_pct: glowPct(semi), description: 'semi-flat two-tone marks, matte bevels, sharp fractures/cuts, dominant contour glow' },
      { famille: 'dimensionnelle', pct: pct(dim.length, n), glow_pct: glowPct(dim), description: 'deep bevel/extrusion, controlled chrome/metal, rim glow' },
    ],
    resume_en:
      `The corpus splits into three render families: flat premium ${pct(plat.length, n)}% (satin fills, thick contours), ` +
      `semi-flat beveled two-tone ${pct(semi.length, n)}% (matte bevels, fractures, ${glowPct(semi)}% carry glow), ` +
      `dimensional chrome/glow ${pct(dim.length, n)}%. No family is superior — a premium set covers them by these real weights.`,
  }
}

async function main() {
  const dry = process.argv.includes('--dry')
  const entries = loadManifest()
  console.log(`═ LOT 1 (run 5.6) — analyse des FONDS de ${entries.length} logos corpus ═`)
  console.log(`Budget : ${spentEur().toFixed(4)} € dépensés / plafond ${CAP_EUR.toFixed(2)} €`)
  const estimated = Math.ceil(entries.length / CHUNK_SIZE) * 0.005
  console.log(`Coût estimé : ~${estimated.toFixed(2)} € (${Math.ceil(entries.length / CHUNK_SIZE)} lots de ${CHUNK_SIZE} × ~0,005 €)`)
  if (dry) {
    console.log('Mode --dry : zéro appel API.')
    return
  }

  installBudgetGuard()
  setBudgetLabel('lot1-fonds-analyse')

  const analyses: Record<string, FondAnalysis> = {}
  const echecs: string[] = []
  for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
    const chunk = entries.slice(i, i + CHUNK_SIZE)
    const jpegs = await Promise.all(chunk.map(toAnalysisJpeg))
    const results = await analyzeChunk(chunk, jpegs)
    results.forEach((r, j) => {
      const slug = chunk[j]!.slug
      if (r) {
        r.texture.opacite_pct = clampPct(r.texture.opacite_pct)
        r.scene.opacite_pct = clampPct(r.scene.opacite_pct)
        analyses[slug] = r
      } else {
        echecs.push(slug)
      }
    })
    console.log(`  ${Math.min(i + CHUNK_SIZE, entries.length)}/${entries.length} analysés · ${spentEur().toFixed(4)} €`)
  }

  if (echecs.length) console.log(`  ! échecs résiduels (${echecs.length}) : ${echecs.join(', ')}`)

  const fonds = { genere_le: new Date().toISOString(), modele: MODEL, ...synthesizeFonds(analyses) }
  const famillesRendu = synthesizeFamillesRendu(entries)

  writeFileSync(OUTPUT_PATH, JSON.stringify({ genere_le: fonds.genere_le, modele: MODEL, analyses, echecs }, null, 2))

  // La clé `fonds` + `familles_rendu` rejoignent logo.json (guide v4) — la
  // lecture adn.ts les exige désormais comme l'ADN lui-même.
  const guide = JSON.parse(readFileSync(LOGO_GUIDE_PATH, 'utf-8')) as Record<string, unknown>
  guide.fonds = fonds
  guide.familles_rendu = famillesRendu
  writeFileSync(LOGO_GUIDE_PATH, JSON.stringify(guide, null, 2))

  console.log(`\n── Synthèse fonds : ${fonds.resume_en}`)
  console.log(`── Familles de rendu : ${famillesRendu.resume_en}`)
  console.log(`\nPersisté : ${OUTPUT_PATH}\n           ${LOGO_GUIDE_PATH} (clés fonds + familles_rendu)`)
  console.log(`Budget après analyse : ${spentEur().toFixed(4)} € / ${CAP_EUR.toFixed(2)} €`)

  // Contrôle de sanité imposé par le run : les références nommées du client.
  const sanity = ['c837de5b0bc55867b68557dc928c6c6c', 'flashmood-rp2', 'logo', 'valesiarp1']
  console.log('\n── Contrôle de sanité (références client) :')
  for (const slug of sanity) {
    const a = analyses[slug]
    if (!a) {
      console.log(`  ✗ ${slug} : analyse absente`)
      continue
    }
    console.log(`  ${slug} [${a.famille}] texture ${a.texture.presente ? `${a.texture.opacite_pct}% (${a.texture.elements})` : '—'} · scène ${a.scene.presente ? `${a.scene.opacite_pct}% (${a.scene.elements})` : '—'}`)
  }
}

await main()
