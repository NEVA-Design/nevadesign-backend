// ── Le compilateur de prompts (run 5.2, LOT 1/3/4) ───────────────────────────
// L'utilisateur ne voit JAMAIS un prompt. Depuis le run 5.2, le compilateur
// est few-shot : chaque génération embarque 1-2 reverse-prompts exemplaires de
// sa catégorie (gabarits de recette extraits des références d'entraînement,
// elles-mêmes générées par IA) + 2-3 images de référence jointes à l'appel.
// On ne décrit plus un style — on clone la recette d'images qui marchent.
//
// Règle absolue du run 5.2 : le lettrage (titre de bannière, logo) est GÉNÉRÉ
// DANS l'image, épellation forcée + OCR gate en aval. Le negative « no text »
// ne survit que sur les calques secondaires (fonds, ambiance) — jamais sur le
// héro ni le logo.

import { SECTORS } from './sectors'
import { pickExemplars } from './exemplars'
import { adnBlockLogo } from './adn'
import type { ArtDirection, LogoConstruction } from './mapping'
import guideAffiche from '../../engine/styles/fivem/affiche.json'
import guideBackgroundLogo from '../../engine/styles/fivem/background_logo.json'
import guideBanniereDiscord from '../../engine/styles/fivem/banniere_discord.json'
import guideBanniereFivem from '../../engine/styles/fivem/banniere_fivem.json'
import guideBanniereF5 from '../../engine/styles/fivem/banniere_f5.json'
import guidePersonnage from '../../engine/styles/fivem/personnage.json'
import guideDaComplete from '../../engine/styles/fivem/da_complete.json'
import guideIcon from '../../engine/styles/fivem/icon.json'
import guideLogo from '../../engine/styles/fivem/logo.json'
import sceneTemplates from '../../engine/templates/fivem/scenes.json'

export type EngineCategory =
  | 'logo'
  | 'banniere_discord'
  | 'banniere_fivem'
  | 'banniere_f5'
  | 'affiche'
  | 'wallpaper'
  | 'loading_screen'
  | 'icon'
  | 'libre'

type StyleGuide = { guide: Record<string, unknown> }

// wallpaper/loading_screen/libre n'ont pas de dossier d'entraînement dédié :
// on les adosse aux guides les plus proches.
const GUIDE_BY_CATEGORY: Record<EngineCategory, StyleGuide> = {
  logo: guideLogo,
  banniere_discord: guideBanniereDiscord,
  banniere_fivem: guideBanniereFivem,
  banniere_f5: guideBanniereF5,
  affiche: guideAffiche,
  wallpaper: guideAffiche,
  loading_screen: guideBanniereF5,
  icon: guideIcon,
  libre: guideAffiche,
}

// Même adossement pour les exemplaires (dossiers de train-fivem-v2.ts).
const EXEMPLAR_CATEGORY: Record<EngineCategory, string> = {
  logo: 'logo',
  banniere_discord: 'banniere_discord',
  banniere_fivem: 'banniere_fivem',
  banniere_f5: 'banniere_f5',
  affiche: 'affiche',
  wallpaper: 'affiche',
  loading_screen: 'banniere_f5',
  icon: 'icon',
  libre: 'affiche',
}

export const CHARACTER_GUIDE = guidePersonnage
export const DA_COHERENCE_GUIDE = guideDaComplete
export const BACKGROUND_LOGO_GUIDE = guideBackgroundLogo

