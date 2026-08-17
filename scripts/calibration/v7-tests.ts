/*
 * Run 7 — tests des GARDES. Zéro appel API, zéro dépense.
 *
 * Ce fichier ne teste pas « le code compile », il teste les décisions : chaque
 * passage/échec de la session 7 est pris par une des fonctions ci-dessous, sur
 * une mesure. Si l'une d'elles se trompe, la session valide un mauvais candidat
 * — c'est exactement ce qui est arrivé aux runs 5.8 à 5.10 avec un jury cassé.
 *
 *   bun run scripts/calibration/v7-tests.ts
 */

import { choisis, decisionGlyphes, decisionSujet, gardes, mots, normalise, paletteConforme, violations, type Piste } from './v7-gardes'
import {
  analyseSvg,
  boiteMasque,
  estNeutre,
  familleTeinte,
  box2dValide,
  composantes,
  couleurNormalisee,
  extraitPremierJson,
  regionsCouleur,
  extraitSvg,
  iou,
  masqueOpacite,
  mesureFond,
  mesureSvg,
  quantile,
  ratiosBox,
  resume,
  distribution,
  modalite,
  renduSvg,
  type Masque,
} from './v7-lib'
import sharp from 'sharp'

let ok = 0
let ko = 0
const echecs: string[] = []

function verifie(nom: string, condition: boolean, detail = '') {
  if (condition) {
    ok += 1
  } else {
    ko += 1
    echecs.push(`${nom}${detail ? ` — ${detail}` : ''}`)
  }
}

function proche(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol
}

// ─── Statistiques ────────────────────────────────────────────────────────────

verifie('quantile médiane impaire', quantile([1, 2, 3], 0.5) === 2)
verifie('quantile médiane paire (interpolée)', quantile([1, 2, 3, 4], 0.5) === 2.5)
verifie('quantile p25', quantile([1, 2, 3, 4, 5], 0.25) === 2)
verifie('quantile liste vide = NaN', Number.isNaN(quantile([], 0.5)))
verifie('quantile ignore les NaN', quantile([1, NaN, 3], 0.5) === 2)
verifie('resume compte les valeurs finies', resume([1, 2, NaN, 4]).n === 3)
verifie('distribution ordonne par effectif', Object.keys(distribution(['a', 'b', 'b']))[0] === 'b')
verifie('modalite = majorité', modalite(['x', 'y', 'y', 'y']) === 'y')

// ─── box_2d (piège n°12 : jamais [x,y,w,h] en 0..1) ──────────────────────────

verifie('box_2d valide', box2dValide([100, 200, 800, 900]))
verifie('box_2d refuse les flottants 0..1', !box2dValide([0.1, 0.2, 0.8, 0.9]))
verifie('box_2d refuse hors bornes', !box2dValide([0, 0, 1200, 500]))
verifie('box_2d refuse une boîte plate', !box2dValide([500, 100, 500, 900]))
verifie('box_2d refuse la mauvaise longueur', !box2dValide([1, 2, 3]))
verifie('box_2d refuse un non-tableau', !box2dValide({ ymin: 0 }))
{
  const r = ratiosBox([250, 250, 750, 750])
  verifie('ratiosBox aire', proche(r.aire, 0.25, 1e-6), String(r.aire))
  verifie('ratiosBox côté', proche(r.cote, 0.5, 1e-6), String(r.cote))
}

// ─── Couleurs ────────────────────────────────────────────────────────────────

verifie('couleur #FFF → #ffffff', couleurNormalisee('#FFF') === '#ffffff')
verifie('couleur black → #000000', couleurNormalisee('black') === '#000000')
verifie('couleur url(#g) → gradient', couleurNormalisee('url(#g)') === 'gradient')
verifie('couleur none préservée', couleurNormalisee('none') === 'none')

// ─── Analyse statique du SVG ─────────────────────────────────────────────────

