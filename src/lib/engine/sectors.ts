// Registry des secteurs du moteur (run 5, LOT 2).
// FiveM est le seul actif ; les autres sont visibles côté produit en
// cartes « Bientôt ». Chaque secteur actif porte son prompt système —
// le socle que le compilateur place devant chaque génération.

export type SectorId = 'fivem' | 'youtube' | 'marques' | 'evenementiel'

export type Sector = {
  id: SectorId
  label: string
  active: boolean
  // Prompt système du secteur — injecté en tête de chaque prompt compilé
  systemPrompt: string
}

export const SECTORS: Record<SectorId, Sector> = {
  fivem: {
    id: 'fivem',
    label: 'FiveM',
    active: true,
    systemPrompt: `You are generating premium FiveM / GTA V promotional artwork for a roleplay server.
Target quality bar: heavily-modded FiveM screenshot or Rockstar-grade key art — game-authentic characters and environments, cinematic lighting, controlled color grading, believable Los Santos world.
Non-negotiable rules:
- GTA V / FiveM aesthetic: stylized game realism, never a real-life stock photo, never generic 3D render.
- One dominant focal point, readable silhouette, intentional negative space for later logo and text placement.
- Motivated lighting only (sun, practicals, neon signs when the scene calls for it) — no random glow.
- No extra people beyond those requested. No distorted anatomy, no extra fingers, no malformed limbs.
- Never render any watermark, signature, UI or HUD.`,
    // Depuis le run 5.2, le lettrage (titre, logo) est GÉNÉRÉ dans l'image :
    // le négatif texte global a quitté ce socle. Il ne survit que sur les
    // calques secondaires (compiler.ts SECONDARY_NO_TEXT_RULE) et dans le
    // chemin legacy réservé à l'A/B de /admin/test-moteur.
  },
  youtube: {
    id: 'youtube',
    label: 'YouTube',
    active: false,
    systemPrompt: '',
  },
  marques: {
    id: 'marques',
    label: 'Marques',
    active: false,
    systemPrompt: '',
  },
  evenementiel: {
    id: 'evenementiel',
    label: 'Événementiel',
    active: false,
    systemPrompt: '',
  },
}

export function getSector(id: string): Sector | null {
  return (SECTORS as Record<string, Sector>)[id] ?? null
}

export function getActiveSector(id: string): Sector | null {
  const sector = getSector(id)
  return sector?.active ? sector : null
}
