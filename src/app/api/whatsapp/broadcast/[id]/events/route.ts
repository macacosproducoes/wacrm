import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { accountId } = await requireRole('viewer');
    const { id: broadcastId } = await params;

    const admin = supabaseAdmin();

    const { data: events, error } = await admin
      .from('broadcast_events')
      .select('*')
      .eq('broadcast_id', broadcastId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      events: events ?? [],
    });
  } catch (err) {
    console.error('Error in broadcast events route:', err);
    return toErrorResponse(err);
  }
}