{
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
    <path d="M0 0 L10 0 L10 10 Z" fill="#FFFFFF" stroke="#000000" stroke-width="14"/>
    <path d="M20 20 L30 20 L30 30 Z" fill="#22d3ee" stroke="#000" stroke-width="14"/>
  </svg>`
  const a = analyseSvg(svg)
  verifie('analyseSvg viewBox', a.viewBox === '0 0 512 512')
  verifie('analyseSvg 2 chemins', a.nbPaths === 2, String(a.nbPaths))
  verifie('analyseSvg 2 fills distincts', a.fills.length === 2, a.fills.join(','))
  verifie('analyseSvg contour noir unique', a.strokes.length === 1 && a.strokes[0] === '#000000')
  verifie('analyseSvg épaisseur constante relevée', a.strokeWidths.length === 1 && a.strokeWidths[0] === 14)
  verifie('analyseSvg pas de texte', !a.aText)
  verifie('analyseSvg pas de dégradé', !a.aGradient)
  verifie('analyseSvg pas de filtre', !a.aFilter)
}
{
  const a = analyseSvg('<svg><text x="0" y="0">NOX</text></svg>')
  verifie('analyseSvg détecte <text>', a.aText)
}
{
  const a = analyseSvg('<svg><path fill="none" stroke="none" d="M0 0"/></svg>')
  verifie('analyseSvg écarte fill=none', a.fills.length === 0)
}
{
  const a = analyseSvg('<svg><defs><linearGradient id="g"/></defs><path fill="url(#g)" d="M0 0"/></svg>')
  verifie('analyseSvg détecte le dégradé', a.aGradient)
}
{
  const a = analyseSvg('<svg><filter id="f"><feGaussianBlur/></filter></svg>')
  verifie('analyseSvg détecte le filtre', a.aFilter)
}
{
  const a = analyseSvg('<svg><circle cx="5" cy="5" r="4" fill="#fff"/><rect fill="#000"/></svg>')
  verifie('analyseSvg compte les primitives', a.nbFormesPrimitives === 2, String(a.nbFormesPrimitives))
}

verifie('extraitSvg trouve le bloc', extraitSvg('bla ```\n<svg a="1"><g/></svg>\n``` fin')?.startsWith('<svg') === true)
verifie('extraitSvg rend null sans SVG', extraitSvg('aucun svg ici') === null)

// ─── Composantes connexes, IoU, boîte ────────────────────────────────────────

{
  //  masque 10x10 : deux carrés 3x3 séparés
  const w = 10
  const h = 10
  const m = new Uint8Array(w * h)
  for (let y = 0; y < 3; y += 1) for (let x = 0; x < 3; x += 1) m[y * w + x] = 1
  for (let y = 6; y < 9; y += 1) for (let x = 6; x < 9; x += 1) m[y * w + x] = 1
  const c = composantes({ w, h, m }, 0)
  verifie('composantes : 2 carrés séparés = 2', c.nb === 2, String(c.nb))
  verifie('composantes : tailles 9 et 9', c.tailles.join(',') === '9,9', c.tailles.join(','))

  //  les mêmes, reliés par une diagonale (8-voisinage) = 1
  const m2 = new Uint8Array(m)
  m2[3 * w + 3] = 1
  m2[4 * w + 4] = 1
  m2[5 * w + 5] = 1
  const c2 = composantes({ w, h, m: m2 }, 0)
  verifie('composantes : 8-voisinage relie la diagonale', c2.nb === 1, String(c2.nb))

  //  filtre de surface : une poussière de 1 px est écartée
  const m3 = new Uint8Array(w * h)
  for (let y = 0; y < 5; y += 1) for (let x = 0; x < 5; x += 1) m3[y * w + x] = 1
  m3[9 * w + 9] = 1
  const c3 = composantes({ w, h, m: m3 }, 0.03)
  verifie('composantes : poussière écartée par minRatio', c3.nb === 1, String(c3.nb))
}
{
  const w = 4
  const h = 4
  const a: Masque = { w, h, m: new Uint8Array([1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) }
  const b: Masque = { w, h, m: new Uint8Array([1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) }
  verifie('IoU identiques = 1', iou(a, a) === 1)
  verifie('IoU 3/4', iou(a, b) === 0.75, String(iou(a, b)))
  const vide: Masque = { w, h, m: new Uint8Array(w * h) }
  verifie('IoU deux masques vides = 0', iou(vide, vide) === 0)
  let jete = false
  try {
    iou(a, { w: 2, h: 2, m: new Uint8Array(4) })
  } catch {
    jete = true
  }
  verifie('IoU refuse les tailles différentes', jete)
}
{
  const w = 10
  const h = 10
  const m = new Uint8Array(w * h)
  for (let y = 2; y < 8; y += 1) for (let x = 4; x < 6; x += 1) m[y * w + x] = 1
  const b = boiteMasque({ w, h, m })
  verifie('boiteMasque x0', b !== null && proche(b.x0, 0.4, 1e-9), JSON.stringify(b))
  verifie('boiteMasque y1', b !== null && proche(b.y1, 0.8, 1e-9), JSON.stringify(b))
  verifie('boiteMasque vide = null', boiteMasque({ w, h, m: new Uint8Array(w * h) }) === null)
}

// ─── Mesures photométriques ──────────────────────────────────────────────────

{
  const noir = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#000000' } }).png().toBuffer()
  const f = await mesureFond(noir)
  verifie('mesureFond noir : luminance 0', proche(f.luminance, 0, 1e-6), String(f.luminance))
  verifie('mesureFond noir : contraste 0', proche(f.contraste, 0, 1e-6), String(f.contraste))
  verifie('mesureFond noir : saturation 0', proche(f.saturation, 0, 1e-6), String(f.saturation))

  const blanc = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ffffff' } }).png().toBuffer()
  verifie('mesureFond blanc : luminance 1', proche((await mesureFond(blanc)).luminance, 1, 1e-3))

  const rouge = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ff0000' } }).png().toBuffer()
  verifie('mesureFond rouge : saturation 1', proche((await mesureFond(rouge)).saturation, 1, 1e-3))

  //  moitié noire / moitié blanche : luminance 0,5 et contraste 0,5
  const moitie = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#000000' } })
    .composite([
      {
        input: await sharp({ create: { width: 32, height: 64, channels: 3, background: '#ffffff' } }).png().toBuffer(),
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toBuffer()
  const fm = await mesureFond(moitie)
  verifie('mesureFond moitié/moitié : luminance ~0,5', proche(fm.luminance, 0.5, 0.02), String(fm.luminance))
  verifie('mesureFond moitié/moitié : contraste ~0,5', proche(fm.contraste, 0.5, 0.02), String(fm.contraste))

  //  exclusion de boîte : un carré blanc central exclu doit ramener la mesure au noir
  const avecMarque = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#000000' } })
    .composite([
      {
        input: await sharp({ create: { width: 50, height: 50, channels: 3, background: '#ffffff' } }).png().toBuffer(),
        left: 25,
        top: 25,
      },
    ])
    .png()
    .toBuffer()
  const sansExclusion = await mesureFond(avecMarque)
  const avecExclusion = await mesureFond(avecMarque, [250, 250, 750, 750])
  verifie('mesureFond sans exclusion compte la marque', sansExclusion.luminance > 0.2, String(sansExclusion.luminance))
  verifie(
    'mesureFond avec exclusion ignore la marque',
    proche(avecExclusion.luminance, 0, 1e-3),
    String(avecExclusion.luminance)
  )
  verifie('mesureFond exclusion : moins de pixels', avecExclusion.pixels < sansExclusion.pixels)
}

// ─── Masque d'opacité (piège n°10 : RGBA, jamais 1 canal) ────────────────────

{
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="0" y="0" width="100" height="50" fill="#ffffff"/></svg>`
  const png = await renduSvg(svg, 64)
  const m = await masqueOpacite(png, 64)
  const b = boiteMasque(m)
  verifie('masqueOpacite : moitié haute opaque', b !== null && b.y1 < 0.6 && b.y0 < 0.05, JSON.stringify(b))
}

