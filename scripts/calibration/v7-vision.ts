/*
 * Run 7 — les PORTES DE VISION, avec un lecteur JSON qui ne lâche pas.
 *
 * `geminiVisionJson` renvoie `null` dès que `JSON.parse` échoue, et cette session
 * a payé deux fois pour ça : d'abord un gabarit portant des commentaires `//` que
 * le modèle recopiait, ensuite une intermittence jamais expliquée (la même
 * requête, rejouée, renvoyait un JSON valide). Un `null` sur une porte de mesure
 * a un coût réel : la garde correspondante ne prononce plus, la boucle croit
 * avoir tout vérifié, et un candidat passe sur de l'hygiène seule.
 *
 * Ici on lit le texte, on en extrait le premier objet JSON équilibré, et on DIT
 * ce qui s'est passé quand ça rate — avec le texte brut, pas un « réponse
 * invalide ».
 */

import { geminiVisionText } from '../../src/lib/ai/gemini'
import { extraitPremierJson } from './v7-lib'

export type ResultatVision<T> = { valeur: T | null; brut: string; raison: string | null }

export async function visionJson<T>(opts: {
  model: string
  imageBase64: string
  mimeType: string
  prompt: string
  maxOutputTokens?: number
  temperature?: number
}): Promise<ResultatVision<T>> {
  let brut = ''
  try {
    brut = await geminiVisionText({
      model: opts.model,
      imageBase64: opts.imageBase64,
      mimeType: opts.mimeType,
      prompt: opts.prompt,
      temperature: opts.temperature ?? 0,
      maxOutputTokens: opts.maxOutputTokens ?? 1600,
      json: true,
      thinkingBudget: 0,
    })
  } catch (err) {
    // L'erreur remonte : un refus de la garde budget doit se propager, pas se
    // transformer en « réponse invalide ».
    throw err
  }

  const bloc = extraitPremierJson(brut)
  if (!bloc) return { valeur: null, brut, raison: 'aucun objet JSON dans la réponse' }
  try {
    return { valeur: JSON.parse(bloc) as T, brut, raison: null }
  } catch (err) {
    return { valeur: null, brut, raison: `objet JSON illisible : ${(err as Error).message}` }
  }
}
