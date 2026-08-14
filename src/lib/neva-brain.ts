export type NevaBrainCategory =
  | 'composition_template'
  | 'camera_style'
  | 'environment_style'
  | 'fivem_location'
  | 'marketing_structure'
  | 'lighting_style'
  | 'character_scenario'

export type NevaBrainModule = 'design' | 'audit' | 'character'

export type NevaBrainEntry = {
  category: NevaBrainCategory
  name: string
  description: string
  prompt_context: string
  tags?: string[]
}

export const NEVA_PREMIUM_CREATIVE_STANDARD = `Neva Premium Creative Standard:
- Premium does not mean more effects. Use restraint, clarity, and taste before adding glow, particles, smoke, flares, heavy bloom, or neon.
- Every visual needs one clear focal point, strong visual hierarchy, readable silhouettes, controlled contrast, and intentional negative space.
- FiveM quality should feel like polished GTA V / Rockstar Editor promotional work: game-authentic, cinematic, grounded, not generic real-life stock photography.
- Prefer motivated light sources: sunset, street lamps, office windows, garage lights, vehicle headlights, police practicals. Avoid random colored lighting unless requested.
- Color grading must be controlled: deep but readable shadows, warm or neutral highlights, no crushed faces, no oversaturated skin, no plastic HDR.
- Marketing polish means composition, readability, identity, and conversion impact first; effects are only accents.
- If a character is uploaded, identity preservation beats style: face, tattoos, accessories, body proportions, outfit silhouette, and recognizable details stay stable.`

export const NEVA_BRAIN_FALLBACKS: NevaBrainEntry[] = [
  {
    category: 'composition_template',
    name: 'FiveM promotional hero',
    description: 'Hero subject, readable negative space, strong marketing hierarchy.',
    prompt_context:
      'Use a clear FiveM promotional composition: one dominant hero subject, readable background depth, clean negative space for branding, strong focal point, and no clutter around the face.',
    tags: ['poster', 'banner', 'marketing'],
  },
  {
    category: 'camera_style',
    name: 'Rockstar Editor hero angle',
    description: 'Game-cinematic lensing for FiveM characters and vehicles.',
    prompt_context:
      'Favor Rockstar Editor-inspired camera language: low or three-quarter angle, 35mm to 50mm lens feel, believable GTA V / FiveM proportions, cinematic but still game-authentic.',
    tags: ['character', 'vehicle', 'cinematic'],
  },
  {
    category: 'environment_style',
    name: 'Los Santos production depth',
    description: 'Layered urban depth without distracting from the subject.',
    prompt_context:
      'Build depth with foreground detail, midground subject clarity, and softly defocused Los Santos-style background elements. Keep the environment recognizable but secondary.',
    tags: ['depth', 'los-santos'],
  },
  {
    category: 'fivem_location',
    name: 'Premium RP city mix',
    description: 'Useful FiveM locations for marketing visuals.',
    prompt_context:
      'Use fitting FiveM / GTA-inspired locations when relevant: Vinewood Hills for luxury, Legion Square for city identity, Davis for street RP, Mission Row for police, La Mesa for mechanics, Vespucci for lifestyle.',
    tags: ['location'],
  },
  {
    category: 'marketing_structure',
    name: 'Server owner conversion layout',
    description: 'Readable ad structure for social and server promotion.',
    prompt_context:
      'Make the image sell the concept quickly: instant roleplay category recognition, premium polish, clear subject priority, high contrast where the viewer should look first, and space for logo or CTA when requested.',
    tags: ['marketing', 'social'],
  },
  {
    category: 'lighting_style',
    name: 'Premium practical lighting',
    description: 'Natural cinematic lighting without fake neon defaults.',
    prompt_context:
      'Use motivated practical lighting: golden hour, street lamps, storefront light, office window light, garage work lights, or police vehicle spill. Avoid generic cyberpunk glow unless explicitly requested.',
    tags: ['lighting'],
  },
  {
    category: 'character_scenario',
    name: 'Strict identity preservation',
    description: 'Preserve uploaded FiveM character identity.',
    prompt_context:
      'When a character reference is uploaded, preserve identity first: same face, facial structure, skin tone, hairstyle, facial hair, tattoos, jewelry, body proportions, outfit silhouette, and signature accessories. Do not redesign the person.',
    tags: ['character', 'identity'],
  },
]

export function buildNevaBrainContext(module: NevaBrainModule, entries: NevaBrainEntry[] = NEVA_BRAIN_FALLBACKS) {
  const moduleFocus: Record<NevaBrainModule, string[]> = {
    design: ['composition_template', 'camera_style', 'environment_style', 'fivem_location', 'marketing_structure', 'lighting_style', 'character_scenario'],
    audit: ['composition_template', 'marketing_structure', 'lighting_style', 'environment_style'],
    character: ['character_scenario', 'camera_style', 'lighting_style', 'marketing_structure'],
  }

  const allowed = new Set(moduleFocus[module])
  const selected = entries.filter((entry) => allowed.has(entry.category))

  const moduleContext = selected
    .map((entry) => `- ${entry.name}: ${entry.prompt_context}`)
    .join('\n')

  return `${NEVA_PREMIUM_CREATIVE_STANDARD}\n\nNeva Brain module rules:\n${moduleContext}`
}
