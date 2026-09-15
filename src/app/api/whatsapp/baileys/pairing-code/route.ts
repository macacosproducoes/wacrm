import { NextRequest, NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { requestBaileysPairingCode } from '@/lib/whatsapp/baileys/baileys-manager';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { accountId } = await requireRole('admin');
    const body = await req.json().catch(() => ({}));
    const phoneNumber = body.phoneNumber as string;

    if (!phoneNumber) {
      return NextResponse.json(
        { success: false, error: 'Número de telefone não informado' },
        { status: 400 }
      );
    }

    const result = await requestBaileysPairingCode(accountId, phoneNumber);

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error || 'Falha ao solicitar código' },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      pairingCode: result.pairingCode,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
