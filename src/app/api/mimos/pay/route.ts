import { NextResponse } from 'next/server'
import { createWiinPayPayment } from '@/lib/wiinpay'

function formatPhone(phone?: string): string {
  const digits = String(phone || '').replace(/\D/g, '')
  if (digits.length >= 12 && digits.startsWith('55')) return digits
  if (digits.length >= 10) return `55${digits}`
  return `55119${Math.floor(Math.random() * 90000000 + 10000000)}`
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const { amount, name, email, phone, message, split } = body

    // Validate amount (WiinPay minimum is 3.00 BRL)
    const numAmount = Number(amount)
    if (isNaN(numAmount) || numAmount < 3) {
      return NextResponse.json(
        { error: 'O valor mínimo para o Apoio VIP é R$ 3,00.' },
        { status: 400 }
      )
    }

    if (numAmount > 3000) {
      return NextResponse.json(
        { error: 'O valor máximo por transação é R$ 3.000,00.' },
        { status: 400 }
      )
    }

    // Generate unique external_id
    const cleanRandom = Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 8)
    const external_id = `apoiovip_edgar_${Date.now()}_${cleanRandom}`

    // Clean buyer data
    const rawName = (name || 'Apoiador Edgar Katsumi').trim()
    const buyerName = rawName.replace(/[^a-zA-ZÀ-ÿ\s'-]/g, ' ').replace(/\s+/g, ' ').trim() || 'Apoiador Edgar Katsumi'
    const buyerEmail = (email || `apoiador_${cleanRandom}@edgarkatsumi.com`).trim()
    const buyerPhone = formatPhone(phone)

    // Base URL for webhooks
    const appBaseUrl =
      process.env.NEXT_PUBLIC_APP_URL ||
      (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'https://wacrm-khaki-three.vercel.app')
    const webhookUrl = `${appBaseUrl.replace(/\/+$/, '')}/api/webhooks/wiinpay`

    const description = `Apoio VIP para Edgar Katsumi (${message ? 'com mensagem' : 'sem mensagem'})`

    // Call WiinPay API
    const result = await createWiinPayPayment({
      value: numAmount,
      name: buyerName,
      email: buyerEmail,
      description,
      webhook_url: webhookUrl,
      ...(split ? { split } : {}),
      metadata: {
        external_id,
        donor_name: buyerName,
        phone: buyerPhone,
        message: message || '',
      },
    })

    if (result.error) {
      return NextResponse.json(
        {
          error: result.error.message || 'Erro ao comunicar com a WiinPay',
          detail: typeof result.error.detail === 'object' ? JSON.stringify(result.error.detail) : String(result.error.detail || ''),
        },
        { status: 400 }
      )
    }

    return NextResponse.json({
      success: true,
      external_id,
      data: result.data,
      donor: {
        name: buyerName,
        message: message || '',
        amount: numAmount,
      },
    })
  } catch (err: any) {
    console.error('[API /api/mimos/pay] Unexpected error:', err)
    return NextResponse.json(
      { error: 'Falha interna ao processar o Apoio VIP via WiinPay. Tente novamente.' },
      { status: 500 }
    )
  }
}
