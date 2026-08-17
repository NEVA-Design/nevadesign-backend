/*
 * Run 7 — PHASE 6 : LE BRAS TÉMOIN. Les deux mêmes sujets, en mono-moteur.
 *
 * Sans témoin on ne saura pas si la séparation des moteurs apporte quelque
 * chose. Le témoin n'est pas une reconstitution approximative du v6 : c'est le
 * v6 lui-même, `directLogoConceptsV6` + `pickExemplarsParSlugs` +
 * `generateWithOcrGate`, dans son dernier état — clause de cadrage, REFERENCE 1
 * en cible de copie, quatre familles de rendu, clause anti-détail.
 *
 *   bun run scripts/calibration/v7-temoin.ts [--sujets nox,vulcain] [--fresh]
 *
 * Deux précisions qui comptent pour la lecture du résultat :
 *
 * 1. Les briefs sont EXACTEMENT ceux du run 6 (`briefs-e3.ts`, `nox` et
 *    `vulcain`) — le hasard fait bien les choses, le mandat de cette session a
 *    choisi les deux mêmes sujets. La comparaison porte donc sur le moteur, pas
 *    sur le brief.
 * 2. Le run 6 s'est arrêté en laissant `vulcain` NON REJOUÉ avec la clause
 *    anti-détail (« No inner paneling, no rivets, no gears, no secondary
 *    shapes »), et cette clause portait un risque documenté : ce sont les
 *    premières clauses négatives réintroduites depuis le 5.9, où « contour blanc
 *    épais » écrit en négation avait été exécuté À LA LETTRE. Ce témoin la joue
 *    enfin. Le point reste ouvert au journal du run 6 ; il se ferme ici, sur
 *    image.
 *
 * `choisirConcept` est RECOPIÉ depuis `e3-briefs.ts` au lieu d'être importé :
 * ce fichier-là est un script qui installe la garde budget de la session 6 au
 * chargement. Deux gardes sur le même `fetch` écriraient dans deux grands livres
 * — et on l'a déjà payé une fois cette session en important `v7-svg.ts`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import sharp from 'sharp'
import {
  installBudgetGuard,
  PhaseBudgetError,
  PLAFONDS_PHASE,
  setBudgetLabel,
  setPhase,
  spentForPhase,
  V7_DIR,
} from './budget7'
import { SUJETS } from './v7-sujets'
import { arrondi, boiteMasque, masqueOpacite, mesureFond } from './v7-lib'
import { briefE3, motAttendu, type BriefE3 } from './briefs-e3'
import { artDirectionForProject } from '../../src/lib/engine/mapping'
import { directLogoConceptsV6, ARCHETYPE_SANS_LETTRAGE, type LogoConceptV6 } from '../../src/lib/engine/logo-director-v6'
import { pickExemplarsParSlugs } from '../../src/lib/engine/exemplars'
import { generateWithOcrGate } from '../../src/lib/engine/ocr-gate'
import { ENGINE_MODELS, LOGO_THINKING_LEVEL } from '../../src/lib/engine/generation'
import { requireTraining } from '../../src/lib/engine/adn'

installBudgetGuard()
setPhase('p6-temoin')

const args = process.argv.slice(2)
const fresh = args.includes('--fresh')
const valeur = (nom: string): string | null => {
  const i = args.indexOf(nom)
  return i >= 0 ? (args[i + 1] ?? null) : null
}
const filtre = valeur('--sujets')
const ids = (filtre ? filtre.split(',') : SUJETS.map((s) => s.id)).map((x) => x.trim())
const RESOLUTION = (valeur('--resolution') ?? '2K') as '1K' | '2K'
const USER = 'calibration-run7-temoin'

/** Recopié de `e3-briefs.ts` — voir l'en-tête pour la raison. Règle inchangée. */
function choisirConcept(concepts: LogoConceptV6[]): LogoConceptV6 {
  const plats = concepts.filter((c) => c.famille_rendu !== 'chrome_3d')
  const pool = plats.length ? plats : concepts
  for (const archetype of ['HERO_MONOGRAM', 'WORDMARK_PUR', 'ENTWINED', 'CONTAINER', 'CREST', 'SCENE', ARCHETYPE_SANS_LETTRAGE]) {
    const trouve = pool.find((c) => c.archetype === archetype)
    if (trouve) return trouve
  }
  return pool[0]!
}

