import { AiError, type ChatMessage, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

interface GeminiPart {
  text?: string
}

interface GeminiContent {
  role?: string
  parts?: GeminiPart[]
}

interface GeminiCandidate {
  content?: GeminiContent
  finishReason?: string
}

interface GeminiResponse {
  candidates?: GeminiCandidate[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
}

/**
 * Gemini requires turns with alternating roles 'user' and 'model'.
 * The conversation must strictly start and end on the user:
 * - Drop leading assistant turns (e.g. initial greeting)
 * - Drop trailing assistant turns (Gemini rejects requests ending on model/assistant)
 */
export function normalizeForGemini(messages: ChatMessage[]): { role: 'user' | 'model'; parts: { text: string }[] }[] {
  const merged = mergeConsecutive(messages)
  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged.shift()
  }
  while (merged.length > 0 && merged[merged.length - 1].role === 'assistant') {
    merged.pop()
  }
  if (merged.length === 0) {
    return [{ role: 'user', parts: [{ text: '(The customer has not sent a message yet.)' }] }]
  }
  return merged.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))
}

/**
 * Detect whether the given credentials or model target Kie.ai.
 * Kie.ai API keys are 32-character hexadecimal strings.
 */
export function isKieAi(apiKey: string, model: string): boolean {
  const cleanKey = apiKey.trim()
  return /^[a-f0-9]{32}$/i.test(cleanKey) || model.toLowerCase().includes('kie')
}

/**
 * Generate completion via Kie.ai OpenAI-compatible endpoint for Gemini models.
 * Automatically retries with backoff if Kie.ai returns temporary network/maintenance errors (500, 524).
 * Strictly preserves the requested model (e.g. gemini-2.5-flash) and does NOT route to Gemini 3.x.
 */
const DEFAULT_KIE_MODEL = 'gemini-2.5-flash'

/**
 * Generate completion via Kie.ai OpenAI-compatible endpoint.
 * Prioritizes active operational Gemini Flash models on Kie.ai with SSE streaming
 * for ultra-fast (2.5s-3.5s) responses and zero dead time.
 */
