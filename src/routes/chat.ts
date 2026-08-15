import { Elysia } from 'elysia'
import { getModel, IMAGE_BRIEF_MARKER, MODULE_SYSTEM_PROMPTS } from '../lib/ai/models'
import { composeModuleSystemPrompt, getModuleContract, type NevaAIModule } from '../lib/ai/orchestrator'
import { geminiStreamText, type GeminiContent } from '../lib/ai/gemini'
import {
  checkRateLimit,
  hasPromptInjectionRisk,
  jsonError,
  sanitizeText,
  securityLog,
  validateUploadedImages,
} from '../lib/security'
import { requireUser, isResponse } from '../lib/require-auth'
import { deductCredits } from '../lib/credits'
import { saveChatHistory } from '../lib/chat'
import { CREDIT_COSTS } from '../lib/plans'

function hasCompleteEnding(text: string) {
  const trimmed = text.trim()
  if (/[.!?…]["''")]*$/.test(trimmed)) return true
  if (/\d+\s*(px|%|dpi|pt|em|rem|K|k)["''")]*$/i.test(trimmed)) return true
  if (/\.(png|jpg|jpeg|gif|svg|psd|pdf|webp)["''")]*$/i.test(trimmed)) return true
  if (/#[0-9A-Fa-f]{3,8}["''")]*$/.test(trimmed)) return true
  return false
}

type IncomingMessage = {
  role: 'user' | 'assistant'
  content: string
  attachments?: Array<{ data: string; mimeType: string }>
}

function toGeminiContent(m: IncomingMessage): GeminiContent {
  if (m.role === 'assistant') {
    return { role: 'model', parts: [{ text: m.content || '.' }] }
  }

  const attachmentParts = (m.attachments ?? []).map((att) => ({ inlineData: { mimeType: att.mimeType, data: att.data } }))
  return { role: 'user', parts: [...attachmentParts, { text: m.content || '.' }] }
}

export const chatRoutes = new Elysia({ prefix: '/chat' })
  .get('/history', async ({ request }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user, supabase } = auth

    const { data, error } = await supabase
      .from('chat_histories')
      .select('messages')
      .eq('user_id', user.id)
      .single()

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({ messages: data?.messages ?? [] }), {
      headers: { 'Content-Type': 'application/json' },
    })
  })
  .post('/history', async ({ request }) => {
    const auth = await requireUser(request)
    if (isResponse(auth)) return auth
    const { user, supabase } = auth

    const body = await request.json() as { messages?: unknown }
    const messages = body.messages ?? []

    const { error } = await supabase
      .from('chat_histories')
      .upsert({ user_id: user.id, messages, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    })
  })
  .post('/', async ({ request }) => {
    try {
      const auth = await requireUser(request)
      if (isResponse(auth)) return auth
      const { user, supabase } = auth

      const { messages, modelId, module: moduleName } = await request.json() as {
        messages?: IncomingMessage[]
        modelId?: string
        module?: string
      }

      const moduleKey: NevaAIModule = moduleName === 'design' || moduleName === 'enhance' || moduleName === 'audit' || moduleName === 'character'
        ? moduleName
        : 'chat'
      const contract = getModuleContract(moduleKey)
      const rate = checkRateLimit(`chat:${user.id}`, contract.rateLimitPerMinute)
      if (!rate.ok) {
        securityLog('rate_limited', { userId: user.id, module: moduleKey })
        return jsonError('rate_limited', 429)
      }

      if (!messages?.length || messages.length > 30) return new Response('No messages provided', { status: 400 })

      const safeMessages: IncomingMessage[] = []
      for (const message of messages) {
        const safeContent = sanitizeText(message.content, contract.maxInputChars)
        if (hasPromptInjectionRisk(safeContent)) {
          securityLog('prompt_injection_signal', { userId: user.id, module: moduleKey })
        }

        const attachments = message.attachments ?? []
        const validated = validateUploadedImages(attachments, contract.maxImages)
        if (!validated.ok) return jsonError(validated.error, 400)

        safeMessages.push({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: safeContent || '.',
          attachments: validated.images,
        })
      }

      const deduction = await deductCredits(supabase, user.id, CREDIT_COSTS.chat, 'chat', 'Message Neva Chat')
      if (!deduction.success) {
        return new Response(
          JSON.stringify({ error: 'insufficient_credits', remaining: deduction.remaining }),
          { status: 402, headers: { 'Content-Type': 'application/json' } }
        )
      }

      const nevaModel = getModel(modelId ?? 'neva-pro')
      const moduleExtra = MODULE_SYSTEM_PROMPTS[moduleKey] ?? ''
      const systemPrompt = composeModuleSystemPrompt(moduleKey, nevaModel.systemPrompt, moduleExtra)

      const geminiContents: GeminiContent[] = safeMessages.map(toGeminiContent)
      const maxOutputTokens = Math.min(nevaModel.maxOutputTokens ?? 900, 900)
      const temperature = nevaModel.temperature ?? 0.45

      let assistantText = ''
      const encoder = new TextEncoder()

      const stream = new ReadableStream({
        async start(controller) {
          try {
            for await (const text of geminiStreamText({
              model: nevaModel.geminiModel,
              contents: geminiContents,
              systemInstruction: systemPrompt,
              temperature,
              maxOutputTokens,
              thinkingBudget: 0,
            })) {
              assistantText += text
              controller.enqueue(encoder.encode(text))
            }

            if (assistantText && !hasCompleteEnding(assistantText.replaceAll(IMAGE_BRIEF_MARKER, ''))) {
              const continuationContents: GeminiContent[] = [
                ...geminiContents,
                { role: 'model', parts: [{ text: assistantText }] },
                {
                  role: 'user',
                  parts: [{ text: "Ta réponse s'est coupée. Termine uniquement la phrase ou l'étape en cours — 1 à 2 lignes maximum, puis arrête-toi. Ne répète rien du début." }],
                },
              ]

              for await (const text of geminiStreamText({
                model: nevaModel.geminiModel,
                contents: continuationContents,
                systemInstruction: systemPrompt,
                temperature,
                maxOutputTokens: 200,
                thinkingBudget: 0,
              })) {
                assistantText += text
                controller.enqueue(encoder.encode(text))
              }
            }
          } catch (streamErr) {
            console.error('[/chat] stream error:', streamErr)
          }

          const canGenerateImage = assistantText.includes(IMAGE_BRIEF_MARKER)
          const cleanText = assistantText.replaceAll(IMAGE_BRIEF_MARKER, '').trim()

          try {
            await saveChatHistory(supabase, user.id, [
              ...safeMessages.map(m => ({
                role: m.role,
                content: m.content,
                timestamp: new Date().toISOString(),
                attachments: m.attachments,
              })),
              {
                role: 'assistant' as const,
                content: cleanText,
                canGenerateImage,
                timestamp: new Date().toISOString(),
              },
            ])
          } catch (e) {
            console.error('[/chat] saveChatHistory failed (non-fatal):', e)
          }

          controller.close()
        },
      })

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Neva-Model': nevaModel.name,
          'X-Credits-Remaining': String(deduction.remaining),
        },
      })
    } catch (err) {
      const e = err as { message?: string }
      console.error('[/chat]', e?.message ?? err)
      return new Response(
        JSON.stringify({ error: e?.message ?? 'Internal server error' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      )
    }
  })
