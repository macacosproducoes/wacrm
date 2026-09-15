import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { connectBaileys } from '@/lib/whatsapp/baileys/baileys-manager';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const { accountId } = await requireRole('admin');
    const result = await connectBaileys(accountId);

    if (result.status === 'disconnected' && result.error) {
      return NextResponse.json(
        {
          success: false,
          error: result.error,
          ...result,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
