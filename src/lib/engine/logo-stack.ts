/*
 * Run 5.7 — LOT 3 : la pile de calques superposés.
 *
 * La technologie PSD (13 PSD pros décomposés, logo.json.recettes_calques) a
 * montré comment les pros construisent : fond → textures → effets lumière →
 * emblème → lettrage typographié + styles → accents. Ce module est la version
 * exécutable de cette pile :
 *
 *   [fond IA plein cadre]            ← généré SEUL (OCR exclusion, aucun texte)
 *   [glow de contact]                ← local (sharp)
 *   [emblème IA détouré]             ← généré SEUL sur #F2F2F2 puis cutout local
 *   [lettrage typographié + styles]  ← local (lettrage.ts, bornes PSD)
 *   [grain global léger]             ← local, voile unifiant
 *
 * Chaque calque est régénérable indépendamment. Le master 4K est un
 * RÉ-ASSEMBLAGE local (zéro appel API) ; les déclinaisons (alpha, blanc, noir)
 * dérivent du couple lettrage+emblème SANS le fond — le détourage est trivial
 * par construction.
 *
 * La génération monolithique « un logo entier » n'existe plus nulle part.
 */

import sharp, { type OverlayOptions } from 'sharp'
import { renderLettrage, resolveFont, psdBornes, loadFonts, type LettrageStyle, type GradientStop } from './lettrage'
import { LOGO_BACKGROUND_HEX, LOGO_REFERENCES_BLOCK } from './compiler'
import type { LogoAnswersV3 } from './logo-brief'
import type { LogoFamilleRendu } from './logo-director'

// ── la recette de calques émise par le directeur artistique ──────────────────

export type CalqueLettrage = {
  texte: string
  police: string
  couleur?: string
  gradient?: { stops: GradientStop[]; angle?: number }
  contour?: { taillePx: number; couleur: string; position?: 'outside' | 'inside' }
  glow?: { taillePx: number; couleur: string; opacite: number }
  ombre?: { taillePx: number; distancePx: number; opacite?: number; couleur?: string }
  tracking?: number
  scaleX?: number
  skewX?: number
}

export type CalqueEmbleme = {
  /** description visuelle de l'emblème SEUL (jamais de lettres) — run 5.9 :
   *  toujours en anglais */
  description: string
  /** part de la largeur du canevas (0.3-0.75) */
  echelle?: number
  /** run 5.9 : le mot verbatim du sujet du brief dont dérive l'emblème */
  derive_de?: string
}

// Run 5.8 : le LOCKUP FUSIONNÉ — emblème + lettrage dessinés ENSEMBLE en une
// seule image par le modèle. C'est le chemin par défaut dès que le brief
// demande un lettrage : les références du corpus sont des lockups fusionnés
// (lettres traversées par l'emblème, coupes custom, chrome, extrusions) que
// le duo « emblème IA + lettrage local posé par-dessus » ne peut pas produire
// — ce collage était précisément l'effet sticker interdit partout.
// La recette calques.lettrage reste complète : c'est le FALLBACK exécuté en
// silence si l'orthographe du lockup échoue après 3 tentatives.
export type CalqueLockup = {
  /**
   * le lockup complet décrit comme UNE pièce : quelle lettre porte l'emblème,
   * où passent les coupes, et le traitement typographique en vocabulaire
   * concret et positif (polished chrome bevels, deep matte extrusion,
   * layered strokes, sharp angular cuts, letters sliced by the emblem).
   * Run 5.9 (chantier 4) : TOUJOURS EN ANGLAIS — cette description part
   * verbatim vers le modèle image (iter10b-58 : « contour blanc épais »
   * écrit par le DA en français a produit l'interdit n°1 du corpus).
   */
  description: string
  /** part de la largeur du canevas (0.5-0.8) */
  echelle?: number
  /** run 5.9 : le mot VERBATIM du sujet du brief dont dérive l'emblème du
   *  lockup — vérifié en code contre le sujet (un épi de blé sur un brief
   *  fruit d'été devient structurellement impossible) */
  derive_de?: string
}

export type CalqueFond = {
  famille: 'motif' | 'scene' | 'texture' | 'combinaison'
  /** le contenu précis du fond, tiré de la section 2bis du concept */
  description: string
}

