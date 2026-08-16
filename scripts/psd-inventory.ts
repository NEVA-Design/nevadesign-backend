/**
 * Run 5.7 — LOT 1.3 : inventaire des manifests psd-knowledge.
 *
 * Agrège tous les manifest.json produits par psd-decompose.ts :
 *  - comptes globaux (PSD, calques, groupes, textes, masques)
 *  - tableau des polices (nom → occurrences → PSD où elles apparaissent)
 *  - effets ACTIVÉS avec distributions chiffrées (stroke px/couleur/position,
 *    glows, gradients, dropShadow, bevel)
 *  - fréquence des modes de fusion et des opacités partielles
 *  - premier chiffrage de l'arbitrage LOT 2 : calques texte vs lettrage raster
 *
 * Sortie : _inventory.json (données) + _inventory.md (rapport lisible).
 * Usage : bun scripts/psd-inventory.ts [--root src/engine/psd-knowledge]
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

type Json = Record<string, unknown>;

const args = process.argv.slice(2);
const rootIdx = args.indexOf("--root");
const ROOT = (rootIdx >= 0 ? args[rootIdx + 1] : undefined) ?? join(import.meta.dir, "..", "src", "engine", "psd-knowledge");

interface EffectSample { psd: string; layer: string; [k: string]: unknown }

const fonts = new Map<string, { count: number; psds: Set<string>; sizes: number[]; texts: string[] }>();
const blendModes = new Map<string, number>();
const effectSamples: Record<string, EffectSample[]> = {};
const perPsd: Json[] = [];
let totals = { layers: 0, groups: 0, text: 0, masks: 0, adjustments: 0, smartObjects: 0, partialOpacity: 0 };

function num(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "value" in (v as Json)) return (v as Json).value as number;
  return undefined;
}

/** Normalise une couleur : hex déjà sérialisé, ou {fr,fg,fb} flottants résiduels. */
function colorStr(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "fr" in (v as Json)) {
    const o = v as { fr: number; fg: number; fb: number };
    const h = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, "0");
    return `#${h(o.fr)}${h(o.fg)}${h(o.fb)}`;
  }
  return undefined;
}

function collectEffect(type: string, e: Json, psd: string, layer: string): void {
  if (e.enabled === false) return;
  const s: EffectSample = { psd, layer };
  for (const k of ["blendMode", "opacity", "position", "fillType", "technique", "style", "source", "angle", "reverse", "align"]) {
    if (e[k] !== undefined) s[k] = e[k];
  }
  const c = colorStr(e.color);
  if (c) s.color = c;
  for (const k of ["size", "distance", "choke", "depth", "soften"]) {
    const v = num(e[k]);
    if (v !== undefined) s[k] = v;
  }
  if (e.gradient) {
    const g = e.gradient as Json;
    s.gradientStops = ((g.colorStops ?? []) as Json[]).map((st) => ({ color: colorStr(st.color) ?? st.color, location: st.location }));
    s.gradientName = g.name;
  }
  (effectSamples[type] ??= []).push(s);
}

function walk(n: Json, psd: string, acc: { text: number; raster: number; vector: number; textNames: string[] }): void {
  const kind = n.kind as string;
  if (kind === "group") totals.groups++;
  else {
    totals.layers++;
    if (kind === "text") { totals.text++; acc.text++; acc.textNames.push(String(n.name)); }
    else if (kind === "adjustment") totals.adjustments++;
    else acc.raster++;
    if (n.vectorMask) acc.vector++;
  }
  if (n.smartObject) totals.smartObjects++;
  if (n.mask) totals.masks++;
  const op = n.opacity as number;
  if (op < 1 && op > 0) totals.partialOpacity++;
  blendModes.set(String(n.blendMode), (blendModes.get(String(n.blendMode)) ?? 0) + 1);

  const t = n.text as Json | undefined;
  if (t) {
    const names = new Set<string>();
    if (t.font) names.add(String(t.font));
    for (const r of (t.styleRuns ?? []) as Json[]) if (r.font) names.add(String(r.font));
    for (const f of names) {
      const rec = fonts.get(f) ?? { count: 0, psds: new Set(), sizes: [], texts: [] };
      rec.count++;
      rec.psds.add(psd);
      const fs = num(t.fontSize);
      if (fs) rec.sizes.push(Math.round(fs));
      if (t.text) rec.texts.push(String(t.text).replace(/\s+/g, " ").slice(0, 40));
      fonts.set(f, rec);
    }
  }

  const fx = n.effects as Json | undefined;
  if (fx) {
    for (const [type, val] of Object.entries(fx)) {
      if (type === "scale" || type === "disabled") continue;
      for (const e of Array.isArray(val) ? val : [val]) {
        if (e && typeof e === "object") collectEffect(type, e as Json, psd, String(n.path ?? n.name));
      }
    }
  }
  for (const c of (n.children ?? []) as Json[]) walk(c, psd, acc);
}

const dirs = readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
for (const dir of dirs) {
  const mPath = join(ROOT, dir, "manifest.json");
  if (!existsSync(mPath)) continue;
  const m = JSON.parse(readFileSync(mPath, "utf8")) as Json;
  const acc = { text: 0, raster: 0, vector: 0, textNames: [] as string[] };
  for (const n of (m.tree ?? []) as Json[]) walk(n, dir, acc);
  perPsd.push({
    psd: m.psd, dir, width: m.width, height: m.height,
    stats: m.stats,
    textLayers: acc.text, rasterLayers: acc.raster, vectorMasks: acc.vector,
    textLayerNames: acc.textNames,
  });
}

// distributions numériques par type d'effet
function distrib(values: number[]): Json | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return {
    n: values.length,
    min: sorted[0], max: sorted[sorted.length - 1],
    median: q(0.5), p25: q(0.25), p75: q(0.75),
    mean: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100,
  };
}

