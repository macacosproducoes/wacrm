import { NextResponse } from 'next/server'
import { getBuckPayTransaction } from '@/lib/buckpay'
import { processFirstPaymentAutomation } from '@/lib/automations/first-payment-engine'
import { whatsappBus } from '@/lib/whatsapp/whatsapp-bus'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const external_id = searchParams.get('external_id')

  if (!external_id) {
    return NextResponse.json({ error: 'external_id é obrigatório.' }, { status: 400 })
  }

  try {
    const result = await getBuckPayTransaction(external_id)

    if (result.error) {
      return NextResponse.json(
        { error: result.error.message, detail: result.error.detail },
        { status: 404 }
      )
    }

    if (result.data?.status === 'paid') {
      const amount = typeof result.data.total_amount === 'number' ? result.data.total_amount / 100 : undefined
      processFirstPaymentAutomation({
        payment_id: result.data.id,
        external_id,
        status: 'paid',
        amount,
        raw_payload: result.data as unknown as Record<string, unknown>,
      }).catch((err) =>
        console.error('[API /api/smm/status] Erro assíncrono na automação de primeiro pagamento:', err)
      )

      whatsappBus.emitInboxEvent({
        accountId: 'ce78c02b-49e0-43bf-b384-7cdd52f61b9f',
        eventType: 'UPDATE',
        conversation: {
          last_message_text: `🎉 PIX Compensado: R$ ${amount?.toFixed(2) || '0,00'}`,
          last_message_at: new Date().toISOString(),
        },
        message: {
          type: 'payment_received',
          payment_id: result.data.id,
          external_id,
          amount,
          status: 'paid',
        },
      })
    }

    return NextResponse.json({
      success: true,
      status: result.data?.status || 'pending',
      data: result.data,
    })
  } catch (err: any) {
    console.error('[API /api/smm/status] Error:', err)
    return NextResponse.json(
      { error: 'Erro ao consultar status da transação SMM' },
      { status: 500 }
    )
  }
}
