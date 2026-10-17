import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { processFirstPaymentAutomation } from '@/lib/automations/first-payment-engine'

function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createAdminClient(url, key)
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const external_id = searchParams.get('external_id')

  if (!external_id) {
    return NextResponse.json({ error: 'external_id é obrigatório.' }, { status: 400, headers: CORS_HEADERS })
  }

  try {
    const admin = supabaseAdmin()
    if (!admin) {
      return NextResponse.json({
        success: true,
        status: 'pending',
      }, { headers: CORS_HEADERS })
    }

    // Check webhook_events to see if a PAID webhook arrived for this transaction
    const { data: events } = await admin
      .from('webhook_events')
      .select('id, payload, processing_status, created_at')
      .eq('provider', 'wiinpay')
      .order('created_at', { ascending: false })
      .limit(20)

    if (events && events.length > 0) {
      const match = events.find((ev) => {
        const payload = (ev.payload || {}) as Record<string, any>
        const meta = payload.metadata || {}
        return (
          payload.id === external_id ||
          payload.external_id === external_id ||
          meta.external_id === external_id
        )
      })

      if (match) {
        const p = (match.payload || {}) as Record<string, any>
        const rawStatus = String(p.status || '').trim()
        const isPaid = rawStatus === 'PAID' || rawStatus.toLowerCase() === 'paid' || match.processing_status === 'COMPLETED'

        if (isPaid) {
          if (match.processing_status !== 'COMPLETED') {
            await admin
              .from('webhook_events')
              .update({ processing_status: 'COMPLETED' })
              .eq('id', match.id)

            processFirstPaymentAutomation({
              payment_id: String(p.id || external_id),
              external_id,
              status: 'paid',
              amount: typeof p.value === 'number' ? p.value : typeof p.amount === 'number' ? p.amount : undefined,
              buyer: {
                name: p.name || p.metadata?.donor_name,
                email: p.email,
                phone: p.phone,
              },
              raw_payload: (match.payload || {}) as Record<string, unknown>,
            }).catch((err) =>
              console.error('[API /api/mimos/status] Erro na automação de primeiro pagamento:', err)
            );
          }

          return NextResponse.json({
            success: true,
            status: 'paid',
            data: match.payload,
          }, { headers: CORS_HEADERS });
        }
      }
    }

    // Still waiting for payment confirmation
    return NextResponse.json({
      success: true,
      status: 'pending',
    }, { headers: CORS_HEADERS })
  } catch (err: any) {
    console.error('[API /api/mimos/status] Error:', err)
    return NextResponse.json(
      { error: 'Erro ao consultar status da transação' },
      { status: 500, headers: CORS_HEADERS }
    )
  }
}
