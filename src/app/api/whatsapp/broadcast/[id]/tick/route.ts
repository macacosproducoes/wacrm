import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { processBroadcastQueueTick } from '@/lib/whatsapp/broadcast-queue-engine';

export const maxDuration = 60;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { accountId } = await requireRole('agent');
    const { id: broadcastId } = await params;
    const body = await request.json().catch(() => ({}));
    const maxMessages = typeof body?.maxMessages === 'number' ? body.maxMessages : undefined;
    const forceResume = Boolean(body?.forceResume);

    const admin = supabaseAdmin();

    // Verify broadcast belongs to account
    const { data: broadcast, error: bError } = await admin
      .from('broadcasts')
      .select('id, account_id, status')
      .eq('id', broadcastId)
      .eq('account_id', accountId)
      .single();

    if (bError || !broadcast) {
      return NextResponse.json(
        { error: 'Broadcast not found or access denied.' },
        { status: 404 }
      );
    }

    const result = await processBroadcastQueueTick(admin, broadcastId, {
      maxMessagesThisTick: maxMessages,
      forceResume,
    });

    return NextResponse.json({
      success: true,
      result,
    });
  } catch (err) {
    console.error('Error in broadcast tick route:', err);
    return toErrorResponse(err);
  }
}