console.log(`\n═══ PHASE 6 — BRAS TÉMOIN (mono-moteur raster, configuration v6 du jour) ═══`)
console.log(`  DA ${ENGINE_MODELS.logoDirector} · image ${ENGINE_MODELS.logoImage} ${RESOLUTION} · thinking ${LOGO_THINKING_LEVEL}`)
console.log(`  plafond de phase ${PLAFONDS_PHASE['p6-temoin']!.toFixed(2)} € · déjà dépensé ${spentForPhase('p6-temoin').toFixed(4)} €\n`)

requireTraining()

for (const id of ids) {
  let b: BriefE3
  try {
    b = briefE3(id)
  } catch (err) {
    console.log(`  ✗ ${id} : ${(err as Error).message}`)
    continue
  }
  const dossier = join(V7_DIR, 'temoin', id)
  mkdirSync(dossier, { recursive: true })
  const cible = join(dossier, 'temoin.png')
  if (existsSync(cible) && !fresh) {
    console.log(`  ${id} : déjà rendu — --fresh pour rejouer.`)
    continue
  }

  const mot = motAttendu(b)
  console.log(`  ── ${b.project.name} ── ${mot ? `mot attendu « ${mot} »` : 'AUCUN lettrage'}`)

  // ── étage 1 : le DA v6, tel quel ──
  let concept: LogoConceptV6
  try {
    setBudgetLabel(`p6-temoin-da-${id}`)
    const { da, energie, modernite } = artDirectionForProject(b.project)
    const direction = await directLogoConceptsV6({
      project: b.project,
      da,
      answers: b.answers,
      energie,
      modernite,
      moteur: 'gemini',
      log: { userId: USER, projectId: null, assetId: null },
    })
    concept = choisirConcept(direction.concepts)
    writeFileSync(join(dossier, 'concepts.json'), JSON.stringify({ rendu: concept, tous: direction.concepts }, null, 2))
  } catch (err) {
    if (err instanceof PhaseBudgetError) {
      console.log(`     ⛔ ${err.message}`)
      break
    }
    console.log(`     ✗ DA en échec : ${(err as Error).message}`)
    continue
  }

  console.log(`     concept : ${concept.archetype} · ${concept.famille_rendu} · réfs ${concept.refs.map((r) => r.slug).join(', ')}`)
  console.log(`     prompt (${concept.prompt.trim().split(/\s+/).length} mots) : ${concept.prompt}`)

  // ── étage 2 : le rendu intégral, porte OCR comprise ──
  let png: Buffer
  let ocrRejects = 0
  let ocrDetail = ''
  try {
    setBudgetLabel(`p6-temoin-image-${id}`)
    const references = pickExemplarsParSlugs({ category: 'logo', choix: concept.refs })
    const generation = await generateWithOcrGate({
      model: ENGINE_MODELS.logoImage,
      prompt: concept.prompt,
      referenceImages: references.map((r) => ({ data: r.data, mimeType: r.mimeType })),
      referencesFirst: true,
      referenceLabels: references.map((r) => r.label),
      imageConfig: { aspectRatio: '1:1', imageSize: RESOLUTION },
      thinkingLevel: LOGO_THINKING_LEVEL,
      expectedTexts: mot ? [mot] : [],
      forbidAnyText: mot === null,
      // Piège n°22 : toute image payée touche le disque avant l'appel suivant.
      onImagePayee: (dataUrl, essai) => {
        writeFileSync(join(dossier, `brut-essai${essai}.png`), Buffer.from(dataUrl.split(',').pop() ?? '', 'base64'))
      },
      log: { userId: USER, projectId: null, assetId: null, kind: `v7_temoin_${id}`, resolution: RESOLUTION },
    })
    png = Buffer.from(generation.dataUrl.split(',').pop() ?? '', 'base64')
    ocrRejects = generation.ocrRejects
    ocrDetail = generation.ocrDetail
  } catch (err) {
    if (err instanceof PhaseBudgetError) {
      console.log(`     ⛔ ${err.message}`)
      break
    }
    console.log(`     ✗ rendu en échec : ${(err as Error).message}`)
    continue
  }

  await sharp(png).resize(1024, 1024, { fit: 'cover' }).png().toFile(cible)
  await sharp(png).resize(64, 64, { fit: 'cover' }).png().toFile(join(dossier, 'temoin-64.png'))
  writeFileSync(join(dossier, 'prompt.txt'), concept.prompt)

  /*
   * Les MÊMES mesures que sur le bras v7, sur le même livrable 1024. Un témoin
   * qui ne se mesure pas avec le même instrument ne prouve rien.
   * La marque du témoin est peinte : on la segmente par contraste au fond, comme
   * les pièces du corpus. Le chiffre est donc de la même famille que celui des
   * cibles, pas de celle des SVG (où l'alpha donne un masque exact).
   */
  const mille = await sharp(cible).png().toBuffer()
  const cadre = await mesureFond(mille)
  const masque = await masqueMarquePeinte(mille)
  const boite = boiteMasque(masque)
  const encreMasque = masque.m.reduce<number>((n, v) => n + v, 0) / masque.m.length
  const masse = boite && boite.aire > 0 ? arrondi(encreMasque / boite.aire, 4) : null
  const fondHorsMarque = boite
    ? await mesureFond(mille, [
        Math.round(boite.y0 * 1000),
        Math.round(boite.x0 * 1000),
        Math.round(boite.y1 * 1000),
        Math.round(boite.x1 * 1000),
      ])
    : cadre

  writeFileSync(
    join(dossier, 'temoin.json'),
    JSON.stringify(
      {
        sujet: id,
        nom: b.project.name,
        mot_attendu: mot,
        archetype: concept.archetype,
        famille_rendu: concept.famille_rendu,
        refs: concept.refs.map((r) => r.slug),
        prompt: concept.prompt,
        mots_du_prompt: concept.prompt.trim().split(/\s+/).length,
        ocr: { rejets: ocrRejects, detail: ocrDetail },
        resolution: RESOLUTION,
        mesures: { cadre_entier: cadre, fond_hors_marque: fondHorsMarque, boite_marque: boite, masse },
        cout_eur: arrondi(spentForPhase('p6-temoin'), 4),
      },
      null,
      2
    )
  )

  console.log(`     OCR : ${ocrRejects} rejet(s) · ${ocrDetail}`)
  console.log(`     mesuré : fond hors marque L ${fondHorsMarque.luminance} · C ${fondHorsMarque.contraste} · S ${fondHorsMarque.saturation} · masse ${masse}`)
  console.log(`     → ${cible} · phase 6 : ${spentForPhase('p6-temoin').toFixed(4)} €\n`)
}

