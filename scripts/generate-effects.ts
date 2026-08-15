/*
 * Bibliothèque d'effets maison (run 5, LOT 5) — one-shot, ZÉRO appel API.
 * Génère les overlays (grain, vignette, lignes topographiques, halftone,
 * glows, particules) en 2048px dans src/engine/effects/, avec un manifest
 * (blend et opacité recommandés). Les calques 2 et 5 des créations les
 * réutilisent gratuitement à vie.
 *
 * Usage : bun run scripts/generate-effects.ts
 */

import { mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import sharp from 'sharp'

const OUT = resolve(import.meta.dir, '../src/engine/effects')
const SIZE = 2048

function noisePng(amplitude: number): Promise<Buffer> {
  const raw = Buffer.alloc(SIZE * SIZE * 3)
  for (let i = 0; i < SIZE * SIZE; i++) {
    const v = 128 + Math.round((Math.random() - 0.5) * 2 * amplitude)
    raw[i * 3] = v
    raw[i * 3 + 1] = v
    raw[i * 3 + 2] = v
  }
  return sharp(raw, { raw: { width: SIZE, height: SIZE, channels: 3 } }).png().toBuffer()
}

function svgPng(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg)).resize(SIZE, SIZE).png().toBuffer()
}

// Blobs fermés lissés pour les lignes topographiques
function blobPath(cx: number, cy: number, r: number, wobble: number, points = 14, seed = 1): string {
  const pts: Array<[number, number]> = []
  for (let i = 0; i < points; i++) {
    const angle = (i / points) * Math.PI * 2
    const jitter = 1 + Math.sin(seed * 13.7 + i * 2.4) * wobble + Math.cos(seed * 7.3 + i * 1.7) * wobble * 0.6
    pts.push([cx + Math.cos(angle) * r * jitter, cy + Math.sin(angle) * r * jitter])
  }
  let d = `M ${pts[0]![0]} ${pts[0]![1]}`
  for (let i = 0; i < points; i++) {
    const p0 = pts[i]!
    const p1 = pts[(i + 1) % points]!
    const mx = (p0[0] + p1[0]) / 2
    const my = (p0[1] + p1[1]) / 2
    d += ` Q ${p0[0]} ${p0[1]} ${mx} ${my}`
  }
  return d + ' Z'
}

async function run() {
  mkdirSync(OUT, { recursive: true })

  // Grains — gris neutre 128, à poser en blend overlay
  writeFileSync(join(OUT, 'grain-fin.png'), await noisePng(14))
  writeFileSync(join(OUT, 'grain-fort.png'), await noisePng(34))

  // Vignette — bords noirs alpha
  writeFileSync(join(OUT, 'vignette.png'), await svgPng(`
    <svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
      <radialGradient id="v" cx="50%" cy="50%" r="72%">
        <stop offset="52%" stop-color="#000" stop-opacity="0"/>
        <stop offset="100%" stop-color="#000" stop-opacity="0.82"/>
      </radialGradient>
      <rect width="100%" height="100%" fill="url(#v)"/>
    </svg>`))

  // Lignes topographiques — 3 systèmes de courbes de niveau
  const topoGroups: string[] = []
  const centers: Array<[number, number, number]> = [
    [520, 620, 1],
    [1520, 420, 2],
    [1180, 1560, 3],
  ]
  for (const [cx, cy, seed] of centers) {
    for (let ring = 1; ring <= 7; ring++) {
      topoGroups.push(
        `<path d="${blobPath(cx, cy, 90 + ring * 95, 0.16, 16, seed + ring * 0.31)}" fill="none" stroke="#FFFFFF" stroke-opacity="${0.5 - ring * 0.045}" stroke-width="2.4"/>`
      )
    }
  }
  writeFileSync(join(OUT, 'topo.png'), await svgPng(`
    <svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">${topoGroups.join('')}</svg>`))

  // Halftone — trame de points avec fondu radial
  const dots: string[] = []
  const step = 26
  for (let y = step / 2; y < SIZE; y += step) {
    for (let x = step / 2 + ((y / step) % 2) * (step / 2); x < SIZE; x += step) {
      dots.push(`<circle cx="${x}" cy="${y}" r="4.4" fill="#FFFFFF"/>`)
    }
  }
  writeFileSync(join(OUT, 'halftone.png'), await svgPng(`
    <svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="m" cx="18%" cy="85%" r="95%">
          <stop offset="0%" stop-color="#fff"/>
          <stop offset="62%" stop-color="#000"/>
        </radialGradient>
        <mask id="fade"><rect width="100%" height="100%" fill="url(#m)"/></mask>
      </defs>
      <g mask="url(#fade)">${dots.join('')}</g>
    </svg>`))

  // Glows — nappes lumineuses à poser en screen
  writeFileSync(join(OUT, 'glow-chaud.png'), await svgPng(`
    <svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
      <radialGradient id="g" cx="30%" cy="24%" r="60%">
        <stop offset="0%" stop-color="#FFB35C" stop-opacity="0.85"/>
        <stop offset="55%" stop-color="#E5603A" stop-opacity="0.30"/>
        <stop offset="100%" stop-color="#000" stop-opacity="0"/>
      </radialGradient>
      <rect width="100%" height="100%" fill="url(#g)"/>
    </svg>`))
  writeFileSync(join(OUT, 'glow-froid.png'), await svgPng(`
    <svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
      <radialGradient id="g" cx="72%" cy="20%" r="62%">
        <stop offset="0%" stop-color="#7FD8FF" stop-opacity="0.8"/>
        <stop offset="55%" stop-color="#4E63E0" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="#000" stop-opacity="0"/>
      </radialGradient>
      <rect width="100%" height="100%" fill="url(#g)"/>
    </svg>`))

  // Particules — bokeh flottant
  const particles: string[] = []
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * SIZE
    const y = Math.random() * SIZE
    const r = 3 + Math.random() * 16
    const o = 0.12 + Math.random() * 0.5
    particles.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="#FFE9C9" fill-opacity="${o}"/>`)
  }
  const particleBase = await svgPng(`
    <svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">${particles.join('')}</svg>`)
  writeFileSync(join(OUT, 'particules.png'), await sharp(particleBase).blur(2.2).png().toBuffer())

  const manifest = [
    { id: 'grain-fin', label: 'Grain fin', blend: 'overlay', opacity: 0.35 },
    { id: 'grain-fort', label: 'Grain marqué', blend: 'overlay', opacity: 0.4 },
    { id: 'vignette', label: 'Vignette', blend: 'normal', opacity: 0.85 },
    { id: 'topo', label: 'Lignes topographiques', blend: 'screen', opacity: 0.22 },
    { id: 'halftone', label: 'Halftone', blend: 'screen', opacity: 0.2 },
    { id: 'glow-chaud', label: 'Glow chaud', blend: 'screen', opacity: 0.75 },
    { id: 'glow-froid', label: 'Glow froid', blend: 'screen', opacity: 0.75 },
    { id: 'particules', label: 'Particules', blend: 'screen', opacity: 0.6 },
  ]
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(`${manifest.length} effets générés dans ${OUT}`)
}

await run()
