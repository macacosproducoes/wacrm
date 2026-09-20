import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'

import { getDefaultColorForKind } from '@/lib/inbox/quick-reply-colors'

// Quick replies — reusable snippets (plain text or a saved interactive
// message) shared across the account. GET lists; POST creates. Mirrors
// the automations route: RLS-scoped read via the user client, service-
// role write after an explicit role check.


function normalizeQuickReply(row: Record<string, unknown>) {
  const meta = ((row.interactive_payload as Record<string, unknown>) || {}) as Record<string, unknown>;
  const effectiveKind = (meta.type as string) || (row.kind as string) || 'text';
  const defaultColor = getDefaultColorForKind(effectiveKind);

  return {
    id: row.id,
    account_id: row.account_id,
    user_id: row.user_id,
    title: row.title,
    kind: effectiveKind,
    shortcut: (row.shortcut as string) || (meta.shortcut as string) || null,
    category: (row.category as string) || (meta.category as string) || (effectiveKind === 'audio' ? 'Áudios' : 'Geral'),
    category_id: (row.category_id as string) || null,
    color: (row.color as string) || (meta.color as string) || defaultColor,
    content_text: row.content_text,
    media_url: (row.media_url as string) || (meta.media_url as string) || null,
    media_type: (row.media_type as string) || (meta.media_type as string) || null,
    media_duration: (row.media_duration as number) || (meta.media_duration as number) || null,
    is_favorite: Boolean(row.is_favorite ?? meta.is_favorite ?? false),
    order_index: Number(row.order_index ?? meta.order_index ?? 0),
    usage_count: Number(row.usage_count ?? meta.usage_count ?? 0),
    is_active: Boolean(row.is_active ?? meta.is_active ?? true),
    scope: ((row.scope as string) || (meta.scope as string) || 'team') as 'team' | 'personal',
    sequence_items: (row.sequence_items as unknown[]) || (meta.sequence_items as unknown[]) || null,
    interactive_payload: row.kind === 'interactive' ? row.interactive_payload : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function GET() {
  try {
    const { supabase } = await getCurrentAccount();
    const { data, error } = await supabase
      .from('quick_replies')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    
    const normalized = (data ?? []).map(normalizeQuickReply);

    // Sort by: favorites first, then custom order, then newest
    normalized.sort((a, b) => {
      if (a.is_favorite !== b.is_favorite) {
        return a.is_favorite ? -1 : 1;
      }
      if (a.order_index !== b.order_index) {
        return a.order_index - b.order_index;
      }
      return new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime();
    });

    return NextResponse.json({ quick_replies: normalized });
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
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const kind = String(body.kind || 'text').toLowerCase();
  if (!title) {
    return NextResponse.json({ error: 'title is required' }, { status: 400 });
  }

  const shortcut = body.shortcut ? String(body.shortcut).replace(/^\//, '').trim() : null;
  const category = body.category ? String(body.category).trim() : (kind === 'audio' ? 'Áudios' : 'Geral');
  const color = body.color ? String(body.color).trim() : getDefaultColorForKind(kind);
  const is_favorite = Boolean(body.is_favorite);
  const order_index = Number(body.order_index) || 0;
  const is_active = body.is_active !== undefined ? Boolean(body.is_active) : true;
  const scope = body.scope === 'personal' ? 'personal' : 'team';

  let content_text: string | null = null;
  let interactive_payload: Record<string, unknown> | null = null;
  const dbKind: 'text' | 'interactive' = kind === 'interactive' ? 'interactive' : 'text';

  if (kind === 'interactive') {
    const result = validateInteractivePayload(body.interactive_payload);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    interactive_payload = {
      ...(body.interactive_payload as Record<string, unknown>),
      type: 'interactive',
      shortcut,
      category,
      color,
      is_favorite,
      order_index,
      is_active,
      scope,
    };
  } else if (kind === 'audio') {
    if (!body.media_url) {
      return NextResponse.json({ error: 'media_url is required for audio quick replies' }, { status: 400 });
    }
    content_text = typeof body.content_text === 'string' && body.content_text.trim()
      ? body.content_text
      : '[Áudio Gravado]';
    interactive_payload = {
      type: 'audio',
      media_url: body.media_url,
      media_type: body.media_type || 'audio/ogg',
      media_duration: Number(body.media_duration) || 0,
      shortcut,
      category,
      color,
      file_name: body.file_name || 'audio.ogg',
      is_favorite,
      order_index,
      is_active,
      scope,
    };
  } else if (kind === 'image' || kind === 'video' || kind === 'document' || kind === 'media') {
    if (!body.media_url) {
      return NextResponse.json({ error: 'media_url is required for media quick replies' }, { status: 400 });
    }
    content_text = typeof body.content_text === 'string' ? body.content_text : '';
    interactive_payload = {
      type: kind === 'media' ? 'image' : kind,
      media_url: body.media_url,
      media_type: body.media_type || (kind === 'video' ? 'video/mp4' : kind === 'document' ? 'application/pdf' : 'image/jpeg'),
      shortcut,
      category,
      color,
      file_name: body.file_name,
      is_favorite,
      order_index,
      is_active,
      scope,
    };
  } else if (kind === 'sequence') {
    const sequenceItems = Array.isArray(body.sequence_items) ? body.sequence_items : [];
    if (sequenceItems.length === 0) {
      return NextResponse.json({ error: 'sequence_items is required for sequence quick replies' }, { status: 400 });
    }
    content_text = `[Sequência: ${sequenceItems.length} mensagens]`;
    interactive_payload = {
      type: 'sequence',
      sequence_items: sequenceItems,
      shortcut,
      category,
      color,
      is_favorite,
      order_index,
      is_active,
      scope,
    };
  } else {
    const text = typeof body.content_text === 'string' ? body.content_text : '';
    if (!text.trim()) {
      return NextResponse.json(
        { error: 'content_text is required for text quick replies' },
        { status: 400 },
      );
    }
    content_text = text;
    interactive_payload = {
      type: 'text',
      shortcut,
      category,
      color,
      is_favorite,
      order_index,
      is_active,
      scope,
    };
  }

  const { data, error } = await supabaseAdmin()
    .from('quick_replies')
    .insert({
      account_id: ctx.accountId,
      user_id: ctx.userId,
      title,
      kind: dbKind,
      content_text,
      interactive_payload,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ quick_reply: normalizeQuickReply(data) }, { status: 201 });
}

export async function PUT(request: Request) {
  let ctx;
  try {
    ctx = await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

  const admin = supabaseAdmin();
  let updates: Array<{ id: string; order_index: number }> = [];

  if (Array.isArray(body.orders)) {
    updates = body.orders;
  } else if (Array.isArray(body.ids)) {
    updates = body.ids.map((id: string, idx: number) => ({ id, order_index: idx }));
  }

  if (updates.length === 0) {
    return NextResponse.json({ ok: true });
  }

  await Promise.all(
    updates.map(({ id, order_index }) =>
      admin
        .from('quick_replies')
        .update({ order_index: Number(order_index) })
        .eq('id', id)
        .eq('account_id', ctx.accountId)
    )
  );

  return NextResponse.json({ ok: true, reordered: updates.length });
}

