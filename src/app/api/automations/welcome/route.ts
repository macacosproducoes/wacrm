import { NextResponse } from 'next/server';
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { getWelcomeConfig, saveWelcomeConfig } from '@/lib/automations/welcome-engine';

export async function GET() {
  try {
    const { accountId } = await getCurrentAccount();
    const config = await getWelcomeConfig(accountId);
    return NextResponse.json({ config });
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
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const res = await saveWelcomeConfig(ctx.accountId, body);
  if (!res.success) {
    return NextResponse.json({ error: res.error }, { status: 500 });
  }

  return NextResponse.json({ config: res.config });
}
