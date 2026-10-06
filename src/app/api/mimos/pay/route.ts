import { NextResponse } from 'next/server'
import { createBuckPayTransaction } from '@/lib/buckpay'

function generateValidCPF(): string {
  const n = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10))
  let d1 = n.reduce((total, number, index) => total + number * (10 - index), 0) % 11
  d1 = d1 < 2 ? 0 : 11 - d1
  let d2 = [...n, d1].reduce((total, number, index) => total + number * (11 - index), 0) % 11
  d2 = d2 < 2 ? 0 : 11 - d2
  return [...n, d1, d2].join('')
}

function formatPhone(phone?: string): string {
  const digits = String(phone || '').replace(/\D/g, '')
  if (digits.length >= 12 && digits.startsWith('55')) return digits
  if (digits.length >= 10) return `55${digits}`
  return `55119${Math.floor(Math.random() * 90000000 + 10000000)}`
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { amount, payment_method = 'pix', name, email, cpf, phone, message } = body

    // Validate amount
    const numAmount = Number(amount)
    if (isNaN(numAmount) || numAmount < 6) {
      return NextResponse.json(
        { error: 'O valor mínimo para o Mimo é R$ 6,00.' },
        { status: 400 }
      )
    }

    if (numAmount > 3000) {
      return NextResponse.json(
        { error: 'O valor máximo por transação é R$ 3.000,00.' },
        { status: 400 }
      )
    }

    // Amount in centavos
    const amountCents = Math.round(numAmount * 100)

    // Generate unique external_id matching BuckPay regex ^[A-Za-z0-9_-]+$
    const cleanRandom = Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 8)
    const external_id = `mimo_edgar_${Date.now()}_${cleanRandom}`

    // Clean buyer data with valid CPF and Phone format
    const buyerName = (name || 'Apoiador Anônimo').trim()
    const buyerEmail = (email || 'apoiador@edgarkatsumi.com').trim()
    
    let buyerCpf = cpf ? String(cpf).replace(/\D/g, '') : ''
    if (buyerCpf.length !== 11) {
      buyerCpf = generateValidCPF()
    }

    const buyerPhone = formatPhone(phone)

    // Call BuckPay API
    const result = await createBuckPayTransaction({
      external_id,
      payment_method: payment_method === 'card' ? 'card' : payment_method === 'boleto' ? 'boleto' : 'pix',
      amount: amountCents,
      buyer: {
        name: buyerName,
        email: buyerEmail,
        document: buyerCpf,
        phone: buyerPhone,
      },
      product: {
        name: `Mimo para Edgar Katsumi (${message ? 'com mensagem' : 'sem mensagem'})`,
      },
      ...(body.card ? { card: body.card } : {}),
    })

    if (result.error) {
      let detailMsg = ''
      if (result.error.detail) {
        if (typeof result.error.detail === 'object') {
          detailMsg = Object.entries(result.error.detail)
            .map(([key, val]) => `${key}: ${Array.isArray(val) ? val.join(', ') : val}`)
            .join(' | ')
        } else {
          detailMsg = String(result.error.detail)
        }
      }

      return NextResponse.json(
        {
          error: result.error.message || 'Erro ao comunicar com a BuckPay',
          detail: detailMsg,
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
      { error: 'Falha interna ao processar o Mimo. Tente novamente.' },
      { status: 500 }
    )
  }
}