export type LogoCalquesRecette = {
  disposition: 'fusion' | 'pile' | 'lettrage_seul' | 'embleme_seul'
  /** run 5.8 : le lockup fusionné IA — présent dès que le brief a un lettrage */
  lockup?: CalqueLockup
  lettrage?: CalqueLettrage
  embleme?: CalqueEmbleme
  fond: CalqueFond
}

// ── validation de la recette (le validateur du DA s'appuie dessus) ───────────

const DISPOSITIONS = ['fusion', 'pile', 'lettrage_seul', 'embleme_seul'] as const

// Run 5.9 (chantier 4) : tout ce qui part vers le modèle image est rédigé en
// ANGLAIS. Le DA de gemini-3.1-pro écrivait ses descriptions en français au
// milieu des prompts anglais (les 3 itérations 5.8) — « feuille de palmier »
// est devenue un épi de blé. Détection : accents français, ou deux mots-outils
// français sûrs.
export function detecteFrancais(text: string): boolean {
  if (/[àâäéèêëîïôöùûüç]/i.test(text)) return true
  const outils = text.toLowerCase().match(/\b(le|la|les|une|des|avec|dans|remplace|lourd|épais)\b/g) ?? []
  return outils.length >= 2
}

// Run 5.9 (chantier 4) : les demandes interdites que le DA lui-même a émises
// au 5.8 — contour/bordure autour du lockup ENTIER (iter10b : « contour blanc
// épais ») et vernis candy/gel uniforme. Rejet AVANT tout appel image. Le
// message CITE le fragment fautif et donne la reformulation attendue : à la
// 2e tentative le DA reçoit ces erreurs — un message actionnable évite qu'il
// répète la même faute (vu au premier run 5.9 : 2/2 tentatives rejetées).
export function demandeInterdite(descriptionBrute: string): string | null {
  // Les NÉGATIONS légitimes (« never a uniform candy coat », « no wet gel
  // coat » — le DA répète la material law en négatif) sont neutralisées
  // avant le test : on ne rejette que ce qui est DEMANDÉ, pas ce qui est
  // interdit. Même principe que le « never empty » de la section 2bis.
  const description = descriptionBrute.replace(/\b(never|no|not|without|avoid(?:ing)?|instead of|rather than)\b[^.;:]{0,110}/gi, ' ')
  const cite = (m: RegExpMatchArray | null) => (m ? ` — offending fragment: "${m[0].slice(0, 90)}"` : '')
  let m = description.match(/(outline|border|stroke|contour|keyline)[^.]{0,80}around (the )?(whole|entire|full|complete)\s*(lockup|wordmark|logo|word|mark)/i)
  if (m) {
    return `asks for an outline/border around the WHOLE lockup (the corpus sticker marker)${cite(m)}. Rewrite: the outline hugs EACH letterform's own silhouette`
  }
  m = description.match(/(thick|fat|heavy|bold)\s+(white\s+)?(outline|border|contour)(?![^.]{0,60}(each|every|per[- ]?letter|individual|its own|hugging))/i)
  if (m) {
    return `asks for a thick outline without per-letterform scoping (reads as a sticker border)${cite(m)}. Rewrite: "a clean outline hugging each letterform's own silhouette"`
  }
  m = description.match(/contour\s+(blanc\s+)?épais|bordure\s+épaisse|vernis/i)
  if (m) {
    return `asks in French for a thick contour/varnish (the iter10b-58 failure)${cite(m)}`
  }
  m = description.match(/(uniform|full|overall|all[- ]?over|wet|glossy|shiny)[^.]{0,30}(candy|gel)\s*(gloss|coat|coating|finish)?/i) ?? description.match(/candy[- ]?gloss/i) ?? description.match(/(uniform|all[- ]?over|overall)\s+(gloss|glossy|wet)\s*(coat|coating|finish|sheen)/i)
  if (m) {
    return `asks for a uniform candy/gel gloss coating (forbidden by the material law)${cite(m)}. Rewrite: "satin/matte fills with ONE controlled specular accent per element"`
  }
  return null
}

