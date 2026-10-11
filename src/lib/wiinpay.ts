/**
 * WiinPay API Integration Service
 * Base URL: https://api-v2.wiinpay.com.br
 * Documentation: POST /payment/create Create pix Payment
 */

import QRCode from 'qrcode'

export interface WiinPaySplit {
  value?: number
  percentage?: number
  user_id: string
}

export interface CreateWiinPayPaymentInput {
  value: number // in Reais (Float/Number, minimum 3.00)
  name: string
  email: string
  description?: string
  webhook_url?: string
  split?: WiinPaySplit
  metadata?: Record<string, unknown>
}

export interface WiinPayPixData {
  code: string
  qrcode_base64?: string
  qrcode_url?: string
}

export interface WiinPayTransactionData {
  id: string
  status: 'pending' | 'paid' | 'failed' | 'expired'
  raw_status: string // 'PAID', 'PENDING', etc.
  value: number
  pix: WiinPayPixData
  created_at?: string
}

export interface WiinPayResponse {
  success?: boolean
  data?: WiinPayTransactionData
  error?: {
    message: string
    detail?: unknown
  }
}

const WIINPAY_BASE_URL = (process.env.WIINPAY_BASE_URL || 'https://api-v2.wiinpay.com.br').replace(/\/+$/, '')
const WIINPAY_API_KEY = (process.env.WIINPAY_API_KEY || process.env.WIINPAY_API_TOKEN || '').trim()

/**
 * Creates a new Pix payment transaction on WiinPay API
 */
export async function createWiinPayPayment(
  input: CreateWiinPayPaymentInput
): Promise<WiinPayResponse> {
  const url = `${WIINPAY_BASE_URL}/payment/create`

  const apiKey = (process.env.WIINPAY_API_KEY || WIINPAY_API_KEY || '').trim()

  if (!apiKey) {
    console.warn('[WiinPay API] WIINPAY_API_KEY is not defined in environment variables.')
    return {
      error: {
        message: 'Chave de API WiinPay não configurada.',
        detail: 'Configure a variável WIINPAY_API_KEY no arquivo .env.local ou na Vercel.',
      },
    }
  }

  // Minimum value is 3 reais (per WiinPay documentation)
  const finalValue = Math.max(3.0, Math.min(3000.0, Number(input.value)))

  const payload: Record<string, unknown> = {
    api_key: apiKey,
    value: Number(finalValue.toFixed(2)),
    name: input.name,
    email: input.email,
    description: input.description || 'Mimo para Edgar Katsumi',
    ...(input.webhook_url ? { webhook_url: input.webhook_url } : {}),
    ...(input.split ? { split: input.split } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  }

  try {
    console.log('[WiinPay API] Enviando requisição para:', url, {
      value: payload.value,
      name: payload.name,
      email: payload.email,
      webhook_url: payload.webhook_url,
    })

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    const resJson = await response.json().catch(() => null)

    if (!response.ok || !resJson) {
      console.warn('[WiinPay API] Erro retornado pela API:', response.status, resJson)
      return {
        error: {
          message: resJson?.message || resJson?.error || `Erro na API WiinPay (Status ${response.status})`,
          detail: resJson?.detail || resJson || 'Resposta inválida da WiinPay',
        },
      }
    }

    // Extract transaction details with flexible normalization across WiinPay response formats
    const rawData = resJson.data || resJson
    const rawId = String(rawData.id || rawData.payment_id || rawData.transaction_id || `wiin_${Date.now()}`)
    const rawStatus = String(rawData.status || resJson.status || 'PENDING').trim()
    const isPaid = rawStatus === 'PAID' || rawStatus.toLowerCase() === 'paid'

    // Extract PIX copy-and-paste code
    const pixCode = String(
      rawData.pix?.code ||
      rawData.pix_code ||
      rawData.copy_paste ||
      rawData.copia_e_cola ||
      rawData.qrcode_text ||
      rawData.emv ||
      rawData.code ||
      resJson.pix_code ||
      resJson.code ||
      ''
    ).trim()

    // Extract QR code base64 or URL
    let qrBase64 = String(
      rawData.pix?.qrcode_base64 ||
      rawData.qrcode_base64 ||
      rawData.qr_code_base64 ||
      rawData.qrcode ||
      resJson.qrcode_base64 ||
      ''
    ).trim()

    // If QR code base64 is missing but copy-and-paste code exists, generate QR code base64 automatically!
    if (!qrBase64 && pixCode) {
      try {
        const generatedDataUrl = await QRCode.toDataURL(pixCode, {
          margin: 1,
          width: 256,
          color: { dark: '#000000', light: '#ffffff' },
        })
        qrBase64 = generatedDataUrl.replace(/^data:image\/[a-z]+;base64,/, '')
      } catch (qrErr) {
        console.warn('[WiinPay API] Falha ao gerar QR code fallback:', qrErr)
      }
    }

    return {
      success: true,
      data: {
        id: rawId,
        status: isPaid ? 'paid' : 'pending',
        raw_status: rawStatus,
        value: finalValue,
        pix: {
          code: pixCode,
          qrcode_base64: qrBase64,
          qrcode_url: rawData.qrcode_url || rawData.pix?.qrcode_url,
        },
        created_at: rawData.created_at || new Date().toISOString(),
      },
    }
  } catch (err: any) {
    console.error('[WiinPay API] Falha de conexão:', err)
    return {
      error: {
        message: 'Falha de comunicação com o servidor da WiinPay.',
        detail: err?.message || 'Verifique a conexão com api-v2.wiinpay.com.br',
      },
    }
  }
}
