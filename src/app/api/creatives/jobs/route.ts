import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { CreativeJobManager } from '@/lib/creative-engine/jobs';
import type { JobStatus } from '@/lib/creative-engine/types';

export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole('viewer');
    const { searchParams } = new URL(request.url);

    const status = (searchParams.get('status') as JobStatus) || undefined;
    const sourceType = searchParams.get('source_type') || undefined;
    const limit = searchParams.get('limit') ? Number(searchParams.get('limit')) : 50;

    const jobs = await CreativeJobManager.listJobs(accountId, {
      status,
      sourceType,
      limit,
    });

    return NextResponse.json({ jobs });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { accountId } = await requireRole('agent');
    const body = await request.json().catch(() => null);

    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Corpo da requisição inválido' }, { status: 400 });
    }

    const {
      template_id,
      template_version,
      source_type = 'MANUAL',
      source_id = `req_${Date.now()}`,
      creative_type = 'default',
      input_data = {},
      force_regenerate = false,
      deliver = false,
      delivery_options,
    } = body;

    if (!template_id) {
      return NextResponse.json({ error: 'template_id é obrigatório' }, { status: 400 });
    }

    const job = await CreativeJobManager.processJob({
      accountId,
      templateId: template_id,
      templateVersion: template_version ? Number(template_version) : undefined,
      sourceType: source_type,
      sourceId: String(source_id),
      creativeType: creative_type,
      inputData: input_data,
      forceRegenerate: Boolean(force_regenerate),
      deliver: Boolean(deliver),
      deliveryOptions: delivery_options,
    });

    return NextResponse.json({ job }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