// Normalisation accents/casse pour comparer un mot dérivé au sujet du brief.
function normaliseMot(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

export function validateCalquesRecette(raw: unknown, opts: { attenduTexte: string | null; sujet?: string }): { recette: LogoCalquesRecette } | { errors: string[] } {
  const errors: string[] = []
  const r = raw as Partial<LogoCalquesRecette> | null | undefined
  if (!r || typeof r !== 'object') return { errors: ['calques: object missing'] }

  // Run 5.9 : langue + interdits + dérivation du sujet, sur toutes les
  // descriptions qui partent vers le modèle image.
  const sujetNorm = normaliseMot(opts.sujet ?? '')
  const sujetMots = sujetNorm.split(/[,\s]+/).filter((m) => m.length >= 3)
  const verifieDescription = (champ: string, description: unknown, deriveDe?: unknown) => {
    if (typeof description !== 'string' || !description.trim()) return
    if (detecteFrancais(description)) {
      errors.push(`${champ}.description must be written in ENGLISH — it is sent verbatim to the image model (French words/accents detected)`)
    }
    const interdit = demandeInterdite(description)
    if (interdit) errors.push(`${champ}.description ${interdit}`)
    if (sujetMots.length && deriveDe !== undefined) {
      const mot = normaliseMot(String(deriveDe ?? ''))
      if (!mot) {
        errors.push(`${champ}.derive_de missing — name the VERBATIM brief-subject word this emblem derives from (subject: "${opts.sujet}")`)
      } else if (!sujetMots.some((s) => s.includes(mot) || mot.includes(s))) {
        errors.push(`${champ}.derive_de "${deriveDe}" is not a word of the brief subject "${opts.sujet}" — the emblem must derive from the subject`)
      }
    }
  }

  if (!DISPOSITIONS.includes(r.disposition as never)) {
    errors.push(`calques.disposition must be one of ${DISPOSITIONS.join(' / ')}`)
  }
  const fond = r.fond as Partial<CalqueFond> | undefined
  if (!fond || !['motif', 'scene', 'texture', 'combinaison'].includes(String(fond.famille))) {
    errors.push('calques.fond.famille must be motif / scene / texture / combinaison')
  }
  if (!fond?.description || String(fond.description).trim().length < 20) {
    errors.push('calques.fond.description must describe the backdrop content (>= 20 chars)')
  }
  verifieDescription('calques.fond', fond?.description)

  if (opts.attenduTexte) {
    // Run 5.8 : le lockup fusionné est OBLIGATOIRE dès que le brief a un
    // lettrage — c'est le chemin d'exécution par défaut. Sa description doit
    // décrire le traitement typographique en vocabulaire concret (le
    // validateur cherche au moins un terme de métier).
    const lk = r.lockup as Partial<CalqueLockup> | undefined
    if (!lk || typeof lk.description !== 'string' || lk.description.trim().length < 80) {
      errors.push('calques.lockup.description missing or too short (>= 80 chars): describe the fused lockup as ONE piece — which letter carries the emblem, where the cuts pass, the typographic treatment')
    } else {
      if (!/bevel|extrusion|extrude|chrome|metal|stroke|outline|inline|contour|cut|carve|slice|fracture|chamfer|ligature|satin|matte|glow|emboss|facet|letterform|italic|layered|tonal|specular|weight|swash|taper|kerning|baseline/i.test(lk.description)) {
        errors.push('calques.lockup.description must state the typographic treatment in concrete positive vocabulary (e.g. polished chrome bevels, deep matte extrusion, layered strokes, sharp angular cuts, letters sliced by the emblem)')
      }
      if (lk.echelle !== undefined && (typeof lk.echelle !== 'number' || lk.echelle < 0.4 || lk.echelle > 0.85)) {
        errors.push('calques.lockup.echelle must be a number in 0.5-0.8')
      }
      // Run 5.9 : langue anglaise, interdits sticker/candy, et emblème dérivé
      // du sujet du brief (derive_de vérifié quand la disposition porte un
      // emblème fusionné).
      verifieDescription('calques.lockup', lk.description, r.disposition === 'lettrage_seul' ? undefined : lk.derive_de)
    }
    // La recette lettrage reste COMPLÈTE : c'est le fallback silencieux quand
    // l'orthographe du lockup échoue après 3 tentatives.
    const l = r.lettrage as Partial<CalqueLettrage> | undefined
    if (!l) {
      errors.push('calques.lettrage missing (the brief requires lettering — it is the fallback recipe)')
    } else {
      if (String(l.texte ?? '').trim().toUpperCase() !== opts.attenduTexte.toUpperCase()) {
        errors.push(`calques.lettrage.texte must be exactly "${opts.attenduTexte}"`)
      }
      if (!l.police || !resolveFont(String(l.police))) {
        errors.push(`calques.lettrage.police "${l?.police}" is not in the embedded catalogue (fonts-map.json)`)
      }
      if (!l.couleur && !l.gradient?.stops?.length) {
        errors.push('calques.lettrage needs couleur or gradient.stops')
      }
      const bornes = psdBornes()
      if (l.contour && (l.contour.taillePx < bornes.stroke.min || l.contour.taillePx > bornes.stroke.max)) {
        errors.push(`calques.lettrage.contour.taillePx=${l.contour.taillePx} outside the PSD distribution [${bornes.stroke.min}-${bornes.stroke.max}] (measured on the PackPsd)`)
      }
      if (l.glow && l.glow.taillePx > bornes.outerGlow.max) {
        errors.push(`calques.lettrage.glow.taillePx=${l.glow.taillePx} outside the PSD distribution (max ${bornes.outerGlow.max})`)
      }
    }
  }
  const emb = r.embleme as Partial<CalqueEmbleme> | undefined
  if ((r.disposition === 'fusion' || r.disposition === 'pile' || r.disposition === 'embleme_seul') && !emb?.description) {
    errors.push('calques.embleme.description required for this disposition')
  }
  if (emb?.description) verifieDescription('calques.embleme', emb.description, emb.derive_de)

  return errors.length ? { errors } : { recette: r as LogoCalquesRecette }
}

// ── prompts par calque (les SEULS prompts image du pipeline logo) ────────────
// Run 5.8 (chantier 3) : les prompts envoyés à l'API image sont une
// DESCRIPTION POSITIVE, CONCRÈTE ET FLUIDE de ce qu'on veut voir — plus
// aucune statistique de corpus (bruit pour un modèle d'image), plus de
// grosses listes FORBIDDEN (elles plantaient les concepts qu'elles
// interdisaient : les emblèmes sortaient en candy-gloss malgré le
// FORBIDDEN). Une seule courte ligne de négatifs vraiment critiques à la
// fin. Le gabarit maître reste côté directeur artistique pour le validateur.

// La langue de finition de chaque famille, en positif — la material law
// reformulée : satin/mat avec grain subtil, UN accent spéculaire contrôlé.
const FAMILLE_FINISH: Record<LogoFamilleRendu, string> = {
  plat_premium:
    'premium flat vector finish: custom-cut letterforms with deliberate chamfers and italic tension, satin fills layered in two or three close tonal steps with subtle inner shading and a whisper of grain, a clean thick outline hugging each element’s own silhouette, and a soft controlled contour glow',
  semi_flat_biseau:
    'semi-flat two-tone finish: matte bevels, sharp deliberate cuts and fractures, satin fills with subtle grain, a tight neon-edged contour glow hugging the silhouette with crisp falloff, and a single controlled specular accent per element',
  dimensionnelle:
    'dimensional finish: deep matte extrusion with satin faces and soft velvet falloff, polished chrome reserved for thin edge bevels and kicker lines, a single controlled specular accent per element, a tight rim glow, and dramatic studio key lighting',
}

/** Épellation lettre-par-lettre du mot du brief — verrou d'orthographe. */
export function spellOut(word: string): string {
  return word.trim().toUpperCase().split('').join('-')
}

/**
 * Run 5.8 — LE LOCKUP FUSIONNÉ : emblème + lettrage dessinés ensemble, en une
 * seule image, sur fond plat pour le détourage. Porte OCR en liste blanche
 * (le mot exact du brief), 3 tentatives, fallback emblème+lettrage local.
 */
export function compileLockupPrompt(opts: {
  lockup: CalqueLockup
  texte: string
  famille: LogoFamilleRendu
  palette: string[]
}): string {
  const mot = opts.texte.trim().toUpperCase()
  const isMonogramme = mot.length === 1
  return [
    isMonogramme
      ? `A single fused monogram lockup for a premium FiveM/GTA RP server: the letter "${mot}" in custom display lettering and its emblem drawn TOGETHER as one interlocked piece of vector artwork — the emblem replaces, crosses or slices the letterform, never floats beside it.`
      : `A single fused logo lockup for a premium FiveM/GTA RP server: the word "${mot}" in custom display lettering and its emblem drawn TOGETHER as one interlocked piece of vector artwork — the emblem replaces, crosses or slices the lettering, never floats beside it.`,
    `THE LOCKUP: ${opts.lockup.description}`,
    isMonogramme
      ? `LETTERING: the mark carries the single letter "${mot}" and nothing else — the letterform stays geometrically clean, with deliberate intersections where the emblem crosses the strokes.`
      : `LETTERING: the word reads exactly "${mot}", spelled ${spellOut(mot)}, and nothing else — every letterform stays geometrically clean and fully legible, with deliberate intersections where the emblem crosses the strokes.`,
    `FINISH: ${FAMILLE_FINISH[opts.famille]}. Fills stay satin and matte with subtle grain; gloss lives in one controlled specular accent per element.`,
    LOGO_REFERENCES_BLOCK,
    `COLORS: built on ${opts.palette.join(' → ')} plus neutral shading.`,
    `COMPOSITION: square image, the lockup perfectly centered on a flat, uniform, seamless light grey ${LOGO_BACKGROUND_HEX} background (no gradient, no shadow, no texture on it — it will be cut out), with 12% clear padding on all sides.`,
    `No extra words, no watermark, no mascot character, no background scenery.`,
  ].join('\n\n')
}

// ── Run 5.9 (chantier 3) : le lettrage verrouillé PAR L'IMAGE ────────────────
// Les glyphes cassaient parce qu'on demandait au modèle de dessiner six
// lettres custom de tête (iter11 : « FRU VTZ », iter12 : R lu P). Ici, le
// moteur local rend d'abord le lettrage en aplat propre (vraie police de la
// recette, orthographe parfaite PAR CONSTRUCTION), et cette image devient la
// BASE STRUCTURELLE de l'appel lockup : le modèle re-rend le lettrage avec le
// traitement demandé et fusionne l'emblème — c'est de l'image-to-image, son
// point fort. L'orthographe est garantie par l'entrée, plus espérée en sortie.

/** Rend le lettrage de la recette en aplat sombre propre sur canevas carré
 *  #F2F2F2 — la base structurelle jointe à l'appel lockup. Zéro effet : la
 *  base donne les FORMES, le traitement vient du prompt. */
export async function renderLettrageBase(calque: CalqueLettrage, taille = 1536): Promise<Buffer> {
  const targetW = Math.round(taille * 0.72)
  const epure: CalqueLettrage = {
    texte: calque.texte,
    police: calque.police,
    couleur: '#1A1A1A',
    tracking: calque.tracking,
  }
  const r = await renderLettrageFitted(epure, targetW)
  const left = Math.round((taille - r.width) / 2)
  const top = Math.round((taille - r.height) / 2)
  return sharp({ create: { width: taille, height: taille, channels: 3, background: LOGO_BACKGROUND_HEX } })
    .composite([{ input: r.png, left, top }])
    .jpeg({ quality: 95 })
    .toBuffer()
}

/** Le prompt lockup en mode ÉDITION : la 1re image jointe est la base
 *  typographique — formes et orthographe à conserver EXACTEMENT. */
export function compileLockupFromBasePrompt(opts: {
  lockup: CalqueLockup
  texte: string
  famille: LogoFamilleRendu
  palette: string[]
}): string {
  const mot = opts.texte.trim().toUpperCase()
  return [
    `Re-render the lettering shown in the FIRST attached image (the structural base) as a premium FiveM/GTA RP server logo lockup.`,
    `STRUCTURAL BASE — NON-NEGOTIABLE: the first image fixes the letterforms, the letter count, the spelling ("${mot}", spelled ${spellOut(mot)}) and the layout. Keep EVERY letter shape exactly as drawn — same skeleton, same proportions, same single line. Do not add, remove, merge, split or restyle any glyph's structure.`,
    `THE LOCKUP: ${opts.lockup.description}`,
    `WHAT CHANGES: dress these exact letterforms with the requested treatment — materials, relief, cuts, edge work — and fuse the emblem through or across the letters exactly as described above. The emblem may cross or slice the strokes, but every letter must remain instantly readable.`,
    `FINISH: ${FAMILLE_FINISH[opts.famille]}. Fills stay satin and matte with subtle grain; gloss lives in one controlled specular accent per element.`,
    LOGO_REFERENCES_BLOCK,
    `COLORS: built on ${opts.palette.join(' → ')} plus neutral shading.`,
    `COMPOSITION: square image, the lockup perfectly centered on a flat, uniform, seamless light grey ${LOGO_BACKGROUND_HEX} background (no gradient, no shadow, no texture on it — it will be cut out), with 12% clear padding on all sides.`,
    `No extra words, no watermark, no mascot character, no background scenery.`,
  ].join('\n\n')
}

/** L'emblème SEUL (chemin fallback + briefs sans lettrage) — aucun texte toléré. */
export function compileEmblemePrompt(opts: {
  embleme: CalqueEmbleme
  famille: LogoFamilleRendu
  palette: string[]
}): string {
  return [
    `A single pictorial emblem for a premium FiveM/GTA RP server logo — the emblem alone, purely pictorial, later composed with custom lettering as one mark.`,
    `THE EMBLEM: ${opts.embleme.description}`,
    `FINISH: ${FAMILLE_FINISH[opts.famille]}. Fills stay satin and matte with subtle grain; gloss lives in one controlled specular accent per element. Crisp vector-grade edges, the silhouette readable as pure flat black.`,
    LOGO_REFERENCES_BLOCK,
    `COLORS: built on ${opts.palette.join(' → ')} plus neutral shading.`,
    `COMPOSITION: square image, the emblem perfectly centered on a flat, uniform, seamless light grey ${LOGO_BACKGROUND_HEX} background (no gradient, no shadow, no texture on it — it will be cut out), with 15% clear padding on all sides.`,
    `No letters, no numbers, no watermark, no mascot character.`,
  ].join('\n\n')
}

/** Le fond plein cadre SEUL — aucun texte toléré. */
export function compileFondCalquePrompt(opts: {
  fond: CalqueFond
  palette: string[]
  sujet: string
}): string {
  // Run 5.9 (chantier 5) : l'ANCRE SOMBRE est la TOUTE PREMIÈRE ligne — la
  // doctrine (78 % du corpus sur fond sombre) était noyée en 3e position et
  // iter10b-58 est sorti clair délavé (tiré par une référence claire).
  return [
    `A DEEP DARK backdrop — the base reads clearly dark (low value, moody, nocturnal), never light, washed-out or pastel. This darkness is the single most important property of this image.`,
    `A full-bleed backdrop layer for a premium FiveM/GTA RP server logo — the stage alone, the mark itself arrives later as a separate layer, so the composition breathes around an intentionally calm center.`,
    `THE BACKDROP: ${opts.fond.description}`,
    `BASE: a deep, dark, nuanced base built on a directional gradient in the palette, a subtle vignette, and a soft wide luminance lift behind the center that melts into the base — felt as light, never as a bright ring or a defined disc.`,
    `WORKED LAYER: the motifs, micro-scene or texture sit at 8-20% visibility, desaturated and value-close to the base — the backdrop is sensed rather than watched, with detail density living toward the edges. No single geometric figure (rings, arcs, burst) may dominate the frame.`,
    `COLORS: built around ${opts.palette.join(' → ')} plus neutral depth shading — anchored in a dark base.`,
    `COMPOSITION: square, full-bleed, the central 55% of the frame stays the calmest and lowest-contrast area, ready to receive the mark.`,
    `No text, no watermark, no sharp foreground objects, no border.`,
  ].join('\n\n')
}

// ── assemblage local de la pile (zéro appel API) ─────────────────────────────

export type StackInput = {
  /** fond plein cadre (PNG/JPEG). Absent → déclinaison alpha pure. */
  fondPng?: Buffer
  /** run 5.8 : lockup fusionné DÉJÀ détouré (PNG alpha) — remplace emblème+lettrage */
  lockupPng?: Buffer
  /** emblème DÉJÀ détouré (PNG alpha) — chemin fallback */
  emblemePng?: Buffer
  recette: LogoCalquesRecette
  /** côté du canevas carré (2048 pour les propositions, 4096 pour le master) */
  taille: number
}

export type StackResult = {
  /** le logo complet (fond + emblème + lettrage + grain) */
  master: Buffer
  /** emblème + lettrage sans le fond — le livrable transparent */
  alpha: Buffer
  width: number
  height: number
}

// Grain global léger : voile unifiant de la pile (les textures de fond à
// 8-20 % voyagent dans le calque fond lui-même, généré d'après la section
// 2bis ; ici c'est le « whisper of grain » des remplissages PSD).
const GRAIN_OPACITY = 0.04

function grainOverlay(width: number, height: number): Buffer {
  const px = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const v = Math.floor(Math.random() * 256)
    px[i * 4] = v
    px[i * 4 + 1] = v
    px[i * 4 + 2] = v
    px[i * 4 + 3] = Math.floor(GRAIN_OPACITY * 255)
  }
  return px
}

