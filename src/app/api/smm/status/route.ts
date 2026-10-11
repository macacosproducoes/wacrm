import { NextResponse } from 'next/server'
import { getBuckPayTransaction } from '@/lib/buckpay'
import { processFirstPaymentAutomation } from '@/lib/automations/first-payment-engine'

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
      processFirstPaymentAutomation({
        payment_id: result.data.id,
        external_id,
        status: 'paid',
        amount: typeof result.data.total_amount === 'number' ? result.data.total_amount / 100 : undefined,
        raw_payload: result.data as unknown as Record<string, unknown>,
      }).catch((err) =>
        console.error('[API /api/smm/status] Erro assíncrono na automação de primeiro pagamento:', err)
      )
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
