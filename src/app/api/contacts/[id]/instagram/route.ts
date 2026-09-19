import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { InstagramProfileResolver } from '@/lib/instagram-resolver';
import { parseInstagramUsername, buildInstagramProfileUrl } from '@/lib/instagram-resolver/parser';
import { getInstagramDiagnosticInfo } from '@/lib/instagram-resolver/types';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const ctx = await requireRole('agent');
    const { id: contactId } = await context.params;

    const admin = supabaseAdmin();
    const { data: contact, error } = await admin
      .from('contacts')
      .select(`
        id,
        name,
        phone,
        instagram_username,
        instagram_url,
        profile_image_url,
        profile_image_source,
        profile_image_updated_at,
        profile_image_hash,
        instagram_resolve_status,
        instagram_last_error,
        instagram_attempt_count,
        instagram_last_attempt_at,
        avatar_url
      `)
      .eq('id', contactId)
      .eq('account_id', ctx.accountId)
      .single();

    if (error || !contact) {
      return NextResponse.json({ error: 'Contato não encontrado.' }, { status: 404 });
    }

    const diagnostic = getInstagramDiagnosticInfo(contact);

    return NextResponse.json({
      success: true,
      instagram: {
        username: contact.instagram_username || null,
        url: contact.instagram_url || (contact.instagram_username ? buildInstagramProfileUrl(contact.instagram_username) : null),
        profile_image_url: contact.profile_image_url || null, // STRICTLY separate from WhatsApp avatar_url
        profile_image_source: contact.profile_image_source || 'INSTAGRAM_PROVIDER',
        profile_image_updated_at: contact.profile_image_updated_at || null,
        profile_image_hash: contact.profile_image_hash || null,
        status: contact.instagram_resolve_status || 'NOT_REQUESTED',
        last_error: contact.instagram_last_error || null,
        attempt_count: contact.instagram_attempt_count || 0,
        last_attempt_at: contact.instagram_last_attempt_at || null,
        diagnostic,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const ctx = await requireRole('agent');
    const { id: contactId } = await context.params;

    const contentType = request.headers.get('content-type') || '';
    let action = 'resolve';
    let forceRefresh = false;
    let username: string | undefined;
    let imageUrl: string | undefined;
    let imageBuffer: Buffer | undefined;

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      action = String(formData.get('action') || 'set_manual_photo');
      const file = formData.get('file');
      if (file && file instanceof Blob) {
        const arrayBuf = await file.arrayBuffer();
        imageBuffer = Buffer.from(arrayBuf);
      }
    } else {
      const body = await request.json().catch(() => ({}));
      action = body.action || 'resolve';
      forceRefresh = Boolean(body.forceRefresh);
      username = body.username;
      imageUrl = body.imageUrl;

      if (body.imageBase64) {
        const base64Data = body.imageBase64.replace(/^data:image\/\w+;base64,/, '');
        imageBuffer = Buffer.from(base64Data, 'base64');
      }
    }

    const admin = supabaseAdmin();

    // 1. Update username first if provided
    if (username !== undefined) {
      const parsed = parseInstagramUsername(username);
      const url = parsed ? buildInstagramProfileUrl(parsed) : null;
      await admin
        .from('contacts')
        .update({
          instagram_username: parsed || null,
          instagram_url: url,
        })
        .eq('id', contactId)
        .eq('account_id', ctx.accountId);
    }

    // 2. Action: Set Manual Photo
    if (action === 'set_manual_photo') {
      if (!imageBuffer && !imageUrl) {
        return NextResponse.json(
          { error: 'Envie um arquivo ou URL da imagem.' },
          { status: 400 }
        );
      }

      const result = await InstagramProfileResolver.setManualPhoto(
        ctx.accountId,
        contactId,
        imageBuffer || imageUrl!
      );

      return NextResponse.json({ success: true, result });
    }

    // 3. Action: Resolve Profile
    const result = await InstagramProfileResolver.resolveContact(
      ctx.accountId,
      contactId,
      { forceRefresh }
    );

    return NextResponse.json({ success: true, result });
  } catch (err) {
    console.error('[Instagram API Route Error]:', err);
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const ctx = await requireRole('agent');
    const { id: contactId } = await context.params;

    await InstagramProfileResolver.removePhoto(ctx.accountId, contactId);

    return NextResponse.json({ success: true, message: 'Foto do perfil removida com sucesso.' });
  } catch (err) {
    return toErrorResponse(err);
  }
}
