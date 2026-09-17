import { NextResponse } from 'next/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { CreativeJobManager } from '@/lib/creative-engine/jobs';
import type { CreativeJob } from '@/lib/creative-engine/types';

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Supabase credentials missing.');
  }
  return createSupabaseClient(url, key);
}

export async function POST(
  request: Request,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const { accountId } = await requireRole('agent');
    const params = await props.params;
    const body = await request.json().catch(() => ({}));

    const { recipient, channel = 'whatsapp', caption } = body;

    if (!recipient) {
      return NextResponse.json({ error: 'recipient (destinatário) é obrigatório' }, { status: 400 });
    }

    const supabase = getAdminClient();
    const { data: job, error: jobErr } = await supabase
      .from('creative_jobs')
      .select('*')
      .eq('id', params.id)
      .eq('account_id', accountId)
      .single();

    if (jobErr || !job) {
      return NextResponse.json({ error: 'Job não encontrado ou não autorizado' }, { status: 404 });
    }

    const result = await CreativeJobManager.deliverJob(job as CreativeJob, {
      recipient,
      channel,
      caption,
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error || 'Falha na entrega do criativo' }, { status: 500 });
    }

    return NextResponse.json({ success: true, result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