// ─── mesureSvg : les gardes de la phase 3 ────────────────────────────────────

const SVG_UN_ELEMENT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <path d="M120 96 h180 a110 110 0 0 1 0 160 a110 110 0 0 1 0 160 h-180 z" fill="#f2f4f7"/>
</svg>`

const SVG_DEUX_ELEMENTS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <circle cx="150" cy="256" r="90" fill="#f2f4f7"/>
  <circle cx="370" cy="256" r="90" fill="#22d3ee"/>
</svg>`

const SVG_TROU = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <path d="M96 96 h320 v320 h-320 z M180 180 h150 v150 h-150 z" fill="#f2f4f7" fill-rule="evenodd"/>
</svg>`

const SVG_CHEVEU = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <path d="M60 250 h392" fill="none" stroke="#ffffff" stroke-width="1.2"/>
  <path d="M60 262 h392" fill="none" stroke="#ffffff" stroke-width="1.2"/>
</svg>`

{
  const m = await mesureSvg(SVG_UN_ELEMENT)
  verifie('mesureSvg : silhouette pleine = 1 élément', m.nbElements === 1, String(m.nbElements))
  verifie('mesureSvg : 1 couleur au rendu', m.nbCouleursRendu === 1, JSON.stringify(m.couleursRendu))
  verifie('mesureSvg : lisible à 64 px (IoU haut)', m.iou64 > 0.9, String(m.iou64))
  verifie('mesureSvg : structure conservée à 64 px', m.nbElements64 === m.nbElements, `${m.nbElements64}/${m.nbElements}`)
  verifie('mesureSvg : encre plausible', m.encre512 > 0.05 && m.encre512 < 0.6, String(m.encre512))
}
{
  const m = await mesureSvg(SVG_DEUX_ELEMENTS)
  verifie('mesureSvg : deux disques séparés = 2 éléments', m.nbElements === 2, String(m.nbElements))
  verifie('mesureSvg : 2 couleurs au rendu', m.nbCouleursRendu === 2, JSON.stringify(m.couleursRendu))
}
{
  const m = await mesureSvg(SVG_TROU)
  verifie('mesureSvg : un trou ne fait pas 2 éléments', m.nbElements === 1, String(m.nbElements))
}
{
  const m = await mesureSvg(SVG_CHEVEU)
  verifie('mesureSvg : deux cheveux de 1,2 px chutent à 64 px', m.iou64 < 0.6, String(m.iou64))
}
{
  const m = await mesureSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"></svg>')
  verifie('mesureSvg : SVG vide = 0 élément', m.nbElements === 0)
  verifie('mesureSvg : SVG vide = 0 couleur', m.nbCouleursRendu === 0)
}
{
  //  contour noir épais sur aplat blanc : le rendu doit voir DEUX couleurs
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
    <path d="M128 128 h256 v256 h-256 z" fill="#f2f4f7" stroke="#000000" stroke-width="26"/>
  </svg>`
  const m = await mesureSvg(svg)
  verifie('mesureSvg : aplat + contour = 2 couleurs au rendu', m.nbCouleursRendu === 2, JSON.stringify(m.couleursRendu))
  verifie('mesureSvg : le contour n\'ajoute pas d\'élément', m.nbElements === 1, String(m.nbElements))
}
{
  //  un SVG cassé ne doit pas faire tomber la boucle
  const m = await mesureSvg('<svg><path d="M0 0 L"')
  verifie('mesureSvg : SVG cassé → erreurRendu renseignée, pas de jet', m.parse === false && m.erreurRendu !== null)
}

// ─── Couleurs : neutre, famille de teinte, conformité au corpus ──────────────

verifie('estNeutre : blanc', estNeutre('#ffffff'))
verifie('estNeutre : gris', estNeutre('#8a8a8a'))
verifie('estNeutre : quasi-blanc froid', estNeutre('#e8ecf0'))
verifie('estNeutre : cyan saturé NON', !estNeutre('#22d3ee'))
verifie('familleTeinte : or 48° → 30', familleTeinte('#ffcc00') === 30, String(familleTeinte('#ffcc00')))
verifie('familleTeinte : orange 20° → 0', familleTeinte('#ff5500') === 0, String(familleTeinte('#ff5500')))
verifie('familleTeinte : cyan 187° → 180', familleTeinte('#22d3ee') === 180, String(familleTeinte('#22d3ee')))
verifie('familleTeinte : un neutre n\'a pas de famille', familleTeinte('#ffffff') === null)

{
  const pm = { familles_retenues: [30, 180, 330, 0, 210, 270, 120] }
  verifie('paletteConforme : blanc + or', paletteConforme(['#E0E0E0', '#FFCC00'], pm).passe)
  verifie('paletteConforme : blanc + orange', paletteConforme(['#FFFFFF', '#FF5500'], pm).passe)
  verifie('paletteConforme : blanc seul', paletteConforme(['#ffffff'], pm).passe)
  verifie(
    'paletteConforme : deux saturées sans neutre → refus',
    !paletteConforme(['#ff0000', '#00ff00'], pm).passe,
    paletteConforme(['#ff0000', '#00ff00'], pm).detail
  )
  verifie(
    'paletteConforme : accent dans une famille à 1 occurrence → refus',
    !paletteConforme(['#ffffff', '#7fff00'], pm).passe,
    `${familleTeinte('#7fff00')}° · ${paletteConforme(['#ffffff', '#7fff00'], pm).detail}`
  )
}

// ─── Normalisation du cadrage ────────────────────────────────────────────────

{
  //  un petit carré dans un coin doit ressortir centré et à l'échelle demandée
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M20 20 h40 v40 h-40 z" fill="#ffffff"/></svg>`
  const norm = await normalise(svg, 0.648)
  verifie('normalise : produit un SVG', norm !== null && norm.startsWith('<svg'))
  if (norm) {
    const m = await masqueOpacite(await renduSvg(norm, 512), 512)
    const bo = boiteMasque(m)
    verifie(
      'normalise : plus grand côté à la côte cible',
      bo !== null && proche(Math.max(bo.x1 - bo.x0, bo.y1 - bo.y0), 0.648, 0.02),
      JSON.stringify(bo)
    )
    verifie('normalise : centré en x', bo !== null && proche((bo.x0 + bo.x1) / 2, 0.5, 0.02), JSON.stringify(bo))
    verifie('normalise : centré en y', bo !== null && proche((bo.y0 + bo.y1) / 2, 0.5, 0.02), JSON.stringify(bo))
  }
  verifie('normalise : SVG vide → null', (await normalise('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"></svg>', 0.648)) === null)
}