// Ratio et résolution natifs demandés au modèle par catégorie. Les bandeaux
// extrêmes (17:1) sont générés en 21:9 (le plus large supporté) puis
// recadrés en bande au compositing.
export const CATEGORY_IMAGE_CONFIG: Record<EngineCategory, { aspectRatio: string; canvas: { width: number; height: number } }> = {
  logo: { aspectRatio: '1:1', canvas: { width: 4096, height: 4096 } },
  banniere_discord: { aspectRatio: '16:9', canvas: { width: 1920, height: 1080 } },
  banniere_fivem: { aspectRatio: '21:9', canvas: { width: 3730, height: 216 } },
  banniere_f5: { aspectRatio: '16:9', canvas: { width: 1920, height: 1080 } },
  affiche: { aspectRatio: '3:4', canvas: { width: 1080, height: 1350 } },
  wallpaper: { aspectRatio: '16:9', canvas: { width: 3840, height: 2160 } },
  loading_screen: { aspectRatio: '16:9', canvas: { width: 1920, height: 1080 } },
  icon: { aspectRatio: '1:1', canvas: { width: 512, height: 512 } },
  libre: { aspectRatio: '16:9', canvas: { width: 1920, height: 1080 } },
}

// Négatif texte — RÉSERVÉ aux calques secondaires (fonds destinés à recevoir
// le logo, ambiances) et aux chemins legacy de l'A/B. Jamais héro, jamais logo.
export const SECONDARY_NO_TEXT_RULE =
  'ABSOLUTE FINAL RULE — ZERO TEXT: the image must contain no text, no letters, no words, no numbers, no logos, no watermark, no signature, no UI, no HUD, and no signage with readable characters. Every panel, screen or sign stays blank or abstract. All titles and branding are added later as separate real layers.'

export type ProjectLike = {
  name: string
  sector: string
  ambiance: { universe?: string; chips?: string[]; references?: string[]; styleAnswers?: unknown }
  palette: string[]
}

export type SceneTemplate = {
  id: string
  titre: string
  scene_type: string
  personnages: number
  template: string
  defaults: Record<string, string>
}

export function listSceneTemplates(): SceneTemplate[] {
  return (sceneTemplates as unknown as { templates: SceneTemplate[] }).templates
}

export function getSceneTemplate(id: string): SceneTemplate | null {
  return listSceneTemplates().find((t) => t.id === id) ?? null
}

// ── Briques communes ─────────────────────────────────────────────────────────

// Épellation forcée : « L6RYS » → « L-6-R-Y-S ». C'est la parade centrale aux
// fautes d'orthographe : le modèle lit chaque caractère séparément.
export function spellOut(text: string): string {
  return text.trim().toUpperCase().split('').filter((c) => c !== ' ').join('-')
}

// 3-5 lignes ciblées du guide v2 — plus de JSON.stringify d'un bloc : on cite
// les règles qui pèsent sur la génération (composition, typo générée, effets).
function guideLines(category: EngineCategory, keys: string[], max = 5): string {
  const guide = GUIDE_BY_CATEGORY[category]?.guide as Record<string, unknown> | undefined
  if (!guide) return ''
  const lines: string[] = []
  for (const key of keys) {
    const value = guide[key]
    if (Array.isArray(value)) lines.push(...value.filter((v): v is string => typeof v === 'string'))
  }
  if (!lines.length) return ''
  return `STYLE RULES (distilled from premium reference training):\n${lines.slice(0, max).map((l) => `- ${l}`).join('\n')}`
}

function fewShotBlock(reversePrompts: string[]): string {
  if (!reversePrompts.length) return ''
  return [
    'PROVEN RECIPES — these prompts produced reference-grade images of this exact category. Clone their structure, density and finish quality; substitute the subject, title and grading with the brief below:',
    ...reversePrompts.map((p, i) => `RECIPE ${i + 1}: ${p}`),
  ].join('\n')
}

function referencesBlock(referenceCount: number, purpose: string): string {
  if (!referenceCount) return ''
  return `ATTACHED REFERENCES: ${referenceCount} reference image${referenceCount > 1 ? 's' : ''} from our curated training set are attached. ${purpose} Do not copy their subjects or names — match their LEVEL.`
}

// Bloc DA projet v2 — le nom du serveur est destiné à être RENDU (héro/logo).
function artDirectionBlock(project: ProjectLike, da: ArtDirection): string {
  return [
    'PROJECT ART DIRECTION (every asset of this project must feel like one family):',
    `- Materials and finishes: ${da.matieres}.`,
    `- Lighting character: ${da.lumiere}.`,
    `- Color grading: ${da.etalonnage}.`,
    `- Palette: dominant ${da.palette[0]}${da.palette.length > 1 ? `, accents ${da.palette.slice(1).join(', ')}` : ''}.`,
  ].join('\n')
}

