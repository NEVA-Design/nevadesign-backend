export type AspectRatioId = '1:1' | '4:3' | '16:9' | '3:4' | '9:16'

export type AspectRatioDefinition = {
  id: AspectRatioId
  label: string
  orientation: 'square' | 'landscape' | 'portrait' | 'ultrawide'
  w: number
  h: number
  promptLabel: string
  providerInstruction: string
}

export const ASPECT_RATIOS: AspectRatioDefinition[] = [
  {
    id: '1:1',
    label: '1:1',
    orientation: 'square',
    w: 13,
    h: 13,
    promptLabel: '1:1 SQUARE (equal width and height)',
    providerInstruction: 'Generate a SQUARE image. The final frame must be exactly 1:1 with equal width and height. Do not use a vertical story or TikTok crop.',
  },
  {
    id: '4:3',
    label: '4:3',
    orientation: 'landscape',
    w: 16,
    h: 12,
    promptLabel: '4:3 LANDSCAPE (classic horizontal frame)',
    providerInstruction: 'Generate a CLASSIC LANDSCAPE image. The final frame must be exactly 4:3: wider than tall, horizontal composition. Do not use 9:16 unless explicitly selected.',
  },
  {
    id: '16:9',
    label: '16:9',
    orientation: 'landscape',
    w: 20,
    h: 11,
    promptLabel: '16:9 WIDE LANDSCAPE (horizontal, wider than tall)',
    providerInstruction: 'Generate a WIDE LANDSCAPE HORIZONTAL image. The final frame must be exactly 16:9: wider than tall, panoramic, horizontal composition. Do not use 9:16 unless explicitly selected.',
  },
  {
    id: '3:4',
    label: '3:4',
    orientation: 'portrait',
    w: 12,
    h: 16,
    promptLabel: '3:4 PORTRAIT (classic vertical frame)',
    providerInstruction: 'Generate a CLASSIC PORTRAIT image. The final frame must be exactly 3:4: taller than wide, vertical but not TikTok-tall. Do not use 9:16 unless explicitly selected.',
  },
  {
    id: '9:16',
    label: '9:16',
    orientation: 'portrait',
    w: 8,
    h: 14,
    promptLabel: '9:16 TALL PORTRAIT (vertical, taller than wide)',
    providerInstruction: 'Generate a TALL PORTRAIT VERTICAL image only because 9:16 was explicitly selected. The final frame must be exactly 9:16: taller than wide, TikTok/story composition.',
  },
]

export function normalizeAspectRatio(value: unknown): AspectRatioId | null {
  return ASPECT_RATIOS.some((ratio) => ratio.id === value) ? (value as AspectRatioId) : null
}

export function getAspectRatio(value: unknown) {
  const id = normalizeAspectRatio(value) ?? '1:1'
  return ASPECT_RATIOS.find((ratio) => ratio.id === id) ?? ASPECT_RATIOS[2]!
}

export function getAspectRatioInstruction(value: unknown) {
  return getAspectRatio(value).providerInstruction
}

export function aspectRatioToNumber(value: unknown) {
  const ratio = getAspectRatio(value)
  return ratio.w / ratio.h
}
