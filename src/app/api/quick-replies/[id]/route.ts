import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'

// Update / delete a single quick reply. Quick replies are account-
// shared, so every mutation is scoped by `account_id` (the service-role
// client bypasses the agent-gated RLS, so both the role check and the
// account scope are enforced here).

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

  const admin = supabaseAdmin();
  const { data: existingRow, error: fetchErr } = await admin
    .from('quick_replies')
    .select('*')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle();

  if (fetchErr || !existingRow) {
    return NextResponse.json({ error: 'Quick reply not found' }, { status: 404 });
  }

  const existingMeta = ((existingRow.interactive_payload as Record<string, unknown>) || {}) as Record<string, unknown>;

  // Handle duplication action
  if (body.action === 'duplicate' || body.duplicate === true) {
    const dupTitle = body.title || `${existingRow.title} (Cópia)`;
    const dupMeta = { ...existingMeta };
    if (dupMeta.shortcut) {
      dupMeta.shortcut = `${dupMeta.shortcut}-copia`;
    }

    const { data: dupData, error: dupErr } = await admin
      .from('quick_replies')
      .insert({
        account_id: ctx.accountId,
        user_id: ctx.userId,
        title: dupTitle,
        kind: existingRow.kind,
        content_text: existingRow.content_text,
        interactive_payload: dupMeta,
      })
      .select()
      .single();

    if (dupErr) return NextResponse.json({ error: dupErr.message }, { status: 500 });
    return NextResponse.json({ ok: true, quick_reply: dupData }, { status: 201 });
  }

  const update: Record<string, unknown> = {};
  if (typeof body.title === 'string') {
    const title = body.title.trim();
    if (!title) return NextResponse.json({ error: 'title cannot be empty' }, { status: 400 });
    update.title = title;
  }

  const nextKind = body.kind ? String(body.kind).toLowerCase() : (existingMeta.type || existingRow.kind || 'text');
  const shortcut = body.shortcut !== undefined ? (body.shortcut ? String(body.shortcut).replace(/^\//, '').trim() : null) : (existingMeta.shortcut ?? null);
  const category = body.category !== undefined ? (body.category ? String(body.category).trim() : 'Geral') : (existingMeta.category ?? 'Geral');
  const color = body.color !== undefined ? String(body.color).trim() : (existingMeta.color ?? null);
  const is_favorite = body.is_favorite !== undefined ? Boolean(body.is_favorite) : (existingMeta.is_favorite ?? false);
  const order_index = body.order_index !== undefined ? Number(body.order_index) : (existingMeta.order_index ?? 0);
  const is_active = body.is_active !== undefined ? Boolean(body.is_active) : (existingMeta.is_active ?? true);
  const scope = body.scope !== undefined ? (body.scope === 'personal' ? 'personal' : 'team') : (existingMeta.scope ?? 'team');
  const sequence_items = body.sequence_items !== undefined ? body.sequence_items : (existingMeta.sequence_items ?? null);

  if (nextKind === 'interactive') {
    update.kind = 'interactive';
    const payload = body.interactive_payload ?? existingRow.interactive_payload;
    const result = validateInteractivePayload(payload);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    update.interactive_payload = {
      ...(payload as Record<string, unknown>),
      type: 'interactive',
      shortcut,
      category,
      color,
      is_favorite,
      order_index,
      is_active,
      scope,
    };
    update.content_text = null;
  } else if (nextKind === 'audio') {
    update.kind = 'text';
    const mediaUrl = body.media_url || existingMeta.media_url || existingRow.media_url;
    if (!mediaUrl) {
      return NextResponse.json({ error: 'media_url is required for audio quick replies' }, { status: 400 });
    }
    update.content_text = body.content_text || existingRow.content_text || '[Áudio Gravado]';
    update.media_url = mediaUrl;
    if (body.order_index !== undefined) update.order_index = order_index;
    if (body.shortcut !== undefined) update.shortcut = shortcut;
    if (body.category !== undefined) update.category = category;
    if (body.is_favorite !== undefined) update.is_favorite = is_favorite;
    if (body.is_active !== undefined) update.is_active = is_active;
    update.interactive_payload = {
      ...existingMeta,
      type: 'audio',
      media_url: mediaUrl,
      media_duration: body.media_duration !== undefined ? Number(body.media_duration) : (existingMeta.media_duration ?? existingRow.media_duration),
      media_type: body.media_type || existingMeta.media_type || existingRow.media_type || 'audio/ogg',
      shortcut,
      category,
      color,
      is_favorite,
      order_index,
      is_active,
      scope,
    };
  } else if (nextKind === 'image' || nextKind === 'video' || nextKind === 'document' || nextKind === 'media') {
    update.kind = 'text';
    const mediaUrl = body.media_url || existingMeta.media_url;
    if (!mediaUrl) {
      return NextResponse.json({ error: 'media_url is required for media quick replies' }, { status: 400 });
    }
    update.content_text = body.content_text !== undefined ? body.content_text : existingRow.content_text;
    update.interactive_payload = {
      ...existingMeta,
      type: nextKind === 'media' ? 'image' : nextKind,
      media_url: mediaUrl,
      media_type: body.media_type || existingMeta.media_type || (nextKind === 'video' ? 'video/mp4' : nextKind === 'document' ? 'application/pdf' : 'image/jpeg'),
      shortcut,
      category,
      color,
      is_favorite,
      order_index,
      is_active,
      scope,
    };
  } else if (nextKind === 'sequence') {
    update.kind = 'text';
    const items = Array.isArray(sequence_items) ? sequence_items : [];
    update.content_text = `[Sequência: ${items.length} mensagens]`;
    update.interactive_payload = {
      ...existingMeta,
      type: 'sequence',
      sequence_items: items,
      shortcut,
      category,
      color,
      is_favorite,
      order_index,
      is_active,
      scope,
    };
  } else {
    // text
    update.kind = 'text';
    if (body.content_text !== undefined) {
      update.content_text = body.content_text;
    }
    update.interactive_payload = {
      ...existingMeta,
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

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: true });
  }

  const { error } = await admin
    .from('quick_replies')
    .update(update)
    .eq('id', id)
    .eq('account_id', ctx.accountId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const admin = supabaseAdmin()

  // Find existing row to clean up any associated storage files
  const { data: existingRow } = await admin
    .from('quick_replies')
    .select('id, media_url, interactive_payload')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle()

  const { error } = await admin
    .from('quick_replies')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Clean up media file from storage if present in chat-media
  const mediaUrl = existingRow?.media_url || (existingRow?.interactive_payload as Record<string, unknown> | null)?.media_url
  if (typeof mediaUrl === 'string' && mediaUrl.includes('chat-media/')) {
    try {
      const parts = mediaUrl.split('chat-media/')
      if (parts[1]) {
        const cleanPath = decodeURIComponent(parts[1].split('?')[0])
        await admin.storage.from('chat-media').remove([cleanPath])
      }
    } catch (cleanErr) {
      console.warn('[quick-replies] storage cleanup notice:', cleanErr)
    }
  }

  return NextResponse.json({ ok: true })
}
