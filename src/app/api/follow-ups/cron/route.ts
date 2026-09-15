import { NextResponse } from 'next/server';
import { processDueFollowUps } from '@/lib/automations/follow-up-engine';

export async function GET(request: Request) {
  // Check cron secret if configured
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (expected) {
    const supplied = request.headers.get('x-cron-secret') ?? '';
    if (supplied !== expected) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const result = await processDueFollowUps();
  return NextResponse.json(result);
}
