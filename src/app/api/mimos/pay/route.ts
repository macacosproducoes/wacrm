import { NextResponse } from 'next/server'
import { createBuckPayTransaction } from '@/lib/buckpay'

function generateValidCPF(): string {
  const rnd = (n: number) => Math.round(Math.random() * n)
  const mod = (dividend: number, divisor: number) =>
    Math.round(dividend - Math.floor(dividend / divisor) * divisor)
  const n = Array(9).fill(0).map(() => rnd(9))
  let d1 = n.reduce((total, number, index) => total + number * (10 - index), 0)
  d1 = 11 - mod(d1, 11)
  if (d1 >= 10) d1 = 0
  let d2 = n.reduce((total, number, index) => total + number * (11 - index), 0) + d1 * 2
  d2 = 11 - mod(d2, 11)
  if (d2 >= 10) d2 = 0
  return '' + n.join('') + d1 + d2
}

function isValidCPF(cpf: string): boolean {
  const clean = cpf.replace(/\D/g, '')
  if (clean.length !== 11 || /^(\d)\1+$/.test(clean)) return false
  let sum = 0, rest
  for (let i = 1; i <= 9; i++) sum += parseInt(clean.substring(i - 1, i)) * (11 - i)
  rest = (sum * 10) % 11
  if (rest === 10 || rest === 11) rest = 0
  if (rest !== parseInt(clean.substring(9, 10))) return false
  sum = 0
  for (let i = 1; i <= 10; i++) sum += parseInt(clean.substring(i - 1, i)) * (12 - i)
  rest = (sum * 10) % 11
  if (rest === 10 || rest === 11) rest = 0
  if (rest !== parseInt(clean.substring(10, 11))) return false
  return true
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
    if (!isValidCPF(buyerCpf)) {
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
