import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { sendPixMessage } from '@/lib/pix/send-pix-message';
import { type PixKeyType } from '@/lib/pix/pix-validator';

export const runtime = 'nodejs';

/**
 * POST /api/whatsapp/send-pix
 * Dispatches a native WhatsApp PIX key message with 1-click copy action.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = await request.json().catch(() => ({}));

    const conversationId = String(body.conversationId || body.conversation_id || '').trim();
    if (!conversationId) {
      return NextResponse.json({ error: 'conversationId é obrigatório' }, { status: 400 });
    }

    const customText = body.text ? String(body.text).trim() : undefined;
    const customKey = body.pixKey || body.pix_key ? String(body.pixKey || body.pix_key).trim() : undefined;
    const customType = body.pixKeyType || body.pix_key_type ? (String(body.pixKeyType || body.pix_key_type).toUpperCase() as PixKeyType) : undefined;
    const customName = body.merchantName || body.merchant_name ? String(body.merchantName || body.merchant_name).trim() : undefined;
    const customCity = body.merchantCity || body.merchant_city ? String(body.merchantCity || body.merchant_city).trim() : undefined;
    const customAmount = body.amount !== undefined && body.amount !== null && body.amount !== '' ? body.amount : undefined;
    const sendMode = (body.sendMode || body.send_mode || 'both') as 'button' | 'copia_e_cola' | 'both';

    const result = await sendPixMessage({
      accountId: ctx.accountId,
      conversationId,
      userId: ctx.userId,
      pixKey: customKey,
      pixKeyType: customType,
      merchantName: customName,
      merchantCity: customCity,
      amount: customAmount,
      text: customText,
      sendMode,
    });

    return NextResponse.json({
      success: true,
      message_id: result.dbMessageId,
      whatsapp_message_id: result.messageId,
      pix_key: result.pixKey,
      pix_key_type: result.pixKeyType,
      merchant_name: result.merchantName,
      pix_copia_e_cola: result.pixCopiaECola,
      send_mode: result.sendMode,
    });
  } catch (err: any) {
    console.error('[send-pix route] Error:', err);
    return NextResponse.json(
      { error: err?.message || 'Erro ao enviar mensagem PIX nativa.' },
      { status: 400 }
    );
  }
}
