/*
 * Parseur des prompts de scène du client (run 5, LOT 2).
 *
 * « prompt for IA desgin.txt » contient 17 prompts de scène complets écrits
 * à la main (SCENE / CAMERA / POSE / LIGHTING / NEGATIVE…). Ce script les
 * transforme en TEMPLATES PARAMÉTRÉS : mêmes structures, mêmes exigences de
 * caméra et de lumière, mais les spécificités (lieu, tenue, pose, props,
 * étalonnage) deviennent des variables {placeholder} que le compilateur
 * remplit depuis les réponses du wizard.
 *
 * Usage :  bun run scripts/parse-scene-templates.ts
 * Sortie : src/engine/templates/fivem/scenes.json (versionné, one-shot)
 */

import { readFileSync, mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { geminiMultimodal, type GeminiUsage } from '../src/lib/ai/gemini'
import { estimateCostEur } from '../src/lib/engine/pricing'

const SOURCE = resolve(import.meta.dir, '../../entrainement IA fivem/prompt for IA desgin.txt')
const OUT_DIR = resolve(import.meta.dir, '../src/engine/templates/fivem')
const MODEL = 'gemini-3.5-flash'

const SYSTEM = `You convert a hand-written FiveM/GTA V image prompt into a reusable PARAMETERIZED TEMPLATE.

Return ONLY a JSON object:
{
  "id": "kebab-case-slug describing the scene archetype",
  "titre": "short French title (3-6 words) for a template picker UI",
  "scene_type": "lifestyle | action | portrait | interior | group | vehicle | object_still",
  "personnages": 0 | 1 | 2,
  "template": "the full rewritten prompt",
  "defaults": { "ambiance": "...", "lieu": "...", "tenue": "...", "pose": "...", "eclairage": "...", "props": "...", "etalonnage": "..." }
}

TEMPLATE RULES:
1. KEEP the original's structure, camera precision, perspective demands, and negative instructions — that craft is the value.
2. GENERALIZE specifics into variables written as {ambiance}, {lieu}, {tenue}, {pose}, {eclairage}, {props}, {etalonnage}. Use each variable at the natural place(s). Keep scene-defining geometry (camera distance, lens, framing) LITERAL, not variable.
3. "defaults" holds the ORIGINAL specifics extracted from the source prompt (English, terse) so the template rendered with defaults ≈ the original prompt.
4. The template MUST keep (or add) these hard rules in its negative section: "No readable text. No letters. No words. No watermark. No UI. No HUD. No signage with readable characters." and "No extra people. No distorted anatomy, no extra fingers."
5. If the source mentions reference characters, keep that mechanism ({personnages} count comes from the field, don't invent more people).
6. English for template + defaults. JSON only.`

async function run() {
  const raw = readFileSync(SOURCE, 'utf-8')
  const prompts = raw
    .split(/^-{20,}\s*$/m)
    .map((p) => p.trim())
    .filter((p) => p.length > 200)

  console.log(`${prompts.length} prompts trouvés dans le .txt`)
  mkdirSync(OUT_DIR, { recursive: true })

  const usage = { calls: 0, tokensIn: 0, tokensOut: 0 }
  const track = (u: GeminiUsage) => {
    usage.calls += 1
    usage.tokensIn += u.tokensIn
    usage.tokensOut += u.tokensOut
  }

  const templates: unknown[] = []
  const seenIds = new Set<string>()

  for (const [index, prompt] of prompts.entries()) {
    let parsed: { id?: string } | null = null
    for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
      const text = await geminiMultimodal({
        model: MODEL,
        parts: [{ text: `SOURCE PROMPT #${index + 1}:\n\n${prompt}` }],
        systemInstruction: SYSTEM,
        json: true,
        temperature: 0.2,
        maxOutputTokens: 5200,
        thinkingBudget: 256,
        onUsage: track,
      })
      try {
        parsed = JSON.parse(text)
      } catch {
        console.log(`  ! prompt ${index + 1} : JSON invalide (tentative ${attempt + 1})`)
      }
    }
    if (!parsed) {
      console.log(`  ✗ prompt ${index + 1} abandonné`)
      continue
    }
    // ids uniques
    let id = String(parsed.id ?? `scene-${index + 1}`)
    while (seenIds.has(id)) id = `${id}-2`
    seenIds.add(id)
    templates.push({ ...parsed, id, source_index: index + 1 })
    console.log(`  ✓ ${index + 1}/${prompts.length} — ${id}`)
  }

  const cost = estimateCostEur({ model: MODEL, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut })
  const output = {
    genere_le: new Date().toISOString(),
    modele: MODEL,
    source: 'prompt for IA desgin.txt',
    prompts_source: prompts.length,
    templates_produits: templates.length,
    cout: { appels: usage.calls, tokens_in: usage.tokensIn, tokens_out: usage.tokensOut, eur: cost },
    templates,
  }
  writeFileSync(join(OUT_DIR, 'scenes.json'), JSON.stringify(output, null, 2))
  console.log(`\n${templates.length}/${prompts.length} templates → ${join(OUT_DIR, 'scenes.json')}`)
  console.log(`COÛT : ${cost.toFixed(4)} € (${usage.tokensIn + usage.tokensOut} tokens)`)
}

await run()
