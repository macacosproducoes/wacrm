import { NextResponse } from 'next/server';
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  getFirstPaymentConfig,
  saveFirstPaymentConfig,
  getAudioList,
  getFirstPaymentLogs,
  processFirstPaymentAutomation,
} from '@/lib/automations/first-payment-engine';

export async function GET() {
  try {
    const { accountId } = await getCurrentAccount();
    const [config, audios, logs] = await Promise.all([
      getFirstPaymentConfig(accountId),
      getAudioList(accountId),
      getFirstPaymentLogs(accountId, 50),
    ]);

    return NextResponse.json({ config, audios, logs });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  let ctx;
  try {
    ctx = await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: 'Payload JSON inválido' }, { status: 400 });
  }

  const res = await saveFirstPaymentConfig(ctx.accountId, {
    is_active: body.is_active,
    audio_id: body.audio_id,
    user_id: ctx.userId,
  });

  if (!res.success) {
    return NextResponse.json({ error: res.error }, { status: 500 });
  }

  return NextResponse.json({ config: res.config });
}

export async function PUT(request: Request) {
  let ctx;
  try {
    ctx = await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  if (!body || !body.payment_id) {
    return NextResponse.json({ error: 'payment_id é obrigatório para retry' }, { status: 400 });
  }

  const result = await processFirstPaymentAutomation({
    payment_id: body.payment_id,
    external_id: body.external_id,
    status: 'paid',
    contact_id: body.contact_id,
    account_id: ctx.accountId,
    user_id: ctx.userId,
    force_retry: true,
  });

  return NextResponse.json({ result });
}