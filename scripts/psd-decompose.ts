/**
 * Run 5.7 — LOT 1 : décomposeur PSD.
 *
 * Décompose chaque PSD du PackPsd en :
 *  - manifest.json : arbre de calques complet (groupes, ordre z, opacités, modes
 *    de fusion, masques), effets de calque paramétrés (valeurs exactes),
 *    calques texte (police, graisse, taille, tracking, couleur).
 *  - layers/*.png : chaque calque ET chaque groupe rasterisé isolément (alpha préservé).
 *  - composite.png : le rendu aplati de référence.
 *
 * Usage :
 *   bun scripts/psd-decompose.ts --psd "<chemin.psd>" --out "<dossier-sortie>"
 *   bun scripts/psd-decompose.ts --all --pack "<dossier PackPsd>" --out "<racine psd-knowledge>"
 *
 * Mode --all : un sous-processus bun PAR PSD (fichiers jusqu'à 272 Mo — on ne
 * garde jamais deux PSD décodés dans le même espace mémoire).
 */

import { readFileSync, mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { readPsd, initializeCanvas, type Psd, type Layer } from "ag-psd";
import { createCanvas, Image, ImageData as NapiImageData } from "@napi-rs/canvas";

// ag-psd exige une implémentation canvas même en mode useImageData
// signature réelle : initializeCanvas(createCanvasMethod, createImageDataMethod)
initializeCanvas(
  ((w: number, h: number) => createCanvas(w, h)) as never,
  ((w: number, h: number) => new NapiImageData(w, h)) as never,
);
void Image; // gardé pour un éventuel decode JPEG ultérieur

// ---------- helpers de sérialisation ----------

type Json = Record<string, unknown>;

function toHex(c: { r?: number; g?: number; b?: number } | undefined): string | undefined {
  if (!c || typeof c.r !== "number") return undefined;
  const h = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g ?? 0)}${h(c.b ?? 0)}`;
}

/** Sérialise récursivement un objet d'effet ag-psd : UnitsValue → {value, units}, Color → hex. */
function serializeEffect(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(serializeEffect);
  const o = v as Json;
  // UnitsValue { units, value }
  if ("units" in o && "value" in o && Object.keys(o).length === 2) {
    return { value: o.value, units: o.units };
  }
  // Color { r, g, b }
  if ("r" in o && "g" in o && "b" in o && typeof o.r === "number") {
    return toHex(o as { r: number; g: number; b: number });
  }
  const out: Json = {};
  for (const [k, val] of Object.entries(o)) {
    if (val instanceof Uint8Array || val instanceof Uint8ClampedArray) continue; // pattern data etc.
    out[k] = serializeEffect(val);
  }
  return out;
}

function sanitize(name: string): string {
  return (name || "sans-nom").replace(/[^\p{L}\p{N} _.-]/gu, "_").replace(/\s+/g, " ").trim().slice(0, 60);
}

// ---------- rasterisation ----------

interface RawImage { width: number; height: number; data: Uint8ClampedArray }

async function savePng(img: RawImage, path: string): Promise<void> {
  const { width, height, data } = img;
  if (!width || !height) return;
  const channels = data.length === width * height * 4 ? 4 : data.length === width * height ? 1 : 0;
  if (channels === 0) throw new Error(`imageData inattendu: ${data.length} octets pour ${width}x${height}`);
  let buf: Buffer;
  if (channels === 1) {
    // masque monocanal → RGBA explicite (piège run 5 : sharp raw 1 canal désaligne)
    const rgba = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const g = data[i]!;
      rgba[i * 4] = g; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = g; rgba[i * 4 + 3] = 255;
    }
    buf = rgba;
  } else {
    buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  await sharp(buf, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 6 }).toFile(path);
}

/** Composite naïf d'un groupe : enfants visibles en source-over avec opacité (les modes
 *  de fusion exotiques sont notés dans le manifest, pas simulés). */
async function compositeGroup(
  children: { img: RawImage; left: number; top: number; opacity: number; hidden: boolean }[],
  bounds: { left: number; top: number; right: number; bottom: number },
  path: string,
): Promise<boolean> {
  const w = bounds.right - bounds.left, h = bounds.bottom - bounds.top;
  if (w <= 0 || h <= 0 || w * h > 120_000_000) return false;
  const visible = children.filter((c) => !c.hidden && c.img.width > 0 && c.img.height > 0);
  if (!visible.length) return false;
  let base = sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
  const overlays: OverlayOptions[] = [];
  for (const c of visible) {
    let raw = Buffer.from(c.img.data.buffer, c.img.data.byteOffset, c.img.data.byteLength);
    if (c.opacity < 1) {
      raw = Buffer.from(raw); // copie avant mutation
      for (let i = 3; i < raw.length; i += 4) raw[i] = Math.round(raw[i]! * c.opacity);
    }
    const png = await sharp(raw, { raw: { width: c.img.width, height: c.img.height, channels: 4 } }).png().toBuffer();
    overlays.push({ input: png, left: c.left - bounds.left, top: c.top - bounds.top });
  }
  await base.composite(overlays).png({ compressionLevel: 6 }).toFile(path);
  return true;
}

// ---------- extraction texte ----------

function extractText(layer: Layer): Json | undefined {
  const t = (layer as Json).text as Json | undefined;
  if (!t) return undefined;
  try {
    const style = (t.style ?? {}) as Json;
    const font = (style.font ?? {}) as Json;
    const runs = ((t.styleRuns ?? []) as Json[]).map((r) => {
      const s = (r.style ?? {}) as Json;
      const f = (s.font ?? {}) as Json;
      return {
        length: r.length,
        font: f.name,
        fontSize: s.fontSize,
        tracking: s.tracking,
        fauxBold: s.fauxBold,
        fauxItalic: s.fauxItalic,
        allCaps: s.autoLeading !== undefined ? s.fontCaps : s.fontCaps,
        fillColor: toHex(s.fillColor as { r: number; g: number; b: number }),
        strokeColor: toHex(s.strokeColor as { r: number; g: number; b: number }),
      };
    });
    return {
      text: t.text,
      font: font.name,
      fontSize: style.fontSize,
      tracking: style.tracking,
      fauxBold: style.fauxBold,
      fauxItalic: style.fauxItalic,
      fontCaps: style.fontCaps,
      fillColor: toHex(style.fillColor as { r: number; g: number; b: number }),
      strokeColor: toHex(style.strokeColor as { r: number; g: number; b: number }),
      orientation: t.orientation,
      transform: t.transform,
      styleRuns: runs.length ? runs : undefined,
    };
  } catch (e) {
    return { text: (t as Json).text, parseError: String(e) };
  }
}

// ---------- parcours de l'arbre ----------

interface Ctx { outDir: string; counter: { n: number }; stats: { layers: number; groups: number; text: number; pngs: number; masks: number } }

async function walkLayer(layer: Layer, ctx: Ctx, zIndex: number, path: string): Promise<Json> {
  const id = ctx.counter.n++;
  const isGroup = Array.isArray(layer.children);
  const kind = isGroup ? "group" : (layer as Json).text ? "text" : (layer as Json).adjustment ? "adjustment" : "layer";
  if (kind === "group") ctx.stats.groups++; else ctx.stats.layers++;
  if (kind === "text") ctx.stats.text++;

  const node: Json = {
    id,
    path: path ? `${path}/${layer.name ?? id}` : String(layer.name ?? id),
    name: layer.name ?? "",
    kind,
    zIndex,
    bounds: { left: layer.left ?? 0, top: layer.top ?? 0, right: layer.right ?? 0, bottom: layer.bottom ?? 0 },
    opacity: layer.opacity ?? 1,
    fillOpacity: (layer as Json).fillOpacity,
    blendMode: layer.blendMode ?? "normal",
    hidden: !!layer.hidden,
    clipping: !!(layer as Json).clipping,
  };

  if ((layer as Json).adjustment) node.adjustment = serializeEffect((layer as Json).adjustment);
  if ((layer as Json).placedLayer) node.smartObject = true;
  if ((layer as Json).vectorMask) node.vectorMask = true;

  if (layer.effects) {
    const fx = serializeEffect(layer.effects) as Json;
    delete fx.patternOverlay; // données de pattern binaires inutiles
    node.effects = fx;
  }

  const text = extractText(layer);
  if (text) node.text = text;

  // masque raster
  const mask = (layer as Json).mask as (Json & { imageData?: RawImage }) | undefined;
  if (mask) {
    ctx.stats.masks++;
    node.mask = {
      bounds: { left: mask.left, top: mask.top, right: mask.right, bottom: mask.bottom },
      disabled: !!mask.disabled,
      defaultColor: mask.defaultColor,
    };
    if (mask.imageData?.width) {
      const p = `layers/L${String(id).padStart(3, "0")}_mask_${sanitize(layer.name ?? "")}.png`;
      try {
        await savePng(mask.imageData, join(ctx.outDir, p));
        (node.mask as Json).png = p;
      } catch (e) {
        (node.mask as Json).pngError = String(e);
      }
      mask.imageData = undefined;
    }
  }

  if (isGroup) {
    const childNodes: Json[] = [];
    const rasterChildren: { img: RawImage; left: number; top: number; opacity: number; hidden: boolean }[] = [];
    const kids = layer.children!;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i]!;
      // capture l'imageData AVANT récursion (walkLayer la libère)
      const cimg = (child as Json).imageData as RawImage | undefined;
      if (cimg?.width && !Array.isArray(child.children)) {
        rasterChildren.push({ img: cimg, left: child.left ?? 0, top: child.top ?? 0, opacity: child.opacity ?? 1, hidden: !!child.hidden });
      }
      childNodes.push(await walkLayer(child, ctx, i, String(node.path)));
    }
    node.children = childNodes;
    // rasterise le groupe (composite naïf source-over)
    const b = node.bounds as { left: number; top: number; right: number; bottom: number };
    const gb = {
      left: Math.min(...rasterChildren.map((c) => c.left), b.left),
      top: Math.min(...rasterChildren.map((c) => c.top), b.top),
      right: Math.max(...rasterChildren.map((c) => c.left + c.img.width), b.right),
      bottom: Math.max(...rasterChildren.map((c) => c.top + c.img.height), b.bottom),
    };
    if (rasterChildren.length) {
      const p = `layers/G${String(id).padStart(3, "0")}_${sanitize(layer.name ?? "groupe")}.png`;
      try {
        if (await compositeGroup(rasterChildren, gb, join(ctx.outDir, p))) {
          node.png = p;
          node.pngNote = "composite naïf source-over (modes de fusion exotiques non simulés)";
          ctx.stats.pngs++;
        }
      } catch (e) {
        node.pngError = String(e);
      }
    }
    for (const c of rasterChildren) (c as Json).img = undefined;
  } else {
    const img = (layer as Json).imageData as RawImage | undefined;
    if (img?.width) {
      const prefix = kind === "text" ? "T" : "L";
      const p = `layers/${prefix}${String(id).padStart(3, "0")}_${sanitize(layer.name ?? "")}.png`;
      try {
        await savePng(img, join(ctx.outDir, p));
        node.png = p;
        ctx.stats.pngs++;
      } catch (e) {
        node.pngError = String(e);
      }
      (layer as Json).imageData = undefined; // libère la mémoire au fil de l'eau
    }
  }

  return node;
}

// ---------- décomposition d'un PSD ----------

async function decomposeOne(psdPath: string, outRoot: string): Promise<void> {
  const name = basename(psdPath).replace(/\.psd$/i, "");
  const outDir = join(outRoot, name);
  mkdirSync(join(outDir, "layers"), { recursive: true });

  const missing: string[] = [];
  const buffer = readFileSync(psdPath);
  console.log(`[${name}] lecture (${(buffer.length / 1e6).toFixed(0)} Mo)…`);
  const psd: Psd = readPsd(buffer, {
    useImageData: true,
    skipThumbnail: true,
    throwForMissingFeatures: false,
    logMissingFeatures: false,
    logDevFeatures: false,
  } as Parameters<typeof readPsd>[1]);

  const ctx: Ctx = { outDir, counter: { n: 0 }, stats: { layers: 0, groups: 0, text: 0, pngs: 0, masks: 0 } };

  // composite de référence
  const comp = (psd as unknown as Json).imageData as RawImage | undefined;
  let compositePng: string | undefined;
  if (comp?.width) {
    compositePng = "composite.png";
    await savePng(comp, join(outDir, compositePng));
    (psd as unknown as Json).imageData = undefined;
  }

  const tree: Json[] = [];
  const children = psd.children ?? [];
  for (let i = 0; i < children.length; i++) {
    tree.push(await walkLayer(children[i]!, ctx, i, ""));
  }

  const manifest: Json = {
    psd: basename(psdPath),
    decomposedAt: new Date().toISOString(),
    width: psd.width,
    height: psd.height,
    bitsPerChannel: psd.bitsPerChannel,
    colorMode: psd.colorMode,
    composite: compositePng,
    stats: { ...ctx.stats, totalNodes: ctx.counter.n },
    missingFeatures: missing,
    tree,
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`[${name}] OK — ${ctx.stats.layers} calques, ${ctx.stats.groups} groupes, ${ctx.stats.text} textes, ${ctx.stats.pngs} PNG, ${ctx.stats.masks} masques`);
}

// ---------- mode --all : un sous-processus par PSD ----------

async function runAll(packDir: string, outRoot: string): Promise<void> {
  const psds = readdirSync(packDir).filter((f) => /\.psd$/i.test(f));
  console.log(`${psds.length} PSD à décomposer depuis ${packDir}`);
  const failures: string[] = [];
  for (const f of psds) {
    const target = join(outRoot, f.replace(/\.psd$/i, ""), "manifest.json");
    if (existsSync(target)) {
      console.log(`[skip] ${f} (manifest déjà présent)`);
      continue;
    }
    const proc = Bun.spawn(
      [process.execPath, import.meta.path, "--psd", join(packDir, f), "--out", outRoot],
      { stdout: "inherit", stderr: "inherit" },
    );
    const code = await proc.exited;
    if (code !== 0) {
      failures.push(f);
      console.error(`[ÉCHEC] ${f} (code ${code}) — à retenter avec psd.js ?`);
    }
  }
  if (failures.length) {
    writeFileSync(join(outRoot, "_failures.json"), JSON.stringify(failures, null, 2));
    process.exitCode = 1;
  }
  console.log(`Terminé. ${psds.length - failures.length}/${psds.length} PSD décomposés.`);
}

// ---------- main ----------

const args = process.argv.slice(2);
function argOf(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

if (args.includes("--all")) {
  await runAll(argOf("--pack")!, argOf("--out")!);
} else {
  const psd = argOf("--psd");
  const out = argOf("--out");
  if (!psd || !out) {
    console.error("Usage: --psd <fichier> --out <dossier>  |  --all --pack <dossier> --out <dossier>");
    process.exit(2);
  }
  await decomposeOne(psd, out);
}
