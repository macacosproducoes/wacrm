import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { event, data } = body

    console.log(`[BuckPay Webhook Received] Event: ${event}`, {
      transaction_id: data?.id,
      external_id: data?.external_id,
      status: data?.status,
      amount: data?.total_amount,
    })

    if (event === 'transaction.processed') {
      console.log(`🎉 [BuckPay Webhook] Mimo confirmado e pago! Transação ID: ${data?.id}`)
      // Here real application logic, DB recording or notification triggers can happen
    } else if (event === 'transaction.created') {
      console.log(`ℹ️ [BuckPay Webhook] Transação de Mimo criada: ${data?.id}`)
    }

    return NextResponse.json({ received: true, event }, { status: 200 })
  } catch (err: any) {
    console.error('[BuckPay Webhook Error]:', err)
    return NextResponse.json({ error: 'Formato de webhook inválido' }, { status: 400 })
  }
}