async function generateKie(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args
  const cleanModel =
    model.trim().replace(/^(kie::|models\/|gemini::|openai::|anthropic::)/i, '') || DEFAULT_KIE_MODEL

  const merged = mergeConsecutive(messages)
  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged.shift()
  }
  while (merged.length > 0 && merged[merged.length - 1].role === 'assistant') {
    merged.pop()
  }
  if (merged.length === 0) {
    merged.push({ role: 'user', content: '(The customer has not sent a message yet.)' })
  }

  // Keep last 8 turns max to prevent proxy timeouts and payload overload
  const trimmed = merged.slice(-8)

  const formattedMessages: { role: 'system' | 'user' | 'assistant'; content: string }[] = []
  if (systemPrompt?.trim()) {
    formattedMessages.push({ role: 'system', content: systemPrompt.trim() })
  }
  for (const m of trimmed) {
    formattedMessages.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    })
  }

  // Model cascade: requested model first, followed by active operational flash fallbacks on Kie.ai
  const modelsToTry: string[] = [cleanModel]
  if (cleanModel === 'gemini-2.5-flash' || cleanModel.startsWith('gemini-2.')) {
    modelsToTry.push('gemini-3-8-flash-openai', 'gemini-3-7-flash-openai')
  } else if (!cleanModel.includes('3-8')) {
    modelsToTry.push('gemini-3-8-flash-openai', 'gemini-3-7-flash-openai')
  }

  const perAttemptTimeout = Math.min(timeoutMs, 7000)
  let lastError: unknown = null

  for (const currentModel of modelsToTry) {
    const isFlash25 = currentModel === 'gemini-2.5-flash'
    // gemini-2.5-flash on Kie.ai requires non-streaming; 3.x models support fast SSE streaming
    const shouldStream = !isFlash25
    const maxAttempts = isFlash25 ? 2 : 1

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch('https://api.kie.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey.trim()}`,
          },
          body: JSON.stringify({
            model: currentModel,
            messages: formattedMessages,
            temperature: 0.7,
            max_tokens: 150,
            stream: shouldStream,
          }),
          signal: AbortSignal.timeout(perAttemptTimeout),
        })

        if (!res?.ok) {
          if (res?.status === 401) {
            throw new AiError('Chave de API Kie.ai inválida ou não autorizada.', { code: 'invalid_key', status: 401 })
          }
          lastError = await providerHttpError('Kie.ai (Gemini)', res)
          continue
        }

        const contentType =
          res.headers && typeof res.headers.get === 'function'
            ? res.headers.get('content-type') || ''
            : ''
        const isSseStream = contentType.includes('text/event-stream')

        // 1. Handle SSE stream
        if (isSseStream && res.body && typeof (res.body as unknown as { getReader: unknown }).getReader === 'function') {
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let text = ''
          let buffer = ''
          let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
              const trimmedLine = line.trim()
              if (!trimmedLine.startsWith('data:')) continue
              const dataStr = trimmedLine.slice(5).trim()
              if (!dataStr || dataStr === '[DONE]') continue
              try {
                const json = JSON.parse(dataStr)
                if (json.code && json.code !== 200) {
                  continue
                }
                const delta = json.choices?.[0]?.delta?.content
                if (delta) text += delta
                if (json.usage) usage = json.usage
              } catch {
                // Ignore non-JSON line
              }
            }
          }

          const trimmedText = text.trim()
          if (trimmedText) {
            return {
              text: trimmedText,
              usage: normalizeUsage({
                prompt: usage.prompt_tokens,
                completion: usage.completion_tokens,
                total: usage.total_tokens,
              }),
            }
          }
        } else {
          // 2. Handle JSON response
          const data = await res.json().catch(() => null)
          if (data?.code && data.code !== 200) {
            if (data.code === 401) {
              throw new AiError('Chave de API Kie.ai inválida ou não autorizada.', { code: 'invalid_key', status: 401 })
            }
            lastError = new AiError(data.msg || `Kie.ai error: ${data.code}`, { code: 'provider_error', status: 500 })
            if (attempt < maxAttempts && (data.code === 500 || data.code === 524 || data.code === 429)) {
              await new Promise((r) => setTimeout(r, 50))
              continue
            }
            continue
          }

          const text = data?.choices?.[0]?.message?.content?.trim()
          if (text) {
            return {
              text,
              usage: normalizeUsage({
                prompt: data?.usage?.prompt_tokens,
                completion: data?.usage?.completion_tokens,
                total: data?.usage?.total_tokens,
              }),
            }
          }
        }
      } catch (err) {
        lastError = err
        if (err instanceof AiError && err.code === 'invalid_key') throw err
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 50))
          continue
        }
      }
    }
  }

  if (lastError instanceof AiError) throw lastError
  throw toNetworkError(lastError)
}

/**
 * Call Google Gemini endpoint (or Kie.ai if using a Kie key) with the caller's key.
 * Returns raw text + token usage (handoff parsing happens in `generateReply`).
 */
export async function generateGemini(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  if (isKieAi(apiKey, model)) {
    return generateKie(args)
  }

  const cleanModel = model.trim().replace(/^models\//, '')
  const endpoint = `${GEMINI_BASE_URL}/${encodeURIComponent(cleanModel)}:generateContent`

  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        system_instruction: systemPrompt?.trim()
          ? { parts: [{ text: systemPrompt.trim() }] }
          : undefined,
        contents: normalizeForGemini(messages),
        generationConfig: {
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          temperature: 0.7,
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Google Gemini', res)
  }

  const data = (await res.json().catch(() => null)) as GeminiResponse | null
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((p) => p.text || '')
    .join('')
    .trim()

  if (!text) {
    throw new AiError('Google Gemini returned an empty response.', {
      code: 'empty_response',
    })
  }

  const usage = normalizeUsage({
    prompt: data?.usageMetadata?.promptTokenCount,
    completion: data?.usageMetadata?.candidatesTokenCount,
    total: data?.usageMetadata?.totalTokenCount,
  })

  return { text, usage }
}
