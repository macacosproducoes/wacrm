import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { CHAT_MEDIA_BUCKET } from '@/components/inbox/message-composer';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const formData = await request.formData();
    const file = formData.get('file');

    if (!file || !(file instanceof Blob)) {
      return NextResponse.json({ error: 'Nenhum arquivo enviado.' }, { status: 400 });
    }

    const originalName = (file as File).name || 'upload.png';
    const ext = originalName.includes('.')
      ? originalName.split('.').pop()?.toLowerCase() || 'png'
      : 'png';
    const safeBase = originalName
      .replace(/\.[^/.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 50);

    const filename = `${Date.now()}-${safeBase || 'media'}.${ext}`;
    const storagePath = `account-${ctx.accountId}/${filename}`;

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const admin = supabaseAdmin();
    const { error: uploadError } = await admin.storage
      .from(CHAT_MEDIA_BUCKET)
      .upload(storagePath, buffer, {
        contentType: file.type || 'application/octet-stream',
        upsert: false,
      });

    if (uploadError) {
      console.error('[MediaUpload] Storage upload error:', uploadError);
      return NextResponse.json({ error: uploadError.message }, { status: 500 });
    }

    const { data: publicUrlData } = admin.storage
      .from(CHAT_MEDIA_BUCKET)
      .getPublicUrl(storagePath);

    return NextResponse.json({
      success: true,
      publicUrl: publicUrlData.publicUrl,
      path: storagePath,
      filename: originalName,
    });
  } catch (err) {
    console.error('[MediaUpload] Request error:', err);
    return toErrorResponse(err);
  }
}
