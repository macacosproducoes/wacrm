import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { CreativeTemplateService } from '@/lib/creative-engine/templates';

export async function POST(
  request: Request,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const { accountId, userId } = await requireRole('agent');
    const params = await props.params;
    const body = await request.json().catch(() => ({}));

    const duplicate = await CreativeTemplateService.duplicateTemplate(
      params.id,
      accountId,
      body?.name,
      userId
    );

    return NextResponse.json({ template: duplicate }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
