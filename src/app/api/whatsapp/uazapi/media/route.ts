import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { normalizeBaseUrl } from '@/lib/whatsapp/uazapi-client';

function getAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const messageId = searchParams.get('messageId');

    if (!messageId) {
      return NextResponse.json({ error: 'messageId is required' }, { status: 400 });
    }

    const admin = getAdminClient();

    // 1. Find message by message_id or id safely (avoid invalid uuid cast error)
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId);
    let msgQuery = admin.from('messages').select('id, conversation_id, message_id, content_type, media_url');
    if (isUuid) {
      msgQuery = msgQuery.or(`id.eq.${messageId},message_id.eq.${messageId}`);
    } else {
      msgQuery = msgQuery.eq('message_id', messageId);
    }
    const { data: message, error: msgErr } = await msgQuery.maybeSingle();

    if (msgErr) {
      console.warn('[UazAPI Media] Message lookup error:', msgErr);
    }

    if (!message) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    // If media_url is already a decrypted, accessible URL (not raw encrypted mmg.whatsapp.net)
    if (message.media_url && !message.media_url.includes('mmg.whatsapp.net') && !message.media_url.includes('.enc')) {
      try {
        const fileRes = await fetch(message.media_url);
        if (fileRes.ok) {
          const contentType = fileRes.headers.get('content-type') || 'image/jpeg';
          const buffer = await fileRes.arrayBuffer();
          return new Response(buffer, {
            status: 200,
            headers: {
              'Content-Type': contentType,
              'Cache-Control': 'public, max-age=604800, immutable',
              'Access-Control-Allow-Origin': '*',
            },
          });
        }
      } catch (proxyErr) {
        console.warn('[UazAPI Media] Direct fetch of existing media_url failed:', proxyErr);
      }
      return NextResponse.redirect(message.media_url, 302);
    }

    // 2. Resolve account WhatsApp connection
    const { data: conv } = await admin
      .from('conversations')
      .select('account_id')
      .eq('id', message.conversation_id)
      .maybeSingle();

    const accountId = conv?.account_id;
    let connQuery = admin.from('whatsapp_connections').select('*').eq('provider', 'uazapi');
    if (accountId) {
      connQuery = connQuery.eq('account_id', accountId);
    }
    const { data: connections } = await connQuery;
    const activeConn = connections?.find((c) => c.status === 'connected') || connections?.[0];

    if (!activeConn) {
      return NextResponse.json({ error: 'Active WhatsApp connection not found' }, { status: 404 });
    }

    const tokenEnc = activeConn.provider_config?.token || activeConn.encrypted_access_token;
    if (!tokenEnc) {
      return NextResponse.json({ error: 'WhatsApp token missing' }, { status: 500 });
    }

    let token: string;
    try {
      token = decrypt(tokenEnc);
    } catch (decErr) {
      console.error('[UazAPI Media] Failed to decrypt token:', decErr);
      return NextResponse.json({ error: 'Failed to decrypt credentials' }, { status: 500 });
    }

    const baseUrl = normalizeBaseUrl(activeConn.provider_config?.base_url || activeConn.api_url);
    const targetMsgId = message.message_id || messageId;

    // 3. Call UazAPI /message/download (request public fileURL and base64 fallback)
    const dlRes = await fetch(`${baseUrl}/message/download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        token,
      },
      body: JSON.stringify({
        id: targetMsgId,
        return_link: true,
        return_base64: true,
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!dlRes.ok) {
      console.warn('[UazAPI Media] Download endpoint responded with status:', dlRes.status);
      if (message.media_url) {
        return NextResponse.redirect(message.media_url, 302);
      }
      return NextResponse.json({ error: 'Failed to download media from instance' }, { status: 502 });
    }

    const dlData = await dlRes.json().catch(() => null);

    // If a public fileURL was generated
    if (dlData?.fileURL) {
      const publicUrl = String(dlData.fileURL);
      const mime = dlData.mimetype || 'image/jpeg';
      // Persist the resolved public URL so subsequent requests hit it directly
      await admin
        .from('messages')
        .update({
          media_url: publicUrl,
          content_type: mime.startsWith('image/') ? 'image' : message.content_type || 'image',
        })
        .eq('id', message.id);

      // Stream the decrypted bytes directly to avoid cross-origin CORS blocks in browser
      try {
        const imageRes = await fetch(publicUrl);
        if (imageRes.ok) {
          const contentType = imageRes.headers.get('content-type') || mime;
          const buffer = await imageRes.arrayBuffer();
          return new Response(buffer, {
            status: 200,
            headers: {
              'Content-Type': contentType,
              'Cache-Control': 'public, max-age=604800, immutable',
              'Access-Control-Allow-Origin': '*',
            },
          });
        }
      } catch (fetchErr) {
        console.warn('[UazAPI Media] Failed to stream publicUrl bytes:', fetchErr);
      }

      return NextResponse.redirect(publicUrl, 302);
    }

    // If base64Data was returned directly
    if (dlData?.base64Data) {
      const mime = dlData.mimetype || 'image/jpeg';
      const cleanB64 = String(dlData.base64Data).replace(/^data:[^;]+;base64,/, '');
      const buffer = Buffer.from(cleanB64, 'base64');

      void admin
        .from('messages')
        .update({
          media_url: `data:${mime};base64,${cleanB64}`,
          content_type: mime.startsWith('image/') ? 'image' : message.content_type,
        })
        .eq('id', message.id);

      return new Response(buffer, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Cache-Control': 'public, max-age=604800, immutable',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    if (message.media_url) {
      return NextResponse.redirect(message.media_url, 302);
    }

    return NextResponse.json({ error: 'No media data found' }, { status: 404 });
  } catch (err) {
    console.error('[UazAPI Media] Error handling media request:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
