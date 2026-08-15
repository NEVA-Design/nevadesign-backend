// Modèle de calques partagé moteur/éditeur (run 5.2).
// Les transforms sont NORMALISÉS (fractions du canvas) : le même calque se
// composite à l'identique en aperçu 1K dans l'éditeur et en export 4K.
//
// Depuis le run 5.2, le type 'text' n'existe plus : le lettrage (titre,
// baseline) est GÉNÉRÉ dans le calque héro par le moteur, jamais posé en
// texte système. Le code d'édition de texte a été supprimé physiquement
// (backend : composite.ts/satori ; front : AssetEditor/LayerCanvas).

export type LayerType = 'scene' | 'effect' | 'logo' | 'grain'
// Les modes de fusion ne sont plus exposés dans l'éditeur : ils restent
// portés par les effets maison (manifest.json) et le compositing serveur.
export type BlendMode = 'normal' | 'screen' | 'multiply' | 'overlay'

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

  // gomme non destructive (run 5.2, LOT 4) : masque alpha peint dans
  // l'éditeur — blanc opaque = visible, transparent = effacé. Stocké via
  // POST /engine/mask, appliqué au compositing ET à l'aperçu (CSS mask).
  maskUrl?: string
}

export function makeLayerId(): string {
  return `layer-${crypto.randomUUID().slice(0, 8)}`
}

// Migration : les assets d'avant le run 5.2 peuvent contenir des calques
// 'text' en base — ils sont filtrés partout (compositing, éditeur, API).
export function stripLegacyTextLayers(layers: unknown): Layer[] {
  if (!Array.isArray(layers)) return []
  return (layers as Array<{ type?: string }>).filter((l) => l && l.type !== 'text') as Layer[]
}