export type CompiledPrompt = {
  prompt: string
  aspectRatio: string
  category: EngineCategory
  templateId: string | null
}

export type CompiledPromptV2 = CompiledPrompt & {
  // images de référence d'entraînement à joindre à l'appel
  references: Array<{ data: string; mimeType: string }>
  // slugs des exemplaires utilisés (traçabilité compiled_prompts)
  exemplarSlugs: string[]
  // textes attendus à l'écran — l'OCR gate valide chacun
  expectedTexts: string[]
}

// ── HÉRO v2 : scène + titre en UNE génération (run 5.2, LOT 4) ───────────────

export type SceneAnswers = {
  templateId?: string
  lieu?: string
  personnages?: string
  moment?: string
  props?: string
  ambianceScene?: string
  // baseline optionnelle sous le titre (épelée + OCR comme le titre)
  baseline?: string
  // option pré-câblée : intégrer le logo master à la génération (réf. jointe)
  logoInScene?: boolean
}

function renderTemplate(template: SceneTemplate, values: Record<string, string>): string {
  let text = template.template
  const merged = { ...template.defaults, ...values }
  for (const [key, value] of Object.entries(merged)) {
    if (!value) continue
    text = text.replaceAll(`{${key}}`, value)
  }
  // placeholders restants → defaults absents : on nettoie proprement
  text = text.replace(/\{[a-z_]+\}/g, '')
  return text
}

function sceneBlock(project: ProjectLike, answers: SceneAnswers, template: SceneTemplate | null): string {
  const sceneValues: Record<string, string> = {}
  if (answers.lieu) sceneValues.lieu = answers.lieu
  if (answers.props) sceneValues.props = answers.props
  if (answers.moment) sceneValues.eclairage = answers.moment
  if (answers.ambianceScene) sceneValues.ambiance = answers.ambianceScene
  else if (project.ambiance?.universe) sceneValues.ambiance = project.ambiance.universe

  if (template) {
    return `SCENE (from a proven template — respect its camera and composition demands):\n${renderTemplate(template, sceneValues)}`
  }
  return [
    'SCENE:',
    answers.lieu ? `Location: ${answers.lieu}.` : 'Location: a fitting Los Santos environment for this project.',
    answers.personnages ? `Characters: ${answers.personnages}.` : 'No people unless the mood requires one silhouetted figure.',
    answers.moment ? `Time and light: ${answers.moment}.` : '',
    answers.props ? `Key props: ${answers.props}.` : '',
  ].filter(Boolean).join('\n')
}

