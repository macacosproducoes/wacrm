import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  loadActivity,
  loadConversationsSeries,
  loadMetrics,
  loadPipelineDonut,
  loadResponseTime,
} from '@/lib/dashboard/queries';

export async function GET(request: Request) {
  try {
    await requireRole('viewer');
    const url = new URL(request.url);
    const rangeParam = Number(url.searchParams.get('range') || '30');
    const rangeDays = [7, 30, 90].includes(rangeParam) ? rangeParam : 30;

    const db = supabaseAdmin();

    const [metrics, series, pipeline, responseTime, activity] = await Promise.all([
      loadMetrics(db).catch((err) => {
        console.error('[dashboard/summary] loadMetrics error:', err);
        return null;
      }),
      loadConversationsSeries(db, rangeDays).catch((err) => {
        console.error('[dashboard/summary] loadConversationsSeries error:', err);
        return [];
      }),
      loadPipelineDonut(db).catch((err) => {
        console.error('[dashboard/summary] loadPipelineDonut error:', err);
        return null;
      }),
      loadResponseTime(db).catch((err) => {
        console.error('[dashboard/summary] loadResponseTime error:', err);
        return null;
      }),
      loadActivity(db, 50).catch((err) => {
        console.error('[dashboard/summary] loadActivity error:', err);
        return [];
      }),
    ]);

    return NextResponse.json({
      metrics,
      series,
      pipeline,
      responseTime,
      activity,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