console.log(`  dépensé phase 6 : ${spentForPhase('p6-temoin').toFixed(4)} € / ${PLAFONDS_PHASE['p6-temoin']!.toFixed(2)} €\n`)

/**
 * Segmente une marque PEINTE par écart au fond, comme les pièces raster du
 * corpus : la luminance de référence est celle du bord de l'image (une marque de
 * ce corpus est centrée), et on garde ce qui s'en écarte franchement.
 */
async function masqueMarquePeinte(png: Buffer): Promise<{ w: number; h: number; m: Uint8Array }> {
  const N = 256
  const { data } = await sharp(png).resize(N, N, { fit: 'fill' }).flatten({ background: '#000000' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const luma = (i: number) => (0.2126 * data[i * 3]! + 0.7152 * data[i * 3 + 1]! + 0.0722 * data[i * 3 + 2]!) / 255
  // le fond : la bande de 12 % en périphérie
  const marge = Math.round(N * 0.12)
  let somme = 0
  let n = 0
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      if (y >= marge && y < N - marge && x >= marge && x < N - marge) continue
      somme += luma(y * N + x)
      n += 1
    }
  }
  const fond = n ? somme / n : 0
  const m = new Uint8Array(N * N)
  for (let i = 0; i < N * N; i += 1) m[i] = Math.abs(luma(i) - fond) > 0.25 ? 1 : 0
  return { w: N, h: N, m }
}
