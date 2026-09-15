import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';

/**
 * POST /api/quick-replies/[id]/use
 * Increments the usage counter for a quick reply.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let ctx;
  try {
    ctx = await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const { id } = await params;
  const admin = supabaseAdmin();

  try {
    // Try increment RPC first
    const { error: rpcErr } = await admin.rpc('increment_quick_reply_usage', { p_id: id });
    if (rpcErr) {
      // Fallback: select + update
      const { data: row } = await admin
        .from('quick_replies')
        .select('usage_count, interactive_payload')
        .eq('id', id)
        .eq('account_id', ctx.accountId)
        .maybeSingle();

      if (row) {
        const nextCount = (row.usage_count || 0) + 1;
        const meta = ((row.interactive_payload as Record<string, unknown>) || {}) as Record<string, unknown>;
        await admin
          .from('quick_replies')
          .update({
            usage_count: nextCount,
            interactive_payload: { ...meta, usage_count: nextCount },
          })
          .eq('id', id);
      }
    }

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to record usage';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