// ─── Les gardes de la phase 3, sur des cas construits ────────────────────────

{
  const pm = { familles_retenues: [30, 180, 0] }
  const bon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M100 100 h300 v300 h-300 z" fill="#e0e0e0"/></svg>`
  const g = gardes(await mesureSvg(bon), ['#e0e0e0'], 2, 2, pm)
  verifie('gardes : un aplat propre passe tout', g.every((x) => x.passe), g.filter((x) => !x.passe).map((x) => x.nom).join(','))

  const avecContour = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M100 100 h300 v300 h-300 z" fill="#e0e0e0" stroke="#000000" stroke-width="20"/></svg>`
  const gc = gardes(await mesureSvg(avecContour), ['#e0e0e0'], 2, 2, pm)
  verifie('gardes : un contour est refusé (médiane du corpus = none)', gc.find((x) => x.nom === 'contour')?.passe === false)

  const horsPalette = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M100 100 h300 v300 h-300 z" fill="#123456"/></svg>`
  const gp = gardes(await mesureSvg(horsPalette), ['#e0e0e0'], 2, 2, pm)
  verifie('gardes : un fill hors palette est refusé', gp.find((x) => x.nom === 'palette')?.passe === false)

  const troisElements = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
    <path d="M40 200 h100 v100 h-100 z" fill="#e0e0e0"/>
    <path d="M200 200 h100 v100 h-100 z" fill="#e0e0e0"/>
    <path d="M360 200 h100 v100 h-100 z" fill="#e0e0e0"/></svg>`
  const g3 = gardes(await mesureSvg(troisElements), ['#e0e0e0'], 2, 2, pm)
  verifie('gardes : 3 éléments séparés refusés quand la borne vaut 2', g3.find((x) => x.nom === 'nb_elements')?.passe === false)

  const mauvaisViewBox = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 h80 v80 h-80 z" fill="#e0e0e0"/></svg>`
  const gv = gardes(await mesureSvg(mauvaisViewBox), ['#e0e0e0'], 2, 2, pm)
  verifie('gardes : viewBox non conforme refusé', gv.find((x) => x.nom === 'viewBox')?.passe === false)

  const primitive = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="150" fill="#e0e0e0"/></svg>`
  const gpr = gardes(await mesureSvg(primitive), ['#e0e0e0'], 2, 2, pm)
  verifie('gardes : une primitive refusée (chemins seuls)', gpr.find((x) => x.nom === 'chemins_seuls')?.passe === false)

  const patet = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M0 0 h512 v512 h-512 z" fill="#e0e0e0"/></svg>`
  const gpa = gardes(await mesureSvg(patet), ['#e0e0e0'], 2, 2, pm)
  verifie('gardes : un pâté plein cadre refusé par l\'encre', gpa.find((x) => x.nom === 'encre')?.passe === false)
}

