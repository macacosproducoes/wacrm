import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let ctx;
  try {
    ctx = await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (typeof body.name === 'string' && body.name.trim()) updates.name = body.name.trim();
  if (body.description !== undefined) updates.description = body.description ? String(body.description).trim() : null;
  if (typeof body.icon === 'string') updates.icon = body.icon.trim();
  if (typeof body.color === 'string') updates.color = body.color.trim();
  if (typeof body.order_index === 'number') updates.order_index = body.order_index;
  if (typeof body.is_active === 'boolean') updates.is_active = body.is_active;

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from('quick_reply_categories')
    .update(updates)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('*')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ category: data });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let ctx;
  try {
    ctx = await requireRole('admin');
  } catch (err) {
    return toErrorResponse(err);
  }

  const { id } = await params;
  const admin = supabaseAdmin();

  // Prevent deleting system categories
  const { data: cat } = await admin
    .from('quick_reply_categories')
    .select('is_system')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .single();

  if (cat?.is_system) {
    return NextResponse.json(
      { error: 'Categorias do sistema não podem ser excluídas.' },
      { status: 400 }
    );
  }

  const { error } = await admin
    .from('quick_reply_categories')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