// Le calque héro : scène ET titre générés ensemble, lettrage entrelacé avec
// les sujets. C'est la réponse au cas « REDSIDE » : plus jamais une photo
// avec un texte plat posé dessus.
export function compileHeroPromptV2(opts: {
  project: ProjectLike
  category: Exclude<EngineCategory, 'logo'>
  da: ArtDirection
  answers: SceneAnswers
  energie?: number
  modernite?: number
}): CompiledPromptV2 {
  const { project, category, da, answers } = opts
  const sector = SECTORS.fivem
  const config = CATEGORY_IMAGE_CONFIG[category]
  const template = answers.templateId ? getSceneTemplate(answers.templateId) : null

  const name = project.name.trim().toUpperCase()
  const baseline = (answers.baseline ?? '').trim().toUpperCase()
  // l'icône (512 px) est un mini-mark sans titre — seule catégorie héro muette
  const withTitle = category !== 'icon'

  const exemplars = pickExemplars({
    category: EXEMPLAR_CATEGORY[category],
    da,
    energie: opts.energie,
    modernite: opts.modernite,
  })

  const titleBlock = withTitle
    ? [
        `TITLE — GENERATED INSIDE THE IMAGE: massive display title reading exactly "${name}" — spelled ${spellOut(name)} — ${da.lettering}, letters partially BEHIND the subjects with some strokes in front (depth interleaving), integrated lighting and reflections, correct spelling only, no other words, no watermark.`,
        baseline
          ? `Below the title, a small tracked-out baseline reading exactly "${baseline}" — spelled ${spellOut(baseline)} — clean secondary type, perfectly spelled.`
          : '',
        'Triple-check every letter of the title: no missing, doubled, swapped or invented characters.',
      ].filter(Boolean).join('\n')
    : ''

  const strip = category === 'banniere_fivem'
  const formatBlock = strip
    ? `FORMAT: compose for a ${config.aspectRatio} frame that will be CROPPED to an ultra-wide horizontal strip. The full title and every key subject must sit inside the CENTRAL HORIZONTAL BAND (middle third of the height); top and bottom thirds are pure environment.`
    : `FORMAT: compose for a ${config.aspectRatio} frame. Keep the title and key subject inside the central safe zone; edges may be cropped.`

  const logoOption = answers.logoInScene
    ? 'LOGO INTEGRATION: the FIRST attached image is the server logo (transparent PNG). Integrate it naturally into the scene as a physical element (billboard, neon sign, embroidery, decal) — never as a flat overlay. Keep it sharp and unmodified in design.'
    : ''

  const prompt = [
    sector.systemPrompt,
    fewShotBlock(exemplars.reversePrompts),
    guideLines(category, ['composition', 'typographie', 'effets'], 5),
    artDirectionBlock(project, da),
    sceneBlock(project, answers, template),
    titleBlock,
    logoOption,
    referencesBlock(exemplars.references.length, 'They define the quality bar, typography integration and finishing level to reach.'),
    formatBlock,
  ].filter(Boolean).join('\n\n')

  const expectedTexts = withTitle ? [name] : []
  if (withTitle && baseline) expectedTexts.push(baseline)

  return {
    prompt,
    aspectRatio: config.aspectRatio,
    category,
    templateId: template?.id ?? null,
    references: exemplars.references,
    exemplarSlugs: exemplars.slugs,
    expectedTexts,
  }
}

// ── LOGO v2 (run 5.2, LOT 3) ─────────────────────────────────────────────────

export type LogoAnswersV2 = {
  type: 'lettre' | 'nom' | 'embleme'
}

// Fond d'atelier imposé par le run 5.2 : gris neutre clair, jamais pur, pour
// un détourage flood-fill fiable quel que soit le logo (même blanc ou noir).
export const LOGO_BACKGROUND_HEX = '#F2F2F2'

const CONSTRUCTION_PROMPTS: Record<LogoConstruction, string> = {
  embleme_lettre:
    'Construction: lettered emblem — the initial letter fused inside a strong emblem shape (shield, crest, geometric badge), letter and symbol reading as ONE mark.',
  lettrage_silhouette:
    'Construction: the full lettering fused INTO a recognizable silhouette or scene element — strokes flowing through the shape, negative space doing real work.',
  esport_italique:
    'Construction: esports-style italic wordmark — forward-leaning custom letterforms, sharp spurs and cuts, tight interlocking, built for jerseys and banners.',
  badge:
    'Construction: self-contained badge — a balanced enclosed composition with a strong central symbol, clean contour, reading perfectly at small sizes.',
}