// ─── La garde de MASSE ───────────────────────────────────────────────────────

{
  const pm = { familles_retenues: [30, 180, 0] }
  //  un aplat carré remplit sa boîte à 100 % : masse maximale
  const plein = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M100 100 h300 v300 h-300 z" fill="#e0e0e0"/></svg>`
  const mp = await mesureSvg(plein)
  verifie('masse : un carré plein vaut ~1', mp.masse !== null && proche(mp.masse, 1, 0.02), String(mp.masse))
  verifie('masse : garde passée au plancher 0,334', gardes(mp, ['#e0e0e0'], 2, 2, pm, 'none', 0.334).find((g) => g.nom === 'masse')?.passe === true)

  /*
   * Le cas qui a motivé la garde : un anneau croisé d'une barre. Toutes les
   * gardes d'hygiène passent, la masse non. C'est exactement la forme que la
   * boucle avait validée au tour 1 avant que la garde n'existe.
   */
  //  Un cadre creux : carré 392 avec un trou de 340. Tracé en lignes droites et
  //  fill-rule evenodd — deux arcs quasi complets ne se coupent pas de façon
  //  fiable sous librsvg (constaté : le trou n'était pas creusé, masse 0,756 au
  //  lieu de 0,194), et un test doit mesurer la garde, pas le rasteriseur.
  const anneauBarre = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
    <path d="M60 60 H452 V452 H60 Z M86 86 H426 V426 H86 Z" fill="#e0e0e0" fill-rule="evenodd"/></svg>`
  const ma = await mesureSvg(anneauBarre)
  const ga = gardes(ma, ['#e0e0e0'], 2, 2, pm, 'none', 0.334)
  verifie('masse : un anneau croisé d\'une barre est refusé', ga.find((g) => g.nom === 'masse')?.passe === false, `masse ${ma.masse}`)
  verifie(
    'masse : et le cadre creux passe TOUTES les autres gardes — c\'est le motif de la garde',
    ga.filter((g) => !g.passe).length === 1 && ga.find((g) => !g.passe)?.nom === 'masse',
    ga.filter((g) => !g.passe).map((g) => g.nom).join(',')
  )

  const gz = gardes(ma, ['#e0e0e0'], 2, 2, pm, 'none', 0)
  verifie('masse : plancher 0 = garde neutre', gz.find((g) => g.nom === 'masse')?.passe === true)
}

// ─── La lecture des glyphes ──────────────────────────────────────────────────

verifie('glyphes : monogramme NOX lu exactement', decisionGlyphes(['N', 'O', 'X'], 'NOX').passe)
verifie('glyphes : ordre indifférent', decisionGlyphes(['X', 'N', 'O'], 'NOX').passe)
verifie('glyphes : minuscules acceptées', decisionGlyphes(['n', 'o', 'x'], 'NOX').passe)
verifie('glyphes : doublons ignorés', decisionGlyphes(['N', 'N', 'O', 'X'], 'NOX').passe)
verifie(
  'glyphes : une lettre illisible → refus',
  !decisionGlyphes(['O', 'X'], 'NOX').passe,
  decisionGlyphes(['O', 'X'], 'NOX').detail
)
verifie(
  'glyphes : une lettre en trop → refus',
  !decisionGlyphes(['N', 'O', 'X', 'M'], 'NOX').passe,
  decisionGlyphes(['N', 'O', 'X', 'M'], 'NOX').detail
)
verifie('glyphes : rien lu sur un monogramme → refus', !decisionGlyphes([], 'NOX').passe)
verifie('glyphes : emblème pur muet → passe', decisionGlyphes([], null).passe)
/*
 * Le seuil de l'emblème est 2, et c'est un CALIBRAGE qui l'a fixé : le même
 * instrument nomme la cible `vulcainlogo` « letter V ». Une garde à zéro lettre
 * refuse la cible du mandat — et elle a réellement écarté le meilleur tour de la
 * série VULCAIN, un V ailé d'une seule silhouette.
 */
verifie('glyphes : UNE forme-de-lettre dans un emblème → toléré (la cible en est une)', decisionGlyphes(['V'], null).passe, decisionGlyphes(['V'], null).detail)
verifie(
  'glyphes : DEUX lettres dans un emblème = du lettrage → refus',
  !decisionGlyphes(['R', 'P'], null).passe,
  decisionGlyphes(['R', 'P'], null).detail
)
verifie('glyphes : trois lettres dans un emblème → refus', !decisionGlyphes(['N', 'O', 'X'], null).passe)
verifie('glyphes : les non-lettres sont écartées du relevé', decisionGlyphes(['N', 'O', 'X', '1', '', '#'], 'NOX').passe)

// ─── Lecture JSON robuste ────────────────────────────────────────────────────

verifie('json : objet nu', extraitPremierJson('{"a":1}') === '{"a":1}')
verifie('json : clôture markdown', extraitPremierJson('```json\n{"a":1}\n```') === '{"a":1}')
verifie('json : prose avant et après', extraitPremierJson('Voici : {"a":1} voilà.') === '{"a":1}')
verifie(
  'json : DEUX objets concaténés → le premier seul',
  extraitPremierJson('{"a":1}{"a":2}') === '{"a":1}',
  String(extraitPremierJson('{"a":1}{"a":2}'))
)
verifie(
  'json : accolade dans une chaîne ne referme rien',
  extraitPremierJson('{"a":"} pas fini","b":2}') === '{"a":"} pas fini","b":2}',
  String(extraitPremierJson('{"a":"} pas fini","b":2}'))
)
verifie(
  'json : guillemet échappé dans une chaîne',
  extraitPremierJson('{"a":"il a dit \\"oui\\"","b":2}') === '{"a":"il a dit \\"oui\\"","b":2}'
)
verifie('json : objet imbriqué', extraitPremierJson('{"a":{"b":1}}') === '{"a":{"b":1}}')
verifie('json : rien à extraire', extraitPremierJson('aucun json') === null)
verifie('json : accolade jamais refermée', extraitPremierJson('{"a":1') === null)

// ─── Sélection de piste du DA ────────────────────────────────────────────────

{
  const pm = { familles_retenues: [30, 180, 0] }
  const piste = (nom: string, elems: number, coul: number, pal: string[], phrase: string, sujet = 'anvil'): Piste => ({
    nom,
    forme: phrase,
    nb_elements: elems,
    nb_couleurs: coul,
    sujet,
    construction_geometrique: 'axe vertical',
    reduction: { retire: ['un détail'], pourquoi: 'plus lisible', forme_reduite: phrase, nb_elements: elems, nb_couleurs: coul, palette_hex: pal, sujet },
  })

  const bonne = piste('bonne', 1, 2, ['#ffffff', '#00d2ff'], 'une forme massive et simple')
  verifie('DA : une piste conforme n\'a aucune violation', violations(bonne, 2, 2, pm).length === 0, violations(bonne, 2, 2, pm).join(' ; '))

  const tropElems = piste('trop', 3, 2, ['#ffffff', '#00d2ff'], 'trois formes séparées ici présentes')
  verifie('DA : trop de formes → violation', violations(tropElems, 2, 2, pm).some((v) => v.includes('nb_elements')))

  const sansNeutre = piste('sansneutre', 1, 2, ['#ff4500', '#ff8c00'], 'deux oranges saturés sans neutre')
  verifie(
    'DA : palette sans neutre → violation (le cas VULCAIN réel)',
    violations(sansNeutre, 2, 2, pm).some((v) => v.includes('palette hors idiome')),
    violations(sansNeutre, 2, 2, pm).join(' ; ')
  )

  const palMalFormee = piste('malformee', 1, 2, ['#ffffff', 'bleu'], 'une palette mal écrite ici')
  verifie('DA : palette mal formée → violation', violations(palMalFormee, 2, 2, pm).some((v) => v.includes('mal formée')))

  const desaccord = piste('desaccord', 1, 3, ['#ffffff', '#00d2ff'], 'nb_couleurs ne colle pas à la palette')
  verifie('DA : palette de longueur incohérente → violation', violations(desaccord, 2, 3, pm).some((v) => v.includes('entrée(s) pour nb_couleurs')))

  // moins de formes passe avant tout le reste
  const v2 = choisis(
    [
      piste('deux formes', 2, 2, ['#ffffff', '#00d2ff'], 'très bref'),
      piste('une forme', 1, 2, ['#ffffff', '#00d2ff'], 'une phrase nettement plus longue que la précédente vraiment'),
    ],
    2,
    2,
    pm
  )
  verifie('DA : moins de formes passe avant tout le reste', v2.index === 1, JSON.stringify(v2))

  // une piste hors bornes est écartée même si elle est la plus brève
  const v3 = choisis(
    [
      piste('hors bornes', 1, 2, ['#ff4500', '#ff8c00'], 'très bref'),
      piste('conforme', 2, 2, ['#ffffff', '#00d2ff'], 'une phrase nettement plus longue que la précédente vraiment'),
    ],
    2,
    2,
    pm
  )
  verifie('DA : une piste hors bornes est écartée même la plus brève', v3.index === 1, JSON.stringify(v3))

  // aucune conforme : on prend la moins fautive ET on le dit
  const v4 = choisis(
    [
      piste('trois fautes', 5, 5, ['#ff4500'], 'a'),
      piste('une faute', 1, 2, ['#ff4500', '#ff8c00'], 'une phrase suffisamment longue ici'),
    ],
    2,
    2,
    pm
  )
  verifie('DA : aucune conforme → la moins fautive', v4.index === 1, JSON.stringify(v4))
  verifie('DA : et les violations sont NOMMÉES', v4.hors_bornes.length > 0 && v4.motif.includes('AUCUNE'), JSON.stringify(v4))

  // à égalité stricte, la première (mandat)
  const v5 = choisis(
    [
      piste('a', 1, 2, ['#ffffff', '#00d2ff'], 'phrase de test identique'),
      piste('b', 1, 2, ['#ffffff', '#00d2ff'], 'phrase de test identique'),
    ],
    2,
    2,
    pm
  )
  verifie('DA : à égalité stricte, la première', v5.index === 0)

  verifie('mots : compte les mots', mots('  une   phrase de test ') === 4, String(mots('  une   phrase de test ')))

  // le sujet doit survivre à la réduction — le cas VULCAIN réel
  const sujetEfface: Piste = {
    ...piste('efface', 1, 2, ['#e0e0e0', '#ff3300'], 'un demi-cercle massif posé sur un trapèze', 'volcano'),
    reduction: {
      retire: ['les trois entailles au sommet'],
      pourquoi: 'plus lisible à 64 px',
      forme_reduite: 'un demi-cercle massif posé sur un trapèze',
      nb_elements: 1,
      nb_couleurs: 2,
      palette_hex: ['#e0e0e0', '#ff3300'],
      sujet: 'semi-circle on a trapezoid',
    },
  }
  verifie(
    'DA : une réduction qui efface le sujet → violation',
    violations(sujetEfface, 2, 2, pm).some((v) => v.includes('effacé le sujet')),
    violations(sujetEfface, 2, 2, pm).join(' ; ')
  )

  const sujetChange: Piste = {
    ...piste('change', 1, 2, ['#e0e0e0', '#ff3300'], 'une enclume massive et compacte', 'anvil'),
    reduction: {
      retire: ['la corne'],
      pourquoi: 'plus simple',
      forme_reduite: 'une enclume massive et compacte',
      nb_elements: 1,
      nb_couleurs: 2,
      palette_hex: ['#e0e0e0', '#ff3300'],
      sujet: 'hammer',
    },
  }
  verifie(
    'DA : un sujet qui CHANGE à la réduction → violation',
    violations(sujetChange, 2, 2, pm).some((v) => v.includes('a CHANGÉ')),
    violations(sujetChange, 2, 2, pm).join(' ; ')
  )

  // le départage par longueur de phrase est RETIRÉ : à égalité, la première
  const v6 = choisis(
    [
      piste('longue mais première', 1, 2, ['#ffffff', '#00d2ff'], 'une phrase nettement plus longue que sa voisine de droite ici'),
      piste('brève mais seconde', 1, 2, ['#ffffff', '#00d2ff'], 'brève ici vraiment'),
    ],
    2,
    2,
    pm
  )
  verifie('DA : la brièveté ne départage plus — la première gagne', v6.index === 0, JSON.stringify(v6))
}

// ─── « Est-ce que ça veut dire quelque chose » ────────────────────────────────

verifie('sujet : « winged V » porte un sujet', decisionSujet('winged V').passe)
verifie('sujet : « anvil and flame » porte un sujet', decisionSujet('anvil and flame').passe)
verifie('sujet : « volcano » porte un sujet', decisionSujet('volcano').passe)
verifie('sujet : « diamond » reste un sujet (pas de la géométrie pure)', decisionSujet('diamond').passe)
verifie('sujet : « shield » reste un sujet', decisionSujet('shield').passe)
verifie(
  'sujet : « octagon inside a circle » ne porte rien',
  !decisionSujet('octagon inside a circle').passe,
  decisionSujet('octagon inside a circle').detail
)
verifie('sujet : « an abstract geometric shape » ne porte rien', !decisionSujet('an abstract geometric shape').passe)
verifie('sujet : « nothing » ne porte rien', !decisionSujet('nothing').passe)
verifie('sujet : « a white blob » ne porte rien', !decisionSujet('a white blob').passe)
verifie('sujet : « logo » ne porte rien — nommer « un logo » ne nomme rien', !decisionSujet('logo').passe)
verifie('sujet : vide → refus', !decisionSujet('').passe)
verifie('sujet : null → refus', !decisionSujet(null).passe)
verifie('sujet : ponctuation seule → refus', !decisionSujet('???').passe)
verifie('sujet : « semi-circle on a trapezoid » ne porte rien', !decisionSujet('semi-circle on a trapezoid').passe, decisionSujet('semi-circle on a trapezoid').detail)

// ─── Accent significatif et couleur enclavée ─────────────────────────────────

{
  const pm = { familles_retenues: [30, 180, 0] }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M100 100 h300 v300 h-300 z" fill="#e0e0e0"/></svg>`
  const m = await mesureSvg(svg)
  const g = (accentMin: number, regions: Array<{ hex: string; part: number; touche_le_bord: boolean }>) =>
    gardes(m, ['#e0e0e0'], 2, 2, pm, 'none', 0, accentMin, regions)

  const confetti = [
    { hex: '#ffffff', part: 0.954, touche_le_bord: true },
    { hex: '#00d0ff', part: 0.046, touche_le_bord: true },
  ]
  const commeLaCible = [
    { hex: '#ffffff', part: 0.864, touche_le_bord: true },
    { hex: '#33ccff', part: 0.136, touche_le_bord: true },
  ]
  const monochrome = [{ hex: '#e0e0e0', part: 1, touche_le_bord: true }]
  const aplatPerce = [
    { hex: '#ff3300', part: 0.744, touche_le_bord: true },
    { hex: '#e0e0e0', part: 0.256, touche_le_bord: false },
  ]

  verifie(
    'accent : 4,6 % refusé au plancher 0,088 (le confetti cyan de NOX)',
    g(0.088, confetti).find((x) => x.nom === 'accent_significatif')?.passe === false
  )
  verifie(
    'accent : 13,6 % accepté — c\'est black-world1, la cible du mandat',
    g(0.088, commeLaCible).find((x) => x.nom === 'accent_significatif')?.passe === true
  )
  verifie(
    'accent : une marque monochrome est hors sujet, pas fautive',
    g(0.088, monochrome).find((x) => x.nom === 'accent_significatif')?.passe === true
  )
  verifie('accent : plancher 0 = garde neutre', g(0, confetti).find((x) => x.nom === 'accent_significatif')?.passe === true)

  verifie(
    'enclave : un îlot au centre d\'un champ est refusé (l\'aplat orange percé)',
    g(0.088, aplatPerce).find((x) => x.nom === 'aucune_couleur_enclavee')?.passe === false,
    JSON.stringify(g(0.088, aplatPerce).find((x) => x.nom === 'aucune_couleur_enclavee'))
  )
  verifie(
    'enclave : deux couleurs qui affleurent toutes deux passent',
    g(0.088, commeLaCible).find((x) => x.nom === 'aucune_couleur_enclavee')?.passe === true
  )
  verifie(
    'enclave : une marque monochrome ne peut pas être enclavée',
    g(0.088, monochrome).find((x) => x.nom === 'aucune_couleur_enclavee')?.passe === true
  )
  /*
   * La borne que la mesure a REMPLACÉE : un plancher sur la part de neutre aurait
   * refusé `welllogo` (W tout en or, 2 % de neutre) et `goldenlogo` (0 %), deux
   * exemplaires CANONIQUES. Les deux passent les bornes retenues.
   */
  const orIntegral = [{ hex: '#d9a520', part: 1, touche_le_bord: true }]
  verifie(
    'welllogo/goldenlogo : une marque tout en or passe les deux bornes retenues',
    g(0.088, orIntegral).find((x) => x.nom === 'accent_significatif')?.passe === true &&
      g(0.088, orIntegral).find((x) => x.nom === 'aucune_couleur_enclavee')?.passe === true
  )
}

