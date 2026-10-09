import { NextResponse } from 'next/server'
import { getBuckPayTransaction } from '@/lib/buckpay'

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
