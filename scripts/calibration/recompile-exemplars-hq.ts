// Chantier 0a — recompilation haute qualité des exemplars logo.
// L'audit (audit-exemplars.ts) a montré que la compilation v4 plafonnait à
// 768 px JPEG q82 et écrasait les pépites 2000² en 30-150 Ko, pendant que
// 25 exemplars sont des vignettes NATIVES 96-128 px (avatars Discord).
// Ici : recompile depuis l'original en 1024 px max (sans agrandissement),
// JPEG q92, et écrit `resolution_native` dans le manifest — la sélection
// pourra refuser de joindre une vignette comme référence de rendu.
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'

const EXEMPLARS_DIR = join(import.meta.dir, '..', '..', 'src', 'engine', 'exemplars', 'fivem', 'logo')
const SOURCE_DIR = join(import.meta.dir, '..', '..', '..', 'entrainement IA fivem', 'logo serveur fivem gtarp')

const MAX_SIDE = 1024
const QUALITY = 92

const manifestPath = join(EXEMPLARS_DIR, '_manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
  exemplaires: Array<{ slug: string; source: string; resolution_native?: number }>
}
const sourceFiles = await readdir(SOURCE_DIR)

let recompiled = 0
let keptNoSource = 0
for (const entry of manifest.exemplaires) {
  const jpgPath = join(EXEMPLARS_DIR, `${entry.slug}.jpg`)
  const match =
    sourceFiles.find((s) => s === entry.source) ??
    sourceFiles.find((s) => s.toLowerCase() === entry.source.toLowerCase())

  if (!match) {
    // source disparue du corpus brut : on garde l'exemplar compilé tel quel,
    // mais on mesure sa résolution pour renseigner resolution_native.
    const meta = await sharp(await readFile(jpgPath)).metadata()
    entry.resolution_native = Math.max(meta.width ?? 0, meta.height ?? 0)
    keptNoSource++
    continue
  }

  const srcBuf = await readFile(join(SOURCE_DIR, match))
  const srcMeta = await sharp(srcBuf).metadata()
  const native = Math.max(srcMeta.width ?? 0, srcMeta.height ?? 0)
  entry.resolution_native = native

  const out = await sharp(srcBuf)
    .flatten({ background: '#111318' }) // les PNG alpha posés sur un fond sombre corpus, pas sur du noir par défaut JPEG
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: QUALITY, mozjpeg: true })
    .toBuffer()
  await writeFile(jpgPath, out)
  recompiled++
  console.log(`${entry.slug.padEnd(40)} ${native}px natif → ${(out.length / 1024).toFixed(1)} Ko`)
}

await writeFile(manifestPath, JSON.stringify(manifest, null, 1))
console.log(`\nRecompilés : ${recompiled} · gardés sans source : ${keptNoSource} · resolution_native écrite pour tous`)