export function compileLogoPromptV2(opts: {
  project: ProjectLike
  da: ArtDirection
  answers: LogoAnswersV2
  energie?: number
  modernite?: number
}): CompiledPromptV2 & { background: string } {
  const { project, da, answers } = opts
  const name = project.name.trim().toUpperCase()

  const exemplars = pickExemplars({
    category: 'logo',
    da,
    energie: opts.energie,
    modernite: opts.modernite,
  })

  let letteringRule: string
  let construction: LogoConstruction
  const expectedTexts: string[] = []
  if (answers.type === 'embleme') {
    construction = da.logoConstruction.embleme
    letteringRule = 'Type: pure pictorial emblem — a symbol only, zero lettering, zero characters of any alphabet.'
  } else if (answers.type === 'lettre') {
    construction = da.logoConstruction.lettre
    const letter = (name[0] ?? 'N').toUpperCase()
    letteringRule = `Type: single-letter monogram built around the exact letter "${letter}", custom lettering, drawn once, no other words.`
    expectedTexts.push(letter)
  } else {
    construction = da.logoConstruction.nom
    letteringRule = `Type: full wordmark of the exact word "${name}", spelled ${spellOut(name)}, custom lettering, no other words. Triple-check every letter: no missing, doubled, swapped or invented characters.`
    expectedTexts.push(name)
  }

  const prompt = [
    'Premium FiveM/GTA RP server logo, presented as one clean centered mark.',
    fewShotBlock(exemplars.reversePrompts),
    guideLines('logo', ['composition', 'effets', 'interdits'], 5),
    letteringRule,
    CONSTRUCTION_PROMPTS[construction],
    `Lettering treatment: ${da.lettering}.`,
    `Materials: ${da.matieres}. Grading: ${da.etalonnage}.`,
    `Colors: strictly this palette — ${da.palette.join(', ')} — plus neutral shading. Every stroke keeps a crisp contrasted edge against the background.`,
    referencesBlock(exemplars.references.length, 'They define the construction quality, edge crispness and finishing level to reach.'),
    `BACKGROUND — CRITICAL FOR CUTOUT: perfectly flat, uniform, seamless light grey ${LOGO_BACKGROUND_HEX} background. No gradient, no vignette, no texture, no shadow on the background, no reflection under the logo. The mark must not touch the frame edges — keep 12% padding on all sides.`,
    'Square 1:1 composition, mark perfectly centered, professional vector-grade edges.',
  ].filter(Boolean).join('\n\n')

  return {
    prompt,
    aspectRatio: '1:1',
    category: 'logo',
    templateId: null,
    references: exemplars.references,
    exemplarSlugs: exemplars.slugs,
    expectedTexts,
    background: LOGO_BACKGROUND_HEX,
  }
}

// ── LOGO v3 : habillage technique du prompt de concept (run 5.3, LOT 1) ──────
// Le prompt créatif vient du directeur artistique (étage 1). Ici on ne
// touche PAS à l'intention — on ajoute les contraintes machine : épellation
// forcée + OCR, fond d'atelier quand le livrable est un PNG détouré, format.

export type LogoConceptCompiled = {
  prompt: string
  expectedTexts: string[]
  background: string | null
}

export function compileLogoConceptPrompt(opts: {
  projectName: string
  conceptPrompt: string
  type: 'lettre' | 'nom' | 'embleme'
  fond: 'transparent' | 'plein' | 'degrade_motifs'
}): LogoConceptCompiled {
  const name = opts.projectName.trim().toUpperCase()
  const expectedTexts: string[] = []
  let spellingBlock = ''
  if (opts.type === 'nom') {
    spellingBlock = `SPELLING — NON NEGOTIABLE: the wordmark reads exactly "${name}", spelled ${spellOut(name)}. Triple-check every letter: no missing, doubled, swapped or invented characters. No other words anywhere.`
    expectedTexts.push(name)
  } else if (opts.type === 'lettre') {
    const letter = (name[0] ?? 'N').toUpperCase()
    spellingBlock = `SPELLING — NON NEGOTIABLE: the ONLY character in the mark is the capital letter "${letter}", drawn once. No other letters, no words.`
    expectedTexts.push(letter)
  } else {
    spellingBlock = 'NO LETTERING: pure pictorial emblem — zero characters of any alphabet anywhere.'
  }

  // Fond transparent = livrable PNG détouré → atelier gris neutre imposé.
  // Fond plein / dégradé+motifs : le fond fait partie du logo, décrit par le
  // concept — on n'impose que la propreté des bords.
  const background = opts.fond === 'transparent' ? LOGO_BACKGROUND_HEX : null
  const backgroundBlock = background
    ? `BACKGROUND — CRITICAL FOR CUTOUT: perfectly flat, uniform, seamless light grey ${background} background. No gradient, no vignette, no texture, no shadow on the background, no reflection under the logo.`
    : 'BACKGROUND: full-bleed as described in the concept above — it IS part of the logo. Edge-to-edge clean rendering, no vignette added on top.'

  // LOT 3 (run 5.4) : le bloc ADN chiffré voyage dans CHAQUE génération logo.
  // Le concept du DA le porte déjà en section 0 — la garantie dure est ICI :
  // adnBlockLogo() JETTE si l'entraînement v4 n'est pas installé, donc aucun
  // appel logo ne part jamais sans ADN.
  const prompt = [
    opts.conceptPrompt.trim(),
    `DNA GUARANTEE — the final render must sit inside this measured family:\n${adnBlockLogo()}`,
    spellingBlock,
    backgroundBlock,
    `Square 1:1 composition, mark perfectly centered, professional vector-grade edges${background ? ', the mark must not touch the frame edges — keep 12% padding on all sides' : ''}. No watermark, no signature, no UI.`,
  ].join('\n\n')

  return { prompt, expectedTexts, background }
}

