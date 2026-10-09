/**
 * BuckPay API Integration Service
 * Base URL: https://api.realtechdev.com.br
 */

export interface BuckPayBuyer {
  name: string
  email: string
  document?: string
  phone?: string
}

export interface BuckPayProduct {
  name: string
}

export interface BuckPayCard {
  holder_name: string
  number: string
  exp_month: number
  exp_year: number
  cvv: string
}

export interface CreateBuckPayTransactionInput {
  external_id: string
  payment_method: 'pix' | 'card' | 'boleto'
  amount: number // in centavos (600 to 300000)
  buyer?: BuckPayBuyer
  product?: BuckPayProduct
  offer?: { slug: string }
  card?: BuckPayCard
  postbackUrl?: string
}

export interface BuckPayTransactionData {
  id: string
  status: 'pending' | 'paid' | 'refused' | 'failed' | 'expired'
  payment_method: 'pix' | 'card' | 'boleto'
  pix?: {
    code: string
    qrcode_base64: string
  }
  boleto?: {
    barcode: string
    url?: string
  }
  total_amount: number
  net_amount?: number
  created_at: string
}

export interface BuckPayResponse {
  data?: BuckPayTransactionData
  error?: {
    message: string
    detail?: string | Record<string, string[]>
  }
}

const BUCKPAY_BASE_URL = process.env.BUCKPAY_BASE_URL || 'https://api.realtechdev.com.br'
const BUCKPAY_API_TOKEN = (process.env.BUCKPAY_API_TOKEN || '').trim()
const BUCKPAY_USER_AGENT = process.env.BUCKPAY_USER_AGENT || 'wacrm-edgar-katsumi/1.0'

/**
 * Creates a new payment transaction on BuckPay API
 */
export async function createBuckPayTransaction(
  input: CreateBuckPayTransactionInput
): Promise<BuckPayResponse> {
  const url = `${BUCKPAY_BASE_URL}/v1/transactions`

  // Enforce range: 600 centavos (R$ 6.00) to 300000 centavos (R$ 3.000.00)
  const amountCents = Math.max(600, Math.min(300000, Math.round(input.amount)))

  const payload = {
    external_id: input.external_id,
    payment_method: input.payment_method,
    amount: amountCents,
    buyer: input.buyer,
    product: input.product || { name: 'Mimo para Edgar Katsumi' },
    ...(input.offer ? { offer: input.offer } : {}),
    ...(input.card ? { card: input.card } : {}),
    ...(input.postbackUrl ? { postbackUrl: input.postbackUrl } : {}),
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${BUCKPAY_API_TOKEN}`,
        'User-Agent': BUCKPAY_USER_AGENT,
      },
      body: JSON.stringify(payload),
    })

    const data = await response.json()

    if (!response.ok) {
      console.warn('[BuckPay API] Transaction creation returned non-OK status:', response.status, data)
      return data.error
        ? data
        : {
            error: {
              message: `Erro na API BuckPay (${response.status})`,
              detail: data.message || data.detail || JSON.stringify(data),
            },
          }
    }

    return data
  } catch (err: any) {
    console.error('[BuckPay API] Fetch error creating transaction:', err)
    return {
      error: {
        message: 'Falha de comunicação com a BuckPay.',
        detail: err.message || 'Verifique a conexão de rede com o servidor.',
      },
    }
  }
}

/**
 * Consults transaction status by external_id
 */
export async function getBuckPayTransaction(external_id: string): Promise<BuckPayResponse> {
  const url = `${BUCKPAY_BASE_URL}/v1/transactions/external_id/${encodeURIComponent(external_id)}`

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${BUCKPAY_API_TOKEN}`,
        'User-Agent': BUCKPAY_USER_AGENT,
      },
    })

    const data = await response.json()

    if (!response.ok) {
      console.warn('[BuckPay API] Status check returned non-OK status:', response.status, data)
      return {
        error: {
          message: `Erro ao consultar transação BuckPay (${response.status})`,
          detail: data.message || data.detail || 'Transação não encontrada',
        },
      }
    }

    return data
  } catch (err: any) {
    console.error('[BuckPay API] Fetch error checking status:', err)
    return {
      error: {
        message: 'Erro de conexão ao consultar status da transação.',
        detail: err.message,
      },
    }
  }
}
