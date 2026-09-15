import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { disconnectBaileys } from '@/lib/whatsapp/baileys/baileys-manager';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const { accountId } = await requireRole('admin');
    await disconnectBaileys(accountId);

    return NextResponse.json({
      success: true,
      message: 'WhatsApp desconectado com sucesso',
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
