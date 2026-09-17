import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { CreativeTemplateService } from '@/lib/creative-engine/templates';
import type { TemplateDefinition, TemplateStatus } from '@/lib/creative-engine/types';

export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole('viewer');
    const { searchParams } = new URL(request.url);

    const category = searchParams.get('category') || undefined;
    const status = (searchParams.get('status') as TemplateStatus) || undefined;
    const search = searchParams.get('search') || undefined;

    const templates = await CreativeTemplateService.listTemplates(accountId, {
      category,
      status,
      search,
    });

    return NextResponse.json({ templates });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('agent');
    const body = await request.json().catch(() => null);

    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Corpo da requisição inválido' }, { status: 400 });
    }

    const { name, description, category, type, status, definition } = body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'O nome do template é obrigatório' }, { status: 400 });
    }

    if (!definition || typeof definition !== 'object') {
      return NextResponse.json({ error: 'A definição visual do template é obrigatória' }, { status: 400 });
    }

    const template = await CreativeTemplateService.createTemplate({
      accountId,
      userId,
      name: name.trim(),
      description,
      category,
      type,
      status: status || 'DRAFT',
      definition: definition as TemplateDefinition,
    });

    return NextResponse.json({ template }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
