import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { getBaileysStatus } from '@/lib/whatsapp/baileys/baileys-manager';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { accountId } = await getCurrentAccount();
    const status = await getBaileysStatus(accountId);

    return NextResponse.json({
      success: true,
      ...status,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