async function tintedSilhouette(png: Buffer, color: { r: number; g: number; b: number }, alphaMul: number, blurPx: number): Promise<Buffer> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  for (let p = 0; p < info.width * info.height; p++) {
    data[p * 4] = color.r
    data[p * 4 + 1] = color.g
    data[p * 4 + 2] = color.b
    data[p * 4 + 3] = Math.round((data[p * 4 + 3] ?? 0) * alphaMul)
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).blur(blurPx).png().toBuffer()
}

/** Rend le lettrage à la largeur cible (double rendu : sonde à 100 px, puis à l'échelle). */
export async function renderLettrageFitted(calque: CalqueLettrage, targetWidthPx: number) {
  loadFonts()
  const base: LettrageStyle = {
    famille: calque.police,
    taillePx: 100,
    couleur: calque.couleur,
    gradient: calque.gradient,
    contour: calque.contour ? { ...calque.contour, taillePx: calque.contour.taillePx } : undefined,
    glow: calque.glow,
    ombre: calque.ombre ? { taillePx: calque.ombre.taillePx, distancePx: calque.ombre.distancePx, opacite: calque.ombre.opacite, couleur: calque.ombre.couleur } : undefined,
    tracking: calque.tracking,
    scaleX: calque.scaleX,
    skewX: calque.skewX,
  }
  const probe = await renderLettrage(calque.texte, base)
  const ratio = targetWidthPx / Math.max(1, probe.textBox.width)
  const taille = Math.max(24, Math.min(1200, Math.round(100 * ratio)))
  // les effets sont re-serrés par lettrage.ts à la nouvelle taille (bornes PSD ×taille/100)
  const scaleFx = taille / 100
  return renderLettrage(calque.texte, {
    ...base,
    taillePx: taille,
    contour: base.contour ? { ...base.contour, taillePx: base.contour.taillePx * scaleFx } : undefined,
    glow: base.glow ? { ...base.glow, taillePx: base.glow.taillePx * scaleFx } : undefined,
    ombre: base.ombre ? { ...base.ombre, taillePx: base.ombre.taillePx * scaleFx, distancePx: base.ombre.distancePx * scaleFx } : undefined,
  })
}

