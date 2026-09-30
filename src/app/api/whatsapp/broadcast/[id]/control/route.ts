import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  pauseBroadcast,
  resumeBroadcast,
  cancelBroadcast,
  processBroadcastQueueTick,
  logBroadcastEvent,
} from '@/lib/whatsapp/broadcast-queue-engine';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { accountId, userId } = await requireRole('agent');
    const { id: broadcastId } = await params;
    const body = await request.json().catch(() => ({}));
    const action = body?.action as 'start' | 'pause' | 'resume' | 'cancel';
    const reason = body?.reason as string | undefined;

    if (!['start', 'pause', 'resume', 'cancel'].includes(action)) {
      return NextResponse.json(
        { error: 'Invalid action. Must be start, pause, resume, or cancel.' },
        { status: 400 }
      );
    }

    const admin = supabaseAdmin();

    // Verify broadcast belongs to account
    const { data: broadcast, error: bError } = await admin
      .from('broadcasts')
      .select('*')
      .eq('id', broadcastId)
      .eq('account_id', accountId)
      .single();

    if (bError || !broadcast) {
      return NextResponse.json(
        { error: 'Broadcast not found or access denied.' },
        { status: 404 }
      );
    }

    switch (action) {
      case 'pause':
        await pauseBroadcast(
          admin,
          broadcastId,
          reason || 'Pausado manualmente pelo usuário',
          accountId
        );
        break;

      case 'resume':
        await resumeBroadcast(admin, broadcastId, accountId);
        // Trigger a background tick immediately upon resuming
        processBroadcastQueueTick(admin, broadcastId).catch((err) => {
          console.error('[broadcast control] tick error on resume:', err);
        });
        break;

      case 'cancel':
        await cancelBroadcast(
          admin,
          broadcastId,
          reason || 'Cancelado pelo usuário',
          accountId
        );
        break;

      case 'start':
        await admin
          .from('broadcasts')
          .update({
            status: 'sending',
            paused_reason: null,
            consecutive_failures: 0,
            updated_at: new Date().toISOString(),
          })
          .eq('id', broadcastId);

        await logBroadcastEvent(
          admin,
          broadcastId,
          accountId,
          'started',
          'Campanha iniciada pelo usuário.',
          { userId }
        );

        // Kick off queue tick
        processBroadcastQueueTick(admin, broadcastId).catch((err) => {
          console.error('[broadcast control] tick error on start:', err);
        });
        break;
    }

    const { data: updated } = await admin
      .from('broadcasts')
      .select('status, paused_reason, next_run_at')
      .eq('id', broadcastId)
      .single();

    return NextResponse.json({
      success: true,
      broadcastId,
      action,
      broadcast: updated,
    });
  } catch (err) {
    console.error('Error in broadcast control route:', err);
    return toErrorResponse(err);
  }
}
