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

// Fond d'atelier imposé par le run 5.2 : gris neutre clair, jamais pur, pour
// un détourage flood-fill fiable quel que soit le logo (même blanc ou noir).
// Run 5.7 : ne sert plus qu'au calque EMBLÈME du pipeline superposé.
export const LOGO_BACKGROUND_HEX = '#F2F2F2'

// ═════════════════════════════════════════════════════════════════════════════
// Run 5.7 : compileLogoPromptV2 (monolithique « un logo entier », run 5.2) est
// SUPPRIMÉE — la génération monolithique déclenchait le prior « gaming logo
// 2015 » du modèle quel que soit le prompt. Le pipeline logo passe par les
// calques superposés (logo-stack.ts) : fond seul + emblème seul + lettrage
// typographié local. Voir rapports/run57-arbitrage-lettrage.md.
// ═════════════════════════════════════════════════════════════════════════════

// ── LOGO : habillage technique du prompt de concept (run 5.3 → 5.5) ──────────
// Le prompt créatif vient du directeur artistique (étage 1). Ici on ne
// touche PAS à l'intention — on ajoute les contraintes machine : épellation
// forcée + OCR, présentation, langue de rendu, références, format.
// Run 5.5 (calibration) : l'étape A rend le logo DANS SA PRÉSENTATION
// NATURELLE (fond sombre atmosphérique + glow, comme le corpus : 78 % de
// fonds sombres, 76 % atmosphériques) — générer sur #F2F2F2 clair faisait
// retomber le modèle sur l'icône plate (FiveM-ness 5/10 → 9/10 mesuré,
// captures/calibration/iter0 vs iter4). La version alpha détourée est
// DÉRIVÉE du master validé en seconde passe (/logo/master), jamais rendue ici.

// Run 5.8 (chantier 3) : les blocs H1-H7 du run 5.5/5.6 (PRESENTATION,
// RENDER LANGUAGE, LETTERING INTEGRITY) sont SUPPRIMÉS des prompts image —
// leurs pourcentages de corpus étaient du bruit pour un modèle d'image et
// leurs interdits verbeux plantaient les concepts qu'ils interdisaient (les
// emblèmes sortaient candy-gloss malgré le FORBIDDEN). Leur doctrine survit
// EN POSITIF dans les prompts calques de logo-stack.ts : la material law
// (« satin and matte fills with subtle grain, a single controlled specular
// accent per element ») vit dans FAMILLE_FINISH, la présentation corpus dans
// compileFondCalquePrompt, l'intégrité du lettrage dans compileLockupPrompt.

// H3 (validée iter4 : aveugle 0/3) — les références jointes reçoivent enfin
// leur consigne : copier l'EMPREINTE de production, jamais les sujets.
// Run 5.8 (chantier 2) : les références sont désormais de la MÊME famille de
// rendu que le concept — la consigne vise le transfert de finition et de
// traitement du lettrage, jamais la copie des formes ou des mots.
export const LOGO_REFERENCES_BLOCK =
  'ATTACHED REFERENCES: the attached images are real logos from the target family. Match the finish, the materials and the lettering treatment quality of the attached reference logos, then create a completely new original design with the requested word — do not copy their shapes or their words.'

// Run 5.7 : compileLogoConceptPrompt (exécution monolithique d'un concept —
// le dernier chemin « un logo entier ») est SUPPRIMÉE. Les blocs H1-H7
// ci-dessus restent exportés : les prompts PAR CALQUE de logo-stack.ts les
// réutilisent (présentation → calque fond, langue de rendu → calque emblème).

// ── FONDS de l'étape B (run 5.4, LOT 4) — générés SANS le logo ───────────────
// La bibliothèque de fonds (dossier « background pour logo ect », analysé à
// 100 % par train-fivem-v4) nourrit le few-shot ; le logo n'apparaît JAMAIS
// dans la génération — il est composé par calques ensuite, et chaque calque
// se régénère indépendamment.
export type LogoFondCompiled = CompiledPromptV2

const FOND_CHOIX_PROMPTS: Record<'signature' | 'atmospherique' | 'scene', (sujet: string) => string> = {
  signature: (sujet) =>
    `SIGNATURE BACKGROUND (ALYA family): one full-bleed two-tone gradient decorated with small hand-drawn doodle motifs${sujet ? ` derived from the logo subject "${sujet}" (simplified outlines, 12-20 scattered motifs)` : ' (simple geometric doodles, 12-20 scattered)'} — motifs low-contrast (10-20% opacity shift), evenly scattered, NEVER crowding the center.`,
  atmospherique: () =>
    'ATMOSPHERIC BACKGROUND (fractured-gold-R family): dark dramatic full-bleed backdrop — deep vignette-free gradient, volumetric light haze, floating micro-particles/sparks, subtle smoke wisps. Low brightness, high depth.',
  scene: () =>
    'SCENE BACKGROUND: a soft-focus environmental scene matching the server mood — depth-of-field strong enough that no object stays sharp, graded toward the palette below.',
}

export function compileLogoFondPrompt(opts: {
  da: ArtDirection
  choix: 'signature' | 'atmospherique' | 'scene'
  sujet: string
  couleurs: string[]
  ambianceScene?: string
  energie?: number
  modernite?: number
  adnFondBlock: string
}): LogoFondCompiled {
  const exemplars = pickExemplars({
    category: 'background_logo',
    da: opts.da,
    energie: opts.energie,
    modernite: opts.modernite,
    maxPrompts: 2,
    maxReferences: 2,
  })

  const couleurs = opts.couleurs.length ? opts.couleurs : opts.da.palette
  const prompt = [
    'Premium background designed to HOST a FiveM server logo composed on top later. The logo is NOT in this image.',
    opts.adnFondBlock,
    fewShotBlock(exemplars.reversePrompts),
    FOND_CHOIX_PROMPTS[opts.choix](opts.sujet),
    opts.choix === 'scene' && opts.ambianceScene ? `SCENE MOOD (user words): ${opts.ambianceScene}.` : '',
    `COLORS: build strictly around ${couleurs.join(' → ')} plus neutral depth shading.`,
    'COMPOSITION: the CENTRAL 55% of the frame stays calm and low-contrast — it will receive the logo. Detail lives on the edges.',
    referencesBlock(exemplars.references.length, 'They define the density, finish and calm-center construction to reach.'),
    SECONDARY_NO_TEXT_RULE,
  ].filter(Boolean).join('\n\n')

  return {
    prompt,
    aspectRatio: '1:1',
    category: 'libre',
    templateId: null,
    references: exemplars.references,
    exemplarSlugs: exemplars.slugs,
    expectedTexts: [],
  }
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

// Run 5.7 : compileLogoPromptLegacy (v1, « Premium esports/FiveM server
// logo » en un appel) est SUPPRIMÉE avec ses styles chrome/graffiti — c'était
// la signature esport 2015 en toutes lettres. Aucun chemin logo monolithique
// ne subsiste dans le code.

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