// ── Retouche d'un calque héro par instruction courte (run 5.2, LOT 4) ────────
// « passe le titre en chrome », « scène de nuit », « retire le personnage de
// gauche » — le rendu actuel voyage en référence, l'épellation est re-forcée.
export function compileInstructPrompt(opts: {
  project: ProjectLike
  instruction: string
  expectedTexts: string[]
}): { prompt: string; expectedTexts: string[] } {
  const [title, baseline] = opts.expectedTexts
  const prompt = [
    'EDIT THE ATTACHED IMAGE: the attached reference is the current approved render. Apply ONLY the change described below — keep everything else identical (composition, camera, subjects, grading).',
    `CHANGE REQUESTED: ${opts.instruction}`,
    title
      ? `The title must still read exactly "${title}" — spelled ${spellOut(title)} — perfectly spelled, no other words added.${baseline ? ` The baseline must still read exactly "${baseline}" — spelled ${spellOut(baseline)}.` : ''}`
      : '',
    'No watermark, no signature.',
  ].filter(Boolean).join('\n\n')
  return { prompt, expectedTexts: opts.expectedTexts }
}

// ── Calques secondaires (fonds, ambiances) — le SEUL chemin où le négatif
// texte est légitime : ces calques reçoivent le logo/master par compositing.
export function compileSecondaryLayerPrompt(opts: {
  project: ProjectLike
  da: ArtDirection
  description: string
  aspectRatio: string
}): CompiledPrompt {
  const sector = SECTORS.fivem
  const prompt = [
    sector.systemPrompt,
    artDirectionBlock(opts.project, opts.da),
    `SECONDARY LAYER: ${opts.description}. This layer sits UNDER real branding layers composed later.`,
    SECONDARY_NO_TEXT_RULE,
  ].join('\n\n')
  return { prompt, aspectRatio: opts.aspectRatio, category: 'libre', templateId: null }
}

// ═════════════════════════════════════════════════════════════════════════════
// LEGACY v1 — conservé UNIQUEMENT pour les cas A/B de /admin/test-moteur
// (LOT 5 : « ancien chemin vs v2 », mêmes réponses de wizard). Aucune route
// produit ne passe plus par ici. À supprimer quand l'A/B aura tranché.
// ═════════════════════════════════════════════════════════════════════════════

// Ligne no-text que le systemPrompt secteur portait au run 5 — réinjectée ici
// pour que l'A/B compare le vrai pipeline v1, à l'identique.
const LEGACY_SECTOR_NO_TEXT_LINE =
  '- ABSOLUTELY NO TEXT of any kind in the image: no letters, no words, no numbers, no logos, no watermarks, no signage with readable characters, no UI, no HUD. Any panel or sign must be blank or abstract.'

