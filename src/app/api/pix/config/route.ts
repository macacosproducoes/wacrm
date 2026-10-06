import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { getPixConfig, savePixConfig } from '@/lib/pix/pix-config';
import { type PixKeyType } from '@/lib/pix/pix-validator';

export const runtime = 'nodejs';

/**
 * GET /api/pix/config
 * Retrieves the current PIX configuration for the account.
 */
export async function GET() {
  try {
    const ctx = await requireRole('agent');
    const config = await getPixConfig(ctx.accountId);
    return NextResponse.json({
      config: config || {
        pix_key: '',
        pix_key_type: 'EVP',
        pix_merchant_name: '',
      },
      is_configured: Boolean(config && config.pix_key),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/pix/config
 * Updates the PIX configuration for the account.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = await request.json().catch(() => ({}));

    const pix_key = String(body.pix_key || '').trim();
    const pix_key_type = String(body.pix_key_type || 'EVP').toUpperCase() as PixKeyType;
    const pix_merchant_name = String(body.pix_merchant_name || '').trim();
    const pix_follow_up_enabled = body.pix_follow_up_enabled !== undefined ? Boolean(body.pix_follow_up_enabled) : undefined;
    const pix_follow_up_type = body.pix_follow_up_type === 'audio' ? 'audio' : 'text';
    const pix_follow_up_quick_reply_id = body.pix_follow_up_quick_reply_id || null;
    const pix_follow_up_content = body.pix_follow_up_content ? String(body.pix_follow_up_content) : '';
    const pix_follow_up_media_url = body.pix_follow_up_media_url ? String(body.pix_follow_up_media_url) : null;
    const pix_follow_up_delay_seconds = typeof body.pix_follow_up_delay_seconds === 'number' ? Math.max(1, Math.min(60, body.pix_follow_up_delay_seconds)) : 5;

    if (!pix_key) {
      return NextResponse.json({ error: 'Chave PIX é obrigatória.' }, { status: 400 });
    }

    const res = await savePixConfig(ctx.accountId, {
      pix_key,
      pix_key_type,
      pix_merchant_name,
      pix_follow_up_enabled,
      pix_follow_up_type,
      pix_follow_up_quick_reply_id,
      pix_follow_up_content,
      pix_follow_up_media_url,
      pix_follow_up_delay_seconds,
    });

    if (!res.success) {
      return NextResponse.json({ error: res.error || 'Falha ao salvar configuração PIX.' }, { status: 400 });
    }

    return NextResponse.json({ success: true, config: res.config });
  } catch (err) {
    return toErrorResponse(err);
  }
}
