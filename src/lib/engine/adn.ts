import { existsSync, readFileSync, readdirSync } from 'fs'
import { join, resolve } from 'path'

// ── L'ADN secteur + l'état d'entraînement (run 5.4, LOT 0/1/3) ───────────────
// Le constat du run 5.3 : des icônes de marque génériques parce qu'AUCUN trait
// du corpus (relief 3D, glow, matières, fonds atmosphériques) ne voyageait
// dans les prompts, et des tests lancés sans entraînement installé (mode
// dégradé silencieux). Ici :
//   1. la lecture du guide v4 (train-fivem-v4.ts) et de sa clé `adn` CHIFFRÉE
//      — fréquences mesurées sur 100 % du corpus, jamais des adjectifs ;
//   2. le garde-fou dur : requireTraining() JETTE si l'entraînement v4 n'est
//      pas installé — plus aucun chemin logo/héro ne génère sans lui ;
//   3. le bloc ADN (section 0 du gabarit maître) injecté dans CHAQUE appel
//      DA et CHAQUE génération logo.
// Lecture disque fraîche (cache 10 s) : le badge et le blocage reflètent
// l'état réel après un run d'entraînement, sans redémarrage du serveur.

const STYLES_DIR = resolve(import.meta.dir, '../../engine/styles/fivem')
const EXEMPLARS_DIR = resolve(import.meta.dir, '../../engine/exemplars/fivem')
const CACHE_MS = 10_000

export const TRAINING_REQUIRED_MESSAGE =
  'Entraînement requis — lance `bun run scripts/train-fivem-v4.ts` (puis committe les guides et exemplars).'

export class TrainingRequiredError extends Error {
  readonly code = 'training_required'
  constructor(detail?: string) {
    super(detail ? `${TRAINING_REQUIRED_MESSAGE} (${detail})` : TRAINING_REQUIRED_MESSAGE)
  }
}

// ── Le format ADN écrit par train-fivem-v4.ts dans chaque guide v4 ───────────
export type AdnTrait = { trait: string; frequence_pct: number; source: string }

export type AdnCategorie = {
  images: number
  // traits dominants AVEC leur fréquence mesurée — la matière de la section 0
  traits: AdnTrait[]
  scores_moyens: Record<string, number>
  frequences: Record<string, number>
  matieres: Array<{ matiere: string; pct: number }>
  // logos uniquement : familles de lettrage observées
  lettrages?: Array<{ type: string; pct: number }>
  // fonds uniquement : taxonomie de la bibliothèque de fonds
  taxonomie?: Array<{ type: string; pct: number }>
  palette_dominante: string[]
  // le paragraphe anglais compilé par le script — injecté tel quel en section 0
  resume_en: string
}

// ── Run 5.6, LOT 1 — les clés `fonds` et `familles_rendu` de logo.json ──────
// Mesurées par scripts/calibration/analyze-fonds.ts : la doctrine client
// (« le fond n'est jamais vide ») chiffrée sur les 59 logos, et les clusters
// de familles de rendu qui remplacent la règle abrogée « >= 2 relief ».
export type FondsSynthese = {
  images: number
  fonds_non_vides_pct: number
  familles: Record<string, number>
  texture_presente_pct: number
  scene_presente_pct: number
  combinaison_texture_scene_pct: number
  opacite_moyenne_texture_pct: number
  opacite_moyenne_scene_pct: number
  opacite_p10_p90_pct: [number, number]
  resume_en: string
}

export type FamillesRendu = {
  source: string
  familles: Array<{ famille: string; pct: number; glow_pct: number; description: string }>
  resume_en: string
}

type GuideV4 = {
  categorie: string
  version?: number
  images_totales?: number
  images_analysees?: number
  adn?: AdnCategorie
  fonds?: FondsSynthese
  familles_rendu?: FamillesRendu
  guide?: Record<string, unknown>
}

type Cached = { at: number; guide: GuideV4 | null }
const guideCache = new Map<string, Cached>()

function readGuide(category: string): GuideV4 | null {
  const cached = guideCache.get(category)
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.guide
  let guide: GuideV4 | null = null
  try {
    const path = join(STYLES_DIR, `${category}.json`)
    if (existsSync(path)) guide = JSON.parse(readFileSync(path, 'utf-8')) as GuideV4
  } catch {
    guide = null
  }
  guideCache.set(category, { at: Date.now(), guide })
  return guide
}

export function invalidateAdnCache() {
  guideCache.clear()
}

function countExemplars(category: string): { entries: number; images: number } {
  try {
    const dir = join(EXEMPLARS_DIR, category)
    if (!existsSync(dir)) return { entries: 0, images: 0 }
    const files = readdirSync(dir)
    return {
      entries: files.filter((f) => f.endsWith('.txt')).length,
      images: files.filter((f) => f.endsWith('.jpg')).length,
    }
  } catch {
    return { entries: 0, images: 0 }
  }
}

