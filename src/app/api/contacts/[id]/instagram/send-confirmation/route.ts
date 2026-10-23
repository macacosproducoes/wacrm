import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { handleFollowerOrder } from '@/lib/orders/follower-order-handler';
import { TraceLogger } from '@/lib/whatsapp/trace';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const ctx = await requireRole('agent');
    const { id: contactId } = await context.params;

    const body = await request.json().catch(() => ({}));
    const isCustomRequested = Boolean(
      body.is_custom ||
      body.badge_type === 'custom' ||
      String(body.quantity).toUpperCase().includes('PERSONALIZAD')
    );
    const isVerifiedRequested = Boolean(
      body.is_verified ||
      body.isVerified ||
      isCustomRequested ||
      String(body.quantity).toUpperCase().includes('VERIFICAD')
    );
    const requestedBadgeType: 'instagram' | 'custom' | undefined = isCustomRequested
      ? 'custom'
      : (isVerifiedRequested ? 'instagram' : undefined);
    const requestedBadgeColor = body.custom_badge_color || undefined;
    const requestedBadgeText = body.custom_badge_text || undefined;

    const requestedPlatform: 'instagram' | 'tiktok' = body.platform === 'tiktok' ? 'tiktok' : 'instagram';
    const platformLabel = requestedPlatform === 'tiktok' ? 'TikTok' : 'Instagram';

    const customQuantity = isCustomRequested
      ? 'PERSONALIZADO'
      : isVerifiedRequested
      ? 'VERIFICADO'
      : (body.quantity ? String(body.quantity).trim() : '5000');
    const admin = supabaseAdmin();

    // 1. Fetch Contact
    const { data: contact, error: contactErr } = await admin
      .from('contacts')
      .select('id, name, phone, instagram_username, profile_image_url')
      .eq('id', contactId)
      .eq('account_id', ctx.accountId)
      .single();

    if (contactErr || !contact) {
      return NextResponse.json({ error: 'Contato não encontrado.' }, { status: 404 });
    }

    const username = (body.username || contact.instagram_username || '').trim().replace(/^@+/, '');
    if (!username) {
      return NextResponse.json(
        { error: `Contato não possui @ de ${platformLabel} cadastrado. Informe um perfil antes de enviar.` },
        { status: 400 }
      );
    }

    if (!contact.phone) {
      return NextResponse.json(
        { error: 'Contato não possui número de WhatsApp cadastrado para envio.' },
        { status: 400 }
      );
    }

    // 2. Discover or get Conversation ID
    let conversationId = '';
    const { data: conv } = await admin
      .from('conversations')
      .select('id')
      .eq('account_id', ctx.accountId)
      .eq('contact_id', contact.id)
      .maybeSingle();

    if (conv) {
      conversationId = conv.id;
    } else {
      const { data: newConv } = await admin
        .from('conversations')
        .insert({
          account_id: ctx.accountId,
          contact_id: contact.id,
          status: 'open',
        })
        .select('id')
        .single();
      conversationId = newConv?.id || '';
    }

    const traceId = TraceLogger.generateTraceId('trc_manual');
    const syntheticMessageId = `manual_send_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const syntheticMessageText = isCustomRequested
      ? `Quero selo personalizado para @${username} no ${platformLabel}`
      : isVerifiedRequested
      ? `Quero selo verificado para @${username} no ${platformLabel}`
      : `Quero ${customQuantity} seguidores para @${username} no ${platformLabel}`;

    TraceLogger.log(traceId, 'T0', 'MANUAL SEND INITIATED', {
      contactId,
      username,
      quantity: customQuantity,
      platform: requestedPlatform,
      phone: contact.phone,
      isVerified: isVerifiedRequested,
      badgeType: requestedBadgeType,
    });

    // 3. Check if an existing creative job already exists with a valid render
    const { data: existingJobs } = await admin
      .from('creative_jobs')
      .select('*')
      .eq('account_id', ctx.accountId)
      .eq('source_type', 'ORDER')
      .order('created_at', { ascending: false })
      .limit(5);

    const existingJob = (existingJobs || []).find((j) => {
      const d = (j.input_data || {}) as Record<string, any>;
      const matchUsername = (d.instagram_username || d.username || '').toLowerCase() === username.toLowerCase();
      const matchContact = d.contact_id === contact.id || d.recipient === contact.phone;
      const matchVerified = Boolean(d.is_verified || d.verified) === isVerifiedRequested;
      const matchCustom = Boolean(d.is_custom_badge || d.badge_type === 'custom') === isCustomRequested;
      const matchPlatform = (d.platform || 'instagram') === requestedPlatform;
      const matchQuantity = isVerifiedRequested || String(d.quantity) === String(customQuantity);
      return (matchContact || matchUsername) && matchVerified && matchCustom && matchPlatform && matchQuantity;
    });

    const { sendFollowerOrderCreative } = await import('@/lib/orders/follower-order-handler');

    if (existingJob && existingJob.output_url) {
      const forceResend = Boolean(body.force_resend || body.forceResend);
      const sendRes = await sendFollowerOrderCreative({
        jobId: existingJob.id,
        accountId: ctx.accountId,
        contactId: contact.id,
        phone: contact.phone,
        forceResend,
        traceId,
      });

      if (sendRes.alreadySent) {
        return NextResponse.json({
          success: false,
          already_sent: true,
          message: 'Esta confirmação já foi enviada. Deseja reenviar?',
          creative_job_id: existingJob.id,
          order_code: existingJob.source_id,
          output_url: existingJob.output_url,
        });
      }

      if (!sendRes.success) {
        return NextResponse.json(
          { error: sendRes.error || 'Falha ao enviar confirmação pelo WhatsApp.' },
          { status: 400 }
        );
      }

      return NextResponse.json({
        success: true,
        trace_id: traceId,
        order_code: existingJob.source_id,
        username,
        quantity: customQuantity,
        platform: requestedPlatform,
        profile_image_url: contact.profile_image_url,
        creative_job_id: existingJob.id,
        delivery_success: true,
        output_url: existingJob.output_url,
        message: 'Arte de confirmação enviada ao WhatsApp do cliente com sucesso!',
      });
    }

    // 4. Otherwise, generate and send via the central pipeline
    const result = await handleFollowerOrder({
      accountId: ctx.accountId,
      contactId: contact.id,
      conversationId,
      phone: contact.phone,
      messageText: syntheticMessageText,
      messageId: syntheticMessageId,
      pushName: contact.name,
      traceId,
      overrideUsername: username,
      overrideQuantity: customQuantity,
      overrideIsVerified: isVerifiedRequested,
      overrideBadgeType: requestedBadgeType,
      overrideBadgeColor: requestedBadgeColor,
      overrideBadgeText: requestedBadgeText,
      overrideIsCustomBadge: isCustomRequested,
      overridePlatform: requestedPlatform,
      forceResend: true,
    });

    if (!result.handled) {
      return NextResponse.json(
        { error: 'Falha ao processar confirmação de pedido pelo pipeline.' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      trace_id: traceId,
      order_code: result.orderCode,
      username: result.username,
      quantity: result.quantity,
      profile_image_url: result.profileImageUrl,
      creative_job_id: result.creativeJob?.id,
      delivery_success: result.deliverySuccess,
      output_url: result.creativeJob?.output_url,
      message: result.deliverySuccess
        ? 'Arte de confirmação gerada e enviada ao WhatsApp do cliente!'
        : 'Arte gerada com sucesso! Entrega em processamento.',
    });
  } catch (err) {
    console.error('[Manual Send Confirmation Route Error]:', err);
    return toErrorResponse(err);
  }
}
