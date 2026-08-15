// ── Le compilateur de prompts (run 5, LOT 3) ─────────────────────────────────
// L'utilisateur ne voit JAMAIS un prompt. À chaque génération, on assemble :
//   prompt système du secteur
//   + guide de style de la catégorie (issu de l'entraînement, versionné)
//   + DA du projet (nom, ambiance, chips, palette)
//   + réponses du wizard
//   + template de scène paramétré (dérivé du .txt du client)
//   + règle absolue no-text en dernière position (poids maximal)
// Les images de référence (rendus précédents) voyagent à côté du prompt.

import { SECTORS } from './sectors'
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

export const NO_TEXT_RULE =
  'ABSOLUTE FINAL RULE — ZERO TEXT: the image must contain no text, no letters, no words, no numbers, no logos, no watermark, no signature, no UI, no HUD, and no signage with readable characters. Every panel, screen or sign stays blank or abstract. All titles and branding are added later as separate real layers.'

export type ProjectLike = {
  name: string
  sector: string
  ambiance: { universe?: string; chips?: string[]; references?: string[] }
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

function guideBlock(category: EngineCategory): string {
  const guide = GUIDE_BY_CATEGORY[category]?.guide ?? {}
  return `STYLE GUIDE (distilled from premium reference training — follow it):\n${JSON.stringify(guide)}`
}

function projectBlock(project: ProjectLike): string {
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

export type SceneAnswers = {
  templateId?: string
  lieu?: string
  personnages?: string
  moment?: string
  props?: string
  ambianceScene?: string
}

export type CompiledPrompt = {
  prompt: string
  aspectRatio: string
  category: EngineCategory
  templateId: string | null
}

// ── Compilation d'un calque scène ────────────────────────────────────────────
export function compileScenePrompt(opts: {
  project: ProjectLike
  category: EngineCategory
  answers: SceneAnswers
}): CompiledPrompt {
  const { project, category, answers } = opts
  const sector = SECTORS.fivem
  const config = CATEGORY_IMAGE_CONFIG[category]

  const template = answers.templateId ? getSceneTemplate(answers.templateId) : null

  const sceneValues: Record<string, string> = {}
  if (answers.lieu) sceneValues.lieu = answers.lieu
  if (answers.props) sceneValues.props = answers.props
  if (answers.moment) sceneValues.eclairage = answers.moment
  if (answers.ambianceScene) sceneValues.ambiance = answers.ambianceScene
  else if (project.ambiance?.universe) sceneValues.ambiance = project.ambiance.universe

  const sceneBlock = template
    ? `SCENE (from a proven template — respect its camera and composition demands):\n${renderTemplate(template, sceneValues)}`
    : [
        `SCENE:`,
        answers.lieu ? `Location: ${answers.lieu}.` : 'Location: a fitting Los Santos environment for this project.',
        answers.personnages ? `Characters: ${answers.personnages}.` : 'No people unless the mood requires one silhouetted figure.',
        answers.moment ? `Time and light: ${answers.moment}.` : '',
        answers.props ? `Key props: ${answers.props}.` : '',
        'Composition: one dominant focal point, generous negative space kept clean for later title and logo layers.',
      ].filter(Boolean).join('\n')

  const formatBlock = `FORMAT: compose for a ${config.aspectRatio} frame. Keep the key subject inside the central safe zone; edges may be cropped.`

  const prompt = [
    sector.systemPrompt,
    guideBlock(category),
    projectBlock(project),
    sceneBlock,
    formatBlock,
    NO_TEXT_RULE,
  ].join('\n\n')

  return { prompt, aspectRatio: config.aspectRatio, category, templateId: template?.id ?? null }
}

// ── Compilation du logo ──────────────────────────────────────────────────────
export type LogoAnswers = {
  type: 'lettre' | 'nom' | 'embleme'
  style: 'chrome' | 'graffiti' | 'luxe' | 'neon' | 'cartoon' | 'minimal'
  palette: string[]
}

const LOGO_STYLE_PROMPTS: Record<LogoAnswers['style'], string> = {
  chrome: 'liquid chrome / polished metal lettering style, hard specular highlights, beveled edges, slight top-down gradient, subtle dark outline for separation',
  graffiti: 'bold graffiti / urban sticker style, thick clean outlines, aggressive dynamic shapes, spray-paint energy kept crisp (no drips over the letterforms)',
  luxe: 'luxury monogram style, thin elegant strokes with strong contrast, gold-foil or metallic accent, refined serif or geometric details, generous spacing',
  neon: 'neon sign style, glowing tube outlines with realistic falloff, dark backing shapes for readability, one or two neon hues maximum',
  cartoon: 'bold cartoon mascot style, thick outlines, exaggerated 3D depth, vibrant cel shading, playful but professional finish',
  minimal: 'minimal flat vector style, geometric construction, perfect optical balance, one accent color maximum, no gradients, no texture',
}

function averageLuminance(palette: string[]): number {
  if (!palette.length) return 0
  const values = palette.map((hex) => {
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return 0.299 * r + 0.587 * g + 0.114 * b
  })
  return values.reduce((a, b) => a + b, 0) / values.length
}

export function logoBackgroundHex(palette: string[]): '#FFFFFF' | '#000000' {
  // Palette sombre → logo sombre → fond blanc pur (et inversement) :
  // le détourage par flood-fill exige un fond que le logo ne touche pas.
  return averageLuminance(palette) < 150 ? '#FFFFFF' : '#000000'
}

export function compileLogoPrompt(opts: {
  project: ProjectLike
  answers: LogoAnswers
}): CompiledPrompt & { background: '#FFFFFF' | '#000000' } {
  const { project, answers } = opts
  const background = logoBackgroundHex(answers.palette)

  let letteringRule: string
  if (answers.type === 'embleme') {
    letteringRule =
      'Type: pure EMBLEM — a symbol only. STRICTLY NO letters, no words, no monogram, no characters of any alphabet anywhere.'
  } else if (answers.type === 'lettre') {
    const letter = (project.name.trim()[0] ?? 'N').toUpperCase()
    letteringRule = `Type: single-letter monogram. The ONLY character allowed in the whole image is the capital letter "${letter}". Render it once, perfectly drawn. No other letters, no words.`
  } else {
    const name = project.name.trim().toUpperCase()
    const spelled = name.split('').join('-')
    letteringRule = `Type: full wordmark. The ONLY text allowed is the server name "${name}" — exact spelling, letter by letter: ${spelled}. Double-check every letter; no missing, doubled or invented characters. No other text anywhere.`
  }

  const paletteLine = answers.palette.length
    ? `Colors: strictly use this palette — ${answers.palette.join(', ')}. No colors outside it (plus neutral shading).`
    : ''

  const prompt = [
    `Premium esports/FiveM server logo, presented as a clean centered mark.`,
    guideBlock('logo'),
    projectBlock(project),
    letteringRule,
    `Style: ${LOGO_STYLE_PROMPTS[answers.style]}.`,
    paletteLine,
    `BACKGROUND — CRITICAL FOR CUTOUT: perfectly flat, uniform, seamless ${background === '#FFFFFF' ? 'pure white (#FFFFFF)' : 'pure black (#000000)'} background. No gradient, no vignette, no texture, no shadow cast on the background, no reflection under the logo. The logo must not touch the frame edges — keep 12% padding on all sides.`,
    `Square 1:1 composition, logo perfectly centered, professional vector-grade edges.`,
    answers.type === 'embleme' ? NO_TEXT_RULE : 'No text other than specified above. No watermark, no signature, no UI.',
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
