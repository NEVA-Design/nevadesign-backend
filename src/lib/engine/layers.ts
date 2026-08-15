// Modèle de calques partagé moteur/éditeur (run 5).
// Les transforms sont NORMALISÉS (fractions du canvas) : le même calque se
// composite à l'identique en aperçu 1K dans l'éditeur et en export 4K.

export type LayerType = 'scene' | 'effect' | 'logo' | 'text' | 'grain'
export type BlendMode = 'normal' | 'screen' | 'multiply' | 'overlay'

export type TextShadow = { x: number; y: number; blur: number; color: string }
export type TextGradient = { from: string; to: string; angle: number }

export type Layer = {
  id: string
  type: LayerType
  name: string
  // centre du calque en fractions du canvas (0..1)
  x: number
  y: number
  // largeur du calque relative à la largeur du canvas (1 = pleine largeur)
  scale: number
  rotation: number
  opacity: number
  blend: BlendMode
  locked?: boolean
  hidden?: boolean

  // scene / effect / logo / grain
  url?: string
  // ratio natif de l'image du calque (w/h) — sert au compositing
  aspect?: number
  // logo : quelle déclinaison du master
  variant?: 'color' | 'white' | 'black'
  // effect / grain : id dans la bibliothèque d'effets maison
  effectId?: string

  // text — le texte est TOUJOURS un calque réel, jamais généré par l'IA
  text?: string
  font?: string
  weight?: number
  // hauteur de ligne relative à la hauteur du canvas (0.1 = 10 %)
  sizeRel?: number
  color?: string
  strokeColor?: string
  // épaisseur relative à la taille de police (0.04 = 4 %)
  strokeWidth?: number
  shadow?: TextShadow | null
  gradient?: TextGradient | null
  letterSpacing?: number
  align?: 'left' | 'center' | 'right'
  uppercase?: boolean
}

// Typos display chargées par le front (next/font) et rendues par l'export
// serveur — la liste est UNIQUE et partagée.
export const TEXT_FONTS = [
  { id: 'archivo-black', label: 'Archivo Black', css: '"Archivo Black", sans-serif' },
  { id: 'bebas-neue', label: 'Bebas Neue', css: '"Bebas Neue", sans-serif' },
  { id: 'anton', label: 'Anton', css: 'Anton, sans-serif' },
  { id: 'oswald', label: 'Oswald', css: 'Oswald, sans-serif' },
  { id: 'montserrat', label: 'Montserrat', css: 'Montserrat, sans-serif' },
] as const

export function makeLayerId(): string {
  return `layer-${crypto.randomUUID().slice(0, 8)}`
}
