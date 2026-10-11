import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createAdminClient(url, key)
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const external_id = searchParams.get('external_id')

  if (!external_id) {
    return NextResponse.json({ error: 'external_id é obrigatório.' }, { status: 400 })
  }

  try {
    const admin = supabaseAdmin()
    if (!admin) {
      return NextResponse.json({
        success: true,
        status: 'pending',
      })
    }

    // Check webhook_events to see if a PAID webhook arrived for this transaction
    const { data: events, error } = await admin
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
          return NextResponse.json({
            success: true,
            status: 'paid',
            data: match.payload,
          })
        }
      }
    }

    // Still waiting for payment confirmation
    return NextResponse.json({
      success: true,
      status: 'pending',
    })
  } catch (err: any) {
    console.error('[API /api/mimos/status] Error:', err)
    return NextResponse.json(
      { error: 'Erro ao consultar status da transação' },
      { status: 500 }
    )
  }
}