// ─── regionsCouleur : la topologie, mesurée sur de vrais rendus ──────────────

{
  //  un aplat orange percé d'un carré gris central : le gris est un ÎLOT
  const perce = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
    <path d="M56 56 h400 v400 h-400 z" fill="#ff3300"/>
    <path d="M180 180 h152 v152 h-152 z" fill="#e0e0e0"/></svg>`
  const rp = await regionsCouleur(await renduSvg(perce, 512))
  const gris = rp.find((r) => r.hex.startsWith('#e') || r.hex.startsWith('#d'))
  verifie('regionsCouleur : le carré gris central est enclavé', gris?.touche_le_bord === false, JSON.stringify(rp))
  verifie('regionsCouleur : l\'orange affleure', rp.find((r) => r.hex.startsWith('#f'))?.touche_le_bord === true, JSON.stringify(rp))

  //  deux moitiés côte à côte : les deux affleurent
  const moities = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
    <path d="M56 56 h200 v400 h-200 z" fill="#ffffff"/>
    <path d="M256 56 h200 v400 h-200 z" fill="#00d0ff"/></svg>`
  const rm = await regionsCouleur(await renduSvg(moities, 512))
  verifie('regionsCouleur : deux moitiés affleurent toutes deux', rm.length === 2 && rm.every((r) => r.touche_le_bord), JSON.stringify(rm))

  //  un aplat uni : une seule région, qui affleure
  const uni = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M100 100 h300 v300 h-300 z" fill="#e0e0e0"/></svg>`
  const ru = await regionsCouleur(await renduSvg(uni, 512))
  verifie('regionsCouleur : un aplat uni = 1 région affleurante', ru.length === 1 && ru[0]!.touche_le_bord, JSON.stringify(ru))
}

// ─── Bilan ───────────────────────────────────────────────────────────────────

console.log(`\nv7-tests : ${ok} verts, ${ko} rouges`)
if (echecs.length) {
  console.log('\nÉCHECS :')
  for (const e of echecs) console.log(`  ✗ ${e}`)
  process.exit(1)
}