// ── L'état d'entraînement — la source du badge ET du blocage ─────────────────
export type TrainingStatus = {
  installed: boolean
  adnActif: boolean
  version: number | null
  // exemplaires logo installés (reverse-prompts au format gabarit)
  exemplarsLogo: number
  // références d'entraînement jointes au prochain appel logo (3 max)
  referencesJointes: number
  // bibliothèque de fonds (étape B) installée
  fondsBibliotheque: number
  imagesAnalysees: number
  imagesTotales: number
  // raisons du blocage quand installed=false — affichées telles quelles
  manques: string[]
}

export function getTrainingStatus(): TrainingStatus {
  const logo = readGuide('logo')
  const logoExemplars = countExemplars('logo')
  const fonds = countExemplars('background_logo')

  const manques: string[] = []
  if (!logo) manques.push('logo.json absent')
  else if ((logo.version ?? 0) < 4) manques.push(`logo.json v${logo.version ?? '?'} (v4 requis)`)
  if (logo && !logo.adn) manques.push('clé adn absente de logo.json')
  if (logoExemplars.entries === 0) manques.push('aucun exemplar logo installé')
  if (logoExemplars.images === 0) manques.push('aucune image de référence logo installée')
  if (fonds.entries === 0) manques.push('bibliothèque de fonds (background_logo) absente')

  return {
    installed: manques.length === 0,
    adnActif: Boolean(logo?.adn) && (logo?.version ?? 0) >= 4,
    version: logo?.version ?? null,
    exemplarsLogo: logoExemplars.entries,
    referencesJointes: Math.min(3, logoExemplars.images),
    fondsBibliotheque: fonds.entries,
    imagesAnalysees: logo?.images_analysees ?? 0,
    imagesTotales: logo?.images_totales ?? 0,
    manques,
  }
}

// Garde-fou dur (LOT 0) : tout chemin de génération logo/héro passe ici AVANT
// le moindre appel modèle. Pas de repli, pas de dégradé — on refuse.
export function requireTraining(): TrainingStatus {
  const status = getTrainingStatus()
  if (!status.installed) throw new TrainingRequiredError(status.manques.join(' ; '))
  return status
}

// ── Le bloc ADN — section 0 du gabarit maître (LOT 2/3) ─────────────────────
// Jamais optionnel : si l'ADN manque, on JETTE — un appel logo sans ADN est
// un bug, pas un mode.
export function adnFor(category: 'logo' | 'background_logo'): AdnCategorie {
  const guide = readGuide(category)
  if (!guide?.adn || (guide.version ?? 0) < 4) {
    throw new TrainingRequiredError(`adn ${category} indisponible`)
  }
  return guide.adn
}

// Interdits de famille du gabarit maître — la ligne qui tue l'icône d'appli.
export const ADN_FAMILY_FORBIDS =
  'Family forbids: never flat corporate branding, never an app icon, never a sticker/clipart, never a cute food-brand mascot, never a minimal startup logo.'

export function adnBlockLogo(): string {
  const adn = adnFor('logo')
  return [
    `0. CONTEXTE — FiveM/GTA RP server logo, in the exact family of the training corpus (${adn.images} logos measured): ${adn.resume_en}`,
    ADN_FAMILY_FORBIDS,
  ].join('\n')
}

export function adnBlockBackground(): string {
  const adn = adnFor('background_logo')
  return `BACKGROUND DNA (measured on the ${adn.images}-image background library): ${adn.resume_en}`
}

// ── Run 5.6 — les fonds mesurés du corpus logo (section 2bis du gabarit) ─────
// Jamais optionnel : un concept logo sans doctrine de fond est le bug qui a
// produit les « fonds bleu nuit vides » rejetés par le client au run 5.5.
export function fondsSyntheseLogo(): FondsSynthese {
  const guide = readGuide('logo')
  if (!guide?.fonds) {
    throw new TrainingRequiredError('clé fonds absente de logo.json — lance `bun run scripts/calibration/analyze-fonds.ts`')
  }
  return guide.fonds
}

export function famillesRenduLogo(): FamillesRendu {
  const guide = readGuide('logo')
  if (!guide?.familles_rendu) {
    throw new TrainingRequiredError('clé familles_rendu absente de logo.json — lance `bun run scripts/calibration/analyze-fonds.ts`')
  }
  return guide.familles_rendu
}

// Le bloc FONDS injecté dans l'appel DA : la mesure corpus + la cible cliente
// (l'extrémité discrète de la fourchette — « on les voit presque pas »).
export function fondsBlockLogo(): string {
  const fonds = fondsSyntheseLogo()
  return [
    `BACKGROUND DNA — measured on the same ${fonds.images} corpus logos: ${fonds.resume_en}`,
    'TARGET for generated marks: the DISCREET end of the measured range — every backdrop layer at 8-20% visibility. The backdrop is sensed, never watched.',
  ].join('\n')
}
