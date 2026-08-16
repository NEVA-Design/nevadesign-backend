// Chantier 0a — autopsie de la chaîne de références.
// Mesure chaque exemplar compilé (dimensions, poids) contre son original
// du corpus brut, et écrit un rapport JSON + un résumé lisible.
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'

const EXEMPLARS_DIR = join(import.meta.dir, '..', '..', 'src', 'engine', 'exemplars', 'fivem', 'logo')
const SOURCE_DIR = join(import.meta.dir, '..', '..', '..', 'entrainement IA fivem', 'logo serveur fivem gtarp')
const OUT = join(import.meta.dir, '..', '..', '..', 'captures', 'calibration', '_audit-run59', 'audit-exemplars.json')

type Row = {
  slug: string
  compiled: { width: number; height: number; bytes: number }
  original: { file: string; width: number; height: number; bytes: number } | null
  ratioBytes: number | null
}

const manifest = JSON.parse(await readFile(join(EXEMPLARS_DIR, '_manifest.json'), 'utf8')) as {
  exemplaires: Array<{ slug: string; source: string }>
}
const bySlug = new Map(manifest.exemplaires.map((e) => [e.slug, e.source]))
const sourceFiles = await readdir(SOURCE_DIR)

const rows: Row[] = []
for (const f of (await readdir(EXEMPLARS_DIR)).filter((f) => f.endsWith('.jpg'))) {
  const slug = f.replace(/\.jpg$/, '')
  const compiledPath = join(EXEMPLARS_DIR, f)
  const cBuf = await readFile(compiledPath)
  const cMeta = await sharp(cBuf).metadata()

  const sourceName = bySlug.get(slug)
  let original: Row['original'] = null
  if (sourceName) {
    const match = sourceFiles.find((s) => s === sourceName) ?? sourceFiles.find((s) => s.toLowerCase() === sourceName.toLowerCase())
    if (match) {
      const oBuf = await readFile(join(SOURCE_DIR, match))
      try {
        const oMeta = await sharp(oBuf).metadata()
        original = { file: match, width: oMeta.width ?? 0, height: oMeta.height ?? 0, bytes: oBuf.length }
      } catch {
        original = { file: match, width: 0, height: 0, bytes: oBuf.length }
      }
    }
  }

  rows.push({
    slug,
    compiled: { width: cMeta.width ?? 0, height: cMeta.height ?? 0, bytes: cBuf.length },
    original,
    ratioBytes: original ? Math.round((cBuf.length / original.bytes) * 1000) / 1000 : null,
  })
}

rows.sort((a, b) => a.compiled.bytes - b.compiled.bytes)
await Bun.write(OUT, JSON.stringify(rows, null, 1))

const tiny = rows.filter((r) => r.compiled.bytes < 10_000)
const small = rows.filter((r) => (r.compiled.width ?? 0) < 512)
console.log(`Exemplars audités : ${rows.length}`)
console.log(`< 10 Ko : ${tiny.length} — < 512 px de large : ${small.length}`)
console.log('')
console.log('slug'.padEnd(40) + 'compilé'.padEnd(20) + 'original')
for (const r of rows) {
  const c = `${r.compiled.width}x${r.compiled.height} ${(r.compiled.bytes / 1024).toFixed(1)}Ko`
  const o = r.original ? `${r.original.width}x${r.original.height} ${(r.original.bytes / 1024).toFixed(1)}Ko (${r.original.file})` : 'ORIGINAL INTROUVABLE'
  console.log(r.slug.padEnd(40) + c.padEnd(20) + o)
}
