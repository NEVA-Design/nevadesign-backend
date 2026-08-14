import { env } from '../config/env'

export interface ResourcePack {
  id: string
  name: string
  price: number
  tagline: string
  description: string
  badge: string | null
  features: string[]
  priceId: string
  downloadUrl: string
}

/* Les 3 packs de création (section 08, run 2) — prestations
   assemblées par le studio, paiement unique, même flux Stripe que
   les ressources. */
export const CREATION_PACKS: Record<string, ResourcePack> = {
  'pack-identite': {
    id: 'pack-identite',
    name: 'Pack Identité',
    price: 19,
    tagline: 'Identité visuelle',
    badge: null,
    description:
      'Le socle de votre image : un logo travaillé en trois directions, ses déclinaisons, et vos premiers supports.',
    features: [
      'Logo — 3 pistes créatives',
      'Déclinaisons de la piste retenue',
      '2 bannières réseaux',
      '1 affiche',
    ],
    priceId: env.STRIPE_PRICE_PACK_IDENTITE,
    downloadUrl: env.PACK_IDENTITE_DOWNLOAD_URL,
  },

  'pack-lancement': {
    id: 'pack-lancement',
    name: 'Pack Lancement',
    price: 49,
    tagline: 'Tout pour démarrer',
    badge: 'LE PLUS COMPLET',
    description:
      "L'identité complète et tous les supports du jour J : réseaux, écran d'attente, affichage.",
    features: [
      'Identité complète (logo + déclinaisons)',
      'Kit réseaux — 6 formats',
      "Écran d'attente",
      '4 affiches',
    ],
    priceId: env.STRIPE_PRICE_PACK_LANCEMENT,
    downloadUrl: env.PACK_LANCEMENT_DOWNLOAD_URL,
  },

  'pack-marque': {
    id: 'pack-marque',
    name: 'Pack Marque',
    price: 79,
    tagline: 'La marque entière',
    badge: null,
    description:
      'Le système complet : tout le Pack Lancement, la charte, les déclinaisons et des templates éditables à votre nom.',
    features: [
      'Tout le Pack Lancement',
      'Charte couleurs & typographies',
      '4 déclinaisons du logo',
      '8 templates éditables personnalisés',
    ],
    priceId: env.STRIPE_PRICE_PACK_MARQUE,
    downloadUrl: env.PACK_MARQUE_DOWNLOAD_URL,
  },
}

/* Ressources du studio — les outils Photoshop (carte secondaire de
   la section 08). */
export const RESOURCE_PACKS: Record<string, ResourcePack> = {
  'pack-brush': {
    id: 'pack-brush',
    name: 'Pack Brush',
    price: 30,
    tagline: 'Brushes Photoshop',
    badge: null,
    description: 'Brushes premium spécialement designés pour la création FiveM — grain cinématique, smoke, dust, rim-light, textures urbaines.',
    features: [
      '200+ brushes Photoshop premium',
      'Grain cinématique Los Santos',
      'Smoke, dust & haze atmosphérique',
      'Rim-light & séparation sujet',
      'Textures urbaines & asphalte',
      'Accès aux mises à jour',
    ],
    priceId: env.STRIPE_PRICE_PACK_BRUSH,
    downloadUrl: env.PACK_BRUSH_DOWNLOAD_URL,
  },

  'neva-pack': {
    id: 'neva-pack',
    name: 'Neva Pack',
    price: 90,
    tagline: 'Pack GFX complet',
    badge: null,
    description: 'Le pack créateur complet — brushes, templates PSD, overlays, palettes certifiées, guides et support Discord.',
    features: [
      'Tout le Pack Brush (200+ brushes)',
      '20+ templates Photoshop (.PSD)',
      'Overlays & effets FiveM prêts',
      '10 chartes couleurs certifiées',
      'Guides PDF composition & design',
      'Pack polices recommandées',
      'Support Discord créateurs',
      'Toutes les mises à jour futures',
    ],
    priceId: env.STRIPE_PRICE_NEVA_PACK,
    downloadUrl: env.NEVA_PACK_DOWNLOAD_URL,
  },
}

export type ResourcePackPublic = Omit<ResourcePack, 'priceId' | 'downloadUrl'>

/* Tous les achats one-shot (packs de création + ressources) passent
   par le même checkout Stripe. */
export const ONE_SHOT_PACKS: Record<string, ResourcePack> = {
  ...CREATION_PACKS,
  ...RESOURCE_PACKS,
}

const toPublic = (packs: Record<string, ResourcePack>): Record<string, ResourcePackPublic> =>
  Object.fromEntries(
    Object.entries(packs).map(([k, { priceId: _p, downloadUrl: _d, ...rest }]) => [k, rest])
  )

export const CREATION_PACKS_PUBLIC: Record<string, ResourcePackPublic> = toPublic(CREATION_PACKS)
export const RESOURCE_PACKS_PUBLIC: Record<string, ResourcePackPublic> = toPublic(RESOURCE_PACKS)
