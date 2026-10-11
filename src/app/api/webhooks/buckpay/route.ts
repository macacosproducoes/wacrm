import { NextResponse } from 'next/server'
import { processFirstPaymentAutomation } from '@/lib/automations/first-payment-engine'

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

    if (event === 'transaction.processed' || data?.status === 'paid') {
      console.log(`🎉 [BuckPay Webhook] Pagamento confirmado! Transação ID: ${data?.id}`)
      
      const automationResult = await processFirstPaymentAutomation({
        payment_id: data?.id,
        external_id: data?.external_id,
        status: data?.status || 'paid',
        amount: typeof data?.total_amount === 'number' ? data.total_amount / 100 : undefined,
        buyer: data?.buyer,
        raw_payload: body,
      })

      console.log('[BuckPay Webhook] Resultado automação primeiro pagamento:', automationResult)
    } else if (event === 'transaction.created') {
      console.log(`ℹ️ [BuckPay Webhook] Transação criada: ${data?.id}`)
    }

    return NextResponse.json({ received: true, event }, { status: 200 })
  } catch (err: any) {
    console.error('[BuckPay Webhook Error]:', err)
    return NextResponse.json({ error: 'Formato de webhook inválido' }, { status: 400 })
  }
}