const effectStats: Json = {};
for (const [type, samples] of Object.entries(effectSamples)) {
  const numKeys = ["size", "distance", "choke", "depth", "soften", "opacity", "angle"];
  const st: Json = { enabledCount: samples.length, psds: [...new Set(samples.map((s) => s.psd))] };
  for (const k of numKeys) {
    const vals = samples.map((s) => s[k]).filter((v): v is number => typeof v === "number");
    const d = distrib(vals);
    if (d) st[k] = d;
  }
  const colors = samples.map((s) => s.color).filter(Boolean) as string[];
  if (colors.length) {
    const cc = new Map<string, number>();
    for (const c of colors) cc.set(c, (cc.get(c) ?? 0) + 1);
    st.colors = [...cc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([c, n]) => `${c}×${n}`);
  }
  const positions = samples.map((s) => s.position).filter(Boolean) as string[];
  if (positions.length) {
    const pc = new Map<string, number>();
    for (const p of positions) pc.set(p, (pc.get(p) ?? 0) + 1);
    st.positions = Object.fromEntries(pc);
  }
  st.samples = samples;
  effectStats[type] = st;
}

const fontTable = [...fonts.entries()]
  .sort((a, b) => b[1].count - a[1].count)
  .map(([name, r]) => ({ font: name, occurrences: r.count, psds: [...r.psds], sizes: r.sizes, exemples: r.texts.slice(0, 5) }));

const inventory = {
  generatedAt: new Date().toISOString(),
  root: ROOT,
  psdCount: perPsd.length,
  totals,
  arbitrage: {
    note: "LOT 2 : (a) calques texte vs (b) lettrage raster/vecteur — chiffres bruts, la vision tranchera les cas raster",
    psdAvecCalquesTexte: perPsd.filter((p) => (p.textLayers as number) > 0).length,
    psdSansCalquesTexte: perPsd.filter((p) => (p.textLayers as number) === 0).length,
    totalCalquesTexte: totals.text,
  },
  perPsd,
  fonts: fontTable,
  blendModes: Object.fromEntries([...blendModes.entries()].sort((a, b) => b[1] - a[1])),
  effects: effectStats,
};

writeFileSync(join(ROOT, "_inventory.json"), JSON.stringify(inventory, null, 2));

// rapport markdown
const md: string[] = [];
md.push(`# Inventaire psd-knowledge — ${perPsd.length} PSD\n`);
md.push(`Totaux : ${totals.layers} calques (${totals.text} texte, ${totals.adjustments} réglages), ${totals.groups} groupes, ${totals.masks} masques, ${totals.smartObjects} objets dynamiques, ${totals.partialOpacity} opacités partielles.\n`);
md.push(`## Par PSD\n`);
md.push(`| PSD | Dim | Calques | Texte | Raster | Groupes |`);
md.push(`|---|---|---|---|---|---|`);
for (const p of perPsd) {
  const s = p.stats as Json;
  md.push(`| ${p.psd} | ${p.width}×${p.height} | ${s.layers} | ${p.textLayers} | ${p.rasterLayers} | ${s.groups} |`);
}
md.push(`\n## Tableau des polices (${fontTable.length})\n`);
md.push(`| Police | Occurrences | PSD | Tailles | Exemples |`);
md.push(`|---|---|---|---|---|`);
for (const f of fontTable) {
  md.push(`| ${f.font} | ${f.occurrences} | ${f.psds.join(", ")} | ${[...new Set(f.sizes)].join(", ")} | ${f.exemples.join(" · ")} |`);
}
md.push(`\n## Effets activés\n`);
for (const [type, st] of Object.entries(effectStats)) {
  const s = st as Json;
  md.push(`### ${type} — ${s.enabledCount} occurrences (${(s.psds as string[]).length} PSD)`);
  for (const k of ["size", "distance", "choke", "opacity"]) {
    const d = s[k] as Json | undefined;
    if (d) md.push(`- ${k} : médiane ${d.median}, p25-p75 [${d.p25}–${d.p75}], min-max [${d.min}–${d.max}] (n=${d.n})`);
  }
  if (s.colors) md.push(`- couleurs : ${(s.colors as string[]).join(", ")}`);
  if (s.positions) md.push(`- positions : ${JSON.stringify(s.positions)}`);
  const grads = (s.samples as EffectSample[]).filter((x) => x.gradientStops);
  for (const g of grads.slice(0, 12)) {
    const stops = (g.gradientStops as { color: unknown; location: unknown }[])
      .map((st) => `${st.color}@${typeof st.location === "number" ? Math.round((st.location as number) * 100) / 100 : st.location}`)
      .join(" → ");
    md.push(`- gradient [${g.psd} / ${g.layer}]${g.angle !== undefined ? ` angle ${g.angle}°` : ""} : ${stops}`);
  }
  md.push("");
}
md.push(`## Modes de fusion\n`);
md.push([...blendModes.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m}×${n}`).join(", "));
md.push(`\n## Arbitrage LOT 2 (premier chiffrage)\n`);
md.push(`- PSD avec calques texte : ${inventory.arbitrage.psdAvecCalquesTexte}/${perPsd.length}`);
md.push(`- PSD sans calques texte : ${inventory.arbitrage.psdSansCalquesTexte}/${perPsd.length}`);
md.push(`- Total calques texte : ${totals.text}`);

writeFileSync(join(ROOT, "_inventory.md"), md.join("\n"));
console.log(`Inventaire écrit : ${join(ROOT, "_inventory.json")} + _inventory.md`);
console.log(`${perPsd.length} PSD, ${totals.layers} calques, ${totals.text} textes, ${fontTable.length} polices, effets: ${Object.keys(effectStats).join(", ")}`);