function legacyGuideBlock(category: EngineCategory): string {
  const guide = GUIDE_BY_CATEGORY[category]?.guide ?? {}
  return `STYLE GUIDE (distilled from premium reference training — follow it):\n${JSON.stringify(guide)}`
}

function legacyProjectBlock(project: ProjectLike): string {
  const chips = project.ambiance?.chips ?? []
  const universe = project.ambiance?.universe ?? ''
  const palette = project.palette ?? []
  const lines = [
    `PROJECT ART DIRECTION (every asset of this project must feel like one family):`,
    `- Server name: "${project.name}" — CONTEXT ONLY, never render this name or any text in the image.`,
  ]
  if (universe) lines.push(`- Universe: ${universe}`)
  if (chips.length) lines.push(`- Mood keywords: ${chips.join(', ')}`)
  if (palette.length) {
    lines.push(`- Color palette: dominant ${palette[0]}, accents ${palette.slice(1).join(', ')} — grade the scene toward this palette.`)
  }
  return lines.join('\n')
}

export function compileScenePromptLegacy(opts: {
  project: ProjectLike
  category: EngineCategory
  answers: SceneAnswers
}): CompiledPrompt {
  const { project, category, answers } = opts
  const sector = SECTORS.fivem
  const config = CATEGORY_IMAGE_CONFIG[category]
  const template = answers.templateId ? getSceneTemplate(answers.templateId) : null

  const block = template
    ? sceneBlock(project, answers, template)
    : [
        sceneBlock(project, answers, null),
        'Composition: one dominant focal point, generous negative space kept clean for later title and logo layers.',
      ].join('\n')

  const formatBlock = `FORMAT: compose for a ${config.aspectRatio} frame. Keep the key subject inside the central safe zone; edges may be cropped.`

  const prompt = [
    `${sector.systemPrompt}\n${LEGACY_SECTOR_NO_TEXT_LINE}`,
    legacyGuideBlock(category),
    legacyProjectBlock(project),
    block,
    formatBlock,
    SECONDARY_NO_TEXT_RULE,
  ].join('\n\n')

  return { prompt, aspectRatio: config.aspectRatio, category, templateId: template?.id ?? null }
}

export type LegacyLogoAnswers = {
  type: 'lettre' | 'nom' | 'embleme'
  style: 'chrome' | 'graffiti' | 'luxe' | 'neon' | 'cartoon' | 'minimal'
  palette: string[]
}

const LEGACY_LOGO_STYLE_PROMPTS: Record<LegacyLogoAnswers['style'], string> = {
  chrome: 'liquid chrome / polished metal lettering style, hard specular highlights, beveled edges, slight top-down gradient, subtle dark outline for separation',
  graffiti: 'bold graffiti / urban sticker style, thick clean outlines, aggressive dynamic shapes, spray-paint energy kept crisp (no drips over the letterforms)',
  luxe: 'luxury monogram style, thin elegant strokes with strong contrast, gold-foil or metallic accent, refined serif or geometric details, generous spacing',
  neon: 'neon sign style, glowing tube outlines with realistic falloff, dark backing shapes for readability, one or two neon hues maximum',
  cartoon: 'bold cartoon mascot style, thick outlines, exaggerated 3D depth, vibrant cel shading, playful but professional finish',
  minimal: 'minimal flat vector style, geometric construction, perfect optical balance, one accent color maximum, no gradients, no texture',
}

function legacyAverageLuminance(palette: string[]): number {
  if (!palette.length) return 0
  const values = palette.map((hex) => {
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return 0.299 * r + 0.587 * g + 0.114 * b
  })
  return values.reduce((a, b) => a + b, 0) / values.length
}

