import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateGemini } from './gemini'
import { AiError } from '../types'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('generateGemini adapter', () => {
  it('handles 400 invalid_key / invalid_argument properly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            code: 400,
            message: 'API_KEY_INVALID: API key not valid. Please pass a valid API key.',
            status: 'INVALID_ARGUMENT',
          },
        }),
      }),
    )

    await expect(
      generateGemini({
        apiKey: 'bad-key',
        model: 'gemini-1.5-flash',
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hello' }],
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(AiError)
  })

  it('maps 401/403 to invalid_key code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({
          error: {
            message: 'Method doesn\'t allow unregistered callers.',
          },
        }),
      }),
    )

    try {
      await generateGemini({
        apiKey: 'unauthorized-key',
        model: 'gemini-1.5-flash',
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hello' }],
        timeoutMs: 5000,
      })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(AiError)
      expect((err as AiError).code).toBe('invalid_key')
      expect((err as AiError).status).toBe(401)
    }
  })

  it('maps 429 to rate_limited code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({
          error: {
            message: 'Resource has been exhausted (e.g. check quota).',
          },
        }),
      }),
    )

    try {
      await generateGemini({
        apiKey: 'test-key',
        model: 'gemini-1.5-flash',
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hello' }],
        timeoutMs: 5000,
      })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(AiError)
      expect((err as AiError).code).toBe('rate_limited')
    }
  })

  it('handles empty response gracefully', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '   ' }] } }],
        }),
      }),
    )

    await expect(
      generateGemini({
        apiKey: 'test-key',
        model: 'gemini-1.5-flash',
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hello' }],
        timeoutMs: 5000,
      }),
    ).rejects.toMatchObject({ code: 'empty_response' })
  })

  it('routes 32-hex keys to Kie.ai endpoint and parses completions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'Resposta do Kie.ai' } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
      }),
    )

    const result = await generateGemini({
      apiKey: 'a7ec7f7854ab225cefcff91813bfa13a',
      model: 'gemini-2.5-flash',
      systemPrompt: 'Sistema',
      messages: [{ role: 'user', content: 'Oi' }],
      timeoutMs: 5000,
    })

    expect(result.text).toBe('Resposta do Kie.ai')
    expect(result.usage?.totalTokens).toBe(30)
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'https://api.kie.ai/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer a7ec7f7854ab225cefcff91813bfa13a',
        }),
      }),
    )
  })

  it('retries gemini-2.5-flash when first attempt gives error 500 on Kie.ai', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ code: 500, msg: 'Network error' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: 'Retry OK' } }],
            usage: { total_tokens: 15 },
          }),
        }),
    )

    const result = await generateGemini({
      apiKey: 'a7ec7f7854ab225cefcff91813bfa13a',
      model: 'gemini-2.5-flash',
      systemPrompt: 'Sistema',
      messages: [{ role: 'user', content: 'Oi' }],
      timeoutMs: 5000,
    })

    expect(result.text).toBe('Retry OK')
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2)
    const call1Body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)
    const call2Body = JSON.parse(vi.mocked(fetch).mock.calls[1][1]?.body as string)
    expect(call1Body.model).toBe('gemini-2.5-flash')
    expect(call2Body.model).toBe('gemini-2.5-flash')
  })

  it('strips trailing assistant messages so Gemini requests always end on user turn', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'Resposta do Gemini' }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
        }),
      }),
    )

    const result = await generateGemini({
      apiKey: 'AIzaSyTestKey12345',
      model: 'gemini-1.5-flash',
      systemPrompt: 'System prompt',
      messages: [
        { role: 'assistant', content: 'Olá, como posso ajudar?' },
        { role: 'user', content: 'Qual o horário?' },
        { role: 'assistant', content: 'Abrimos às 9h' }, // trailing assistant message
      ],
      timeoutMs: 5000,
    })

    expect(result.text).toBe('Resposta do Gemini')

    // Verify the body sent to Gemini API
    const fetchCall = vi.mocked(fetch).mock.calls[0]
    const body = JSON.parse(fetchCall[1]?.body as string)
    const contents = body.contents
    expect(contents.length).toBe(1)
    expect(contents[0].role).toBe('user')
    expect(contents[0].parts[0].text).toBe('Qual o horário?')
  })
})
