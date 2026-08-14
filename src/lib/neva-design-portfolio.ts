export const PORTFOLIO_CATEGORIES = ['Logos', 'Packs', 'Branding', 'Affiches', 'FiveM'] as const

export type NevaDesignPortfolioCategory = (typeof PORTFOLIO_CATEGORIES)[number]

export type NevaDesignPortfolioItem = {
  id: string
  title: string
  category: NevaDesignPortfolioCategory
  tag: string
  image_path: string | null
  description: string | null
  is_featured: boolean
  is_active: boolean
  priority: number
  layout: 'normal' | 'tall' | 'wide'
  created_at: string
  updated_at: string
}

export type NevaDesignPortfolioInput = Omit<NevaDesignPortfolioItem, 'id' | 'created_at' | 'updated_at'>

export function isPortfolioCategory(value: unknown): value is NevaDesignPortfolioCategory {
  return typeof value === 'string' && (PORTFOLIO_CATEGORIES as readonly string[]).includes(value)
}

export function isPortfolioLayout(value: unknown): value is NevaDesignPortfolioItem['layout'] {
  return value === 'normal' || value === 'tall' || value === 'wide'
}