export function compileLogoPromptLegacy(opts: {
  project: ProjectLike
  answers: LegacyLogoAnswers
}): CompiledPrompt & { background: '#FFFFFF' | '#000000' } {
  const { project, answers } = opts
  const background = legacyAverageLuminance(answers.palette) < 150 ? '#FFFFFF' : '#000000'

  let letteringRule: string
  if (answers.type === 'embleme') {
    letteringRule =
      'Type: pure EMBLEM — a symbol only. STRICTLY NO letters, no words, no monogram, no characters of any alphabet anywhere.'
  } else if (answers.type === 'lettre') {
    const letter = (project.name.trim()[0] ?? 'N').toUpperCase()
    letteringRule = `Type: single-letter monogram. The ONLY character allowed in the whole image is the capital letter "${letter}". Render it once, perfectly drawn. No other letters, no words.`
  } else {
    const name = project.name.trim().toUpperCase()
    letteringRule = `Type: full wordmark. The ONLY text allowed is the server name "${name}" — exact spelling, letter by letter: ${spellOut(name)}. Double-check every letter; no missing, doubled or invented characters. No other text anywhere.`
  }

  const paletteLine = answers.palette.length
    ? `Colors: strictly use this palette — ${answers.palette.join(', ')}. No colors outside it (plus neutral shading).`
    : ''

  const prompt = [
    `Premium esports/FiveM server logo, presented as a clean centered mark.`,
    legacyGuideBlock('logo'),
    legacyProjectBlock(project),
    letteringRule,
    `Style: ${LEGACY_LOGO_STYLE_PROMPTS[answers.style]}.`,
    paletteLine,
    `BACKGROUND — CRITICAL FOR CUTOUT: perfectly flat, uniform, seamless ${background === '#FFFFFF' ? 'pure white (#FFFFFF)' : 'pure black (#000000)'} background. No gradient, no vignette, no texture, no shadow cast on the background, no reflection under the logo. The logo must not touch the frame edges — keep 12% padding on all sides.`,
    `Square 1:1 composition, logo perfectly centered, professional vector-grade edges.`,
    answers.type === 'embleme' ? SECONDARY_NO_TEXT_RULE : 'No text other than specified above. No watermark, no signature, no UI.',
  ].filter(Boolean).join('\n\n')

  return { prompt, aspectRatio: '1:1', category: 'logo', templateId: null, background }
}

// ── Reformulation adoucie (gestion des refus) ────────────────────────────────
// Sur refus safety du modèle : UNE seule reformulation automatique, loggée.
const SOFTEN_RULES: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\b(assault rifles?|rifles?|firearms?|guns?|weapons?|pistols?|glocks?|ak-?47s?|uzis?)\b/gi, replacement: 'holstered prop (never aimed, never fired)' },
  { pattern: /\b(blood|bloody|gore|wounded|corpses?|dead body|dead bodies)\b/gi, replacement: 'dramatic shadows' },
  { pattern: /\b(cocaine|heroin|meth|drugs?|narcotics?|weed|cannabis)\b/gi, replacement: 'unmarked packages' },
  { pattern: /\b(cartel|gang|mafia|mob)\b/gi, replacement: 'crew' },
  { pattern: /\b(hostage|kidnapping|torture)\b/gi, replacement: 'tense negotiation (no violence shown)' },
  { pattern: /\b(robbery|heist|stickup)\b/gi, replacement: 'meticulous planning scene' },
  { pattern: /\b(shooting|shootout|gunfight|firefight)\b/gi, replacement: 'tense standoff, weapons lowered' },
  { pattern: /\b(prison fight|riot)\b/gi, replacement: 'tense crowd scene' },
]

export function softenPrompt(prompt: string): { softened: string; replacements: string[] } {
  let softened = prompt
  const replacements: string[] = []
  for (const rule of SOFTEN_RULES) {
    if (rule.pattern.test(softened)) {
      replacements.push(`${rule.pattern.source} → ${rule.replacement}`)
      softened = softened.replace(rule.pattern, rule.replacement)
    }
  }
  softened += '\n\nThis is fictional GTA V roleplay promotional artwork. Safe-for-work: no violence depicted, no injuries, nothing illegal shown in use.'
  return { softened, replacements }
}