export async function assembleLogo(input: StackInput): Promise<StackResult> {
  const S = input.taille
  const { recette } = input

  // ── Run 5.8 : mode LOCKUP FUSIONNÉ — la marque entière (emblème + lettrage
  // dessinés ensemble par l'IA) est UN calque détouré. Le lettrage local et
  // l'emblème séparé n'existent pas sur ce chemin.
  if (input.lockupPng) {
    const ratio = Math.min(0.8, Math.max(0.5, recette.lockup?.echelle ?? 0.66))
    const targetW = Math.round(S * ratio)
    const resized = await sharp(input.lockupPng).resize(targetW, targetW, { fit: 'inside', withoutEnlargement: false }).png().toBuffer()
    const meta = await sharp(resized).metadata()
    const w = meta.width ?? targetW
    const h = meta.height ?? targetW
    const left = Math.round((S - w) / 2)
    const top = Math.round((S - h) / 2)

    const layers: OverlayOptions[] = []
    if (input.fondPng) {
      layers.push({ input: await sharp(input.fondPng).resize(S, S, { fit: 'cover' }).png().toBuffer(), left: 0, top: 0 })
      const silhouette = await sharp({ create: { width: S, height: S, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: resized, left, top }])
        .png()
        .toBuffer()
      layers.push({ input: await tintedSilhouette(silhouette, { r: 255, g: 255, b: 255 }, 0.14, Math.max(6, S / 90)) })
    }
    layers.push({ input: resized, left, top })
    layers.push({ input: grainOverlay(S, S), raw: { width: S, height: S, channels: 4 }, blend: 'overlay' })

    const master = await sharp({
      create: { width: S, height: S, channels: 4, background: input.fondPng ? '#0b0e14' : { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite(layers)
      .png()
      .toBuffer()
    const alpha = await sharp({ create: { width: S, height: S, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: resized, left, top }])
      .png()
      .toBuffer()
    return { master, alpha, width: S, height: S }
  }

  const wantLettrage = recette.disposition !== 'embleme_seul' && recette.lettrage
  const wantEmbleme = recette.disposition !== 'lettrage_seul' && input.emblemePng

  // ── géométrie de la pile (occupation 60-70 % du gabarit maître) ──
  // fusion : emblème large centré, lettrage centré par-dessus (croisement pro)
  // pile   : emblème au-dessus, lettrage en dessous
  const layers: OverlayOptions[] = []
  const alphaLayers: OverlayOptions[] = []

  let embleme: { png: Buffer; w: number; h: number; left: number; top: number } | null = null
  if (wantEmbleme) {
    const ratio = Math.min(0.75, Math.max(0.3, recette.embleme?.echelle ?? (recette.disposition === 'fusion' ? 0.6 : 0.42)))
    const targetW = Math.round(S * ratio)
    const resized = await sharp(input.emblemePng).resize(targetW, targetW, { fit: 'inside', withoutEnlargement: false }).png().toBuffer()
    const meta = await sharp(resized).metadata()
    const w = meta.width ?? targetW
    const h = meta.height ?? targetW
    const left = Math.round((S - w) / 2)
    const top =
      recette.disposition === 'pile'
        ? Math.round(S * 0.16)
        : Math.round((S - h) / 2 - (wantLettrage ? S * 0.04 : 0))
    embleme = { png: resized, w, h, left, top }
  }

  let lettrage: { png: Buffer; w: number; h: number; left: number; top: number } | null = null
  if (wantLettrage && recette.lettrage) {
    const targetW = Math.round(S * (recette.disposition === 'pile' ? 0.58 : 0.66))
    const r = await renderLettrageFitted(recette.lettrage, targetW)
    const w = r.width
    const h = r.height
    const left = Math.round((S - w) / 2)
    const top =
      recette.disposition === 'pile'
        ? Math.round(S * 0.16) + (embleme?.h ?? Math.round(S * 0.3)) + Math.round(S * 0.03)
        : embleme
          ? Math.round(embleme.top + embleme.h * 0.62)
          : Math.round((S - h) / 2)
    lettrage = { png: r.png, w, h, left: Math.max(0, left), top: Math.min(top, S - h - 8) }
  }

  // ── le fond + harmonisation ──
  if (input.fondPng) {
    layers.push({ input: await sharp(input.fondPng).resize(S, S, { fit: 'cover' }).png().toBuffer(), left: 0, top: 0 })
    // glow de contact : la silhouette de la pile, blanche, floue, discrète
    const silhouettes: OverlayOptions[] = []
    if (embleme) silhouettes.push({ input: embleme.png, left: embleme.left, top: embleme.top })
    if (lettrage) silhouettes.push({ input: lettrage.png, left: lettrage.left, top: lettrage.top })
    if (silhouettes.length) {
      const stackAlpha = await sharp({ create: { width: S, height: S, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite(silhouettes)
        .png()
        .toBuffer()
      layers.push({ input: await tintedSilhouette(stackAlpha, { r: 255, g: 255, b: 255 }, 0.14, Math.max(6, S / 90)) })
    }
  }

  if (embleme) {
    layers.push({ input: embleme.png, left: embleme.left, top: embleme.top })
    alphaLayers.push({ input: embleme.png, left: embleme.left, top: embleme.top })
  }
  if (lettrage) {
    layers.push({ input: lettrage.png, left: lettrage.left, top: lettrage.top })
    alphaLayers.push({ input: lettrage.png, left: lettrage.left, top: lettrage.top })
  }

  // grain global léger (voile unifiant)
  layers.push({ input: grainOverlay(S, S), raw: { width: S, height: S, channels: 4 }, blend: 'overlay' })

  const master = await sharp({
    create: { width: S, height: S, channels: 4, background: input.fondPng ? '#0b0e14' : { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(layers)
    .png()
    .toBuffer()

  const alpha = await sharp({ create: { width: S, height: S, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(alphaLayers.length ? alphaLayers : layers)
    .png()
    .toBuffer()

  return { master, alpha, width: S, height: S }
}

// Déclinaison monochrome : RGB recoloré, alpha conservé (doctrine cutout.ts).
export async function declineMonochrome(alphaPng: Buffer, couleur: 'white' | 'black'): Promise<Buffer> {
  const v = couleur === 'white' ? 255 : 0
  const { data, info } = await sharp(alphaPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  for (let p = 0; p < info.width * info.height; p++) {
    data[p * 4] = v
    data[p * 4 + 1] = v
    data[p * 4 + 2] = v
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer()
}
