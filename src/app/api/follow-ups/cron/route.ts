import { NextResponse } from 'next/server';
import { processDueFollowUps } from '@/lib/automations/follow-up-engine';

export async function handleCron(request: Request) {
  // Check cron secret if configured (supports Vercel CRON_SECRET bearer token and AUTOMATION_CRON_SECRET)
  const expected = process.env.CRON_SECRET || process.env.AUTOMATION_CRON_SECRET;
  if (expected) {
    const suppliedHeader = request.headers.get('x-cron-secret') ?? '';
    const authHeader = request.headers.get('authorization') ?? '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.substring(7).trim() : '';
    const supplied = suppliedHeader || bearer;
    if (supplied !== expected) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const result = await processDueFollowUps();
  return NextResponse.json(result);
}

export async function GET(request: Request) {
  return handleCron(request);
}

export async function POST(request: Request) {
  return handleCron(request);
}

