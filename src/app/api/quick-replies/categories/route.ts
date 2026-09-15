import { NextResponse } from 'next/server';
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { getAccountCategories } from '@/lib/inbox/categories';

export async function GET() {
  try {
    const { accountId } = await getCurrentAccount();
    const categories = await getAccountCategories(accountId);
    return NextResponse.json({ categories });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  let ctx;
  try {
    ctx = await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }

  const description = typeof body.description === 'string' ? body.description.trim() : null;
  const icon = typeof body.icon === 'string' ? body.icon.trim() : 'folder';
  const color = typeof body.color === 'string' ? body.color.trim() : '#EAB308';
  const order_index = Number(body.order_index) || 0;

  try {
    const admin = supabaseAdmin();
    const { data, error } = await admin
      .from('quick_reply_categories')
      .insert({
        account_id: ctx.accountId,
        name,
        description,
        icon,
        color,
        order_index,
        is_active: true,
        is_system: false,
      })
      .select('*')
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ category: data }, { status: 201 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to create category';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
