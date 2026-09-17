import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { CreativeTemplateService } from '@/lib/creative-engine/templates';

export async function GET(
  _request: Request,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const { accountId } = await requireRole('viewer');
    const params = await props.params;

    const data = await CreativeTemplateService.getTemplate(params.id, accountId);
    return NextResponse.json(data);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(
  request: Request,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const { accountId, userId } = await requireRole('agent');
    const params = await props.params;
    const body = await request.json().catch(() => null);

    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Corpo da requisição inválido' }, { status: 400 });
    }

    const updated = await CreativeTemplateService.updateTemplate(
      params.id,
      accountId,
      body,
      userId
    );

    return NextResponse.json({ template: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const { accountId } = await requireRole('admin');
    const params = await props.params;

    const archived = await CreativeTemplateService.archiveTemplate(params.id, accountId);
    return NextResponse.json({ template: archived, archived: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
