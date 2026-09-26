import { NextRequest, NextResponse, after } from 'next/server';
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { getConversationFollowUps, scheduleManualFollowUp, processDueFollowUps } from '@/lib/automations/follow-up-engine';

export async function GET(request: NextRequest) {
  try {
    await getCurrentAccount();
    const conversationId = request.nextUrl.searchParams.get('conversationId');
    if (!conversationId) {
      return NextResponse.json({ error: 'conversationId parameter is required' }, { status: 400 });
    }

    const followUps = await getConversationFollowUps(conversationId);
    return NextResponse.json({ follow_ups: followUps });
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

  const { conversationId, contactId, responseId, scheduledAt, cancelOnClientReply, cancelOnAgentReply } = body;
  if (!conversationId || !responseId || !scheduledAt) {
    return NextResponse.json(
      { error: 'conversationId, responseId and scheduledAt are required' },
      { status: 400 }
    );
  }

  const res = await scheduleManualFollowUp({
    accountId: ctx.accountId,
    conversationId,
    contactId,
    responseId,
    scheduledAt,
    cancelOnClientReply,
    cancelOnAgentReply,
    userId: ctx.userId,
  });

  if (!res.success) {
    return NextResponse.json({ error: res.error }, { status: 500 });
  }

  // If scheduled for immediate or near-term delivery (within 60s), trigger background dispatch
  const scheduledTimeMs = new Date(scheduledAt).getTime();
  const diffMs = scheduledTimeMs - Date.now();
  if (diffMs <= 5000) {
    void processDueFollowUps().catch((err) => {
      console.warn('[follow-ups POST] Error running immediate processDueFollowUps:', err);
    });
  } else if (diffMs <= 60000) {
    after(async () => {
      await new Promise((resolve) => setTimeout(resolve, Math.max(diffMs + 500, 1000)));
      await processDueFollowUps().catch(() => {});
    });
  }

  return NextResponse.json({ follow_up: res.followUp }, { status: 201 });
}
