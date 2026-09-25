import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  sendFollowerOrderCreative,
  handleFollowerOrder,
} from '@/lib/orders/follower-order-handler';
import { TraceLogger } from '@/lib/whatsapp/trace';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/contacts/[id]/follower-order
 * Retrieves the active or latest follower order, rendered creative, and delivery audit trail.
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const ctx = await requireRole('agent');
    const { id: contactId } = await context.params;
    const admin = supabaseAdmin();

    // 1. Fetch Contact
    const { data: contact, error: contactErr } = await admin
      .from('contacts')
      .select('id, name, phone, instagram_username, profile_image_url, instagram_resolve_status, instagram_last_error')
      .eq('id', contactId)
      .eq('account_id', ctx.accountId)
      .single();

    if (contactErr || !contact) {
      return NextResponse.json({ error: 'Contato não encontrado.' }, { status: 404 });
    }

    // 2. Fetch latest follower order creative job for this contact
    let { data: jobs } = await admin
      .from('creative_jobs')
      .select('*')
      .eq('account_id', ctx.accountId)
      .eq('source_type', 'ORDER')
      .order('created_at', { ascending: false })
      .limit(10);

    // Filter for this contact's orders
    const contactJobs = (jobs || []).filter((j) => {
      const inputData = (j.input_data || {}) as Record<string, any>;
      if (inputData.contact_id === contact.id) return true;
      if (contact.phone && (inputData.recipient === contact.phone || inputData.phone === contact.phone)) return true;
      if (contact.instagram_username && inputData.instagram_username?.toLowerCase() === contact.instagram_username.toLowerCase()) return true;
      return false;
    });

    const latestJob = contactJobs[0] || null;

    // 3. Fetch active Creative Templates available for this account
    const { data: availableTemplates } = await admin
      .from('creative_templates')
      .select('id, name, category, status')
      .eq('account_id', ctx.accountId)
      .eq('status', 'ACTIVE')
      .order('name');

    if (!latestJob) {
      return NextResponse.json({
        has_order: false,
        templates: availableTemplates || [],
        contact: {
          id: contact.id,
          name: contact.name,
          phone: contact.phone,
          instagram_username: contact.instagram_username,
          profile_image_url: contact.profile_image_url,
          instagram_resolve_status: contact.instagram_resolve_status,
        },
      });
    }

    // 4. Fetch Deliveries for this Job
    const { data: deliveries } = await admin
      .from('creative_deliveries')
      .select('id, provider_message_id, status, error, created_at, sent_at')
      .eq('job_id', latestJob.id)
      .order('created_at', { ascending: false });

    const inputData = (latestJob.input_data || {}) as Record<string, any>;
    const hasSuccessfulDelivery = (deliveries || []).some((d) => d.status === 'SENT');
    const latestDelivery = deliveries && deliveries.length > 0 ? deliveries[0] : null;

    return NextResponse.json({
      has_order: true,
      templates: availableTemplates || [],
      job: {
        id: latestJob.id,
        order_code: latestJob.source_id,
        username: inputData.instagram_username || contact.instagram_username,
        quantity: inputData.quantity || 5000,
        template_id: latestJob.template_id,
        platform: inputData.platform || (inputData.username?.includes('tiktok') ? 'tiktok' : 'instagram'),
        status: latestJob.status,
        output_url: latestJob.output_url,
        error: latestJob.error,
        created_at: latestJob.created_at,
        completed_at: latestJob.completed_at,
        sent_at: latestJob.sent_at,
      },
      deliveries: deliveries || [],
      is_sent: hasSuccessfulDelivery,
      last_delivery: latestDelivery,
      contact: {
        id: contact.id,
        name: contact.name,
        phone: contact.phone,
        instagram_username: contact.instagram_username,
        profile_image_url: contact.profile_image_url,
        instagram_resolve_status: contact.instagram_resolve_status,
        instagram_last_error: contact.instagram_last_error,
      },
      steps: {
        order_received: true,
        instagram_identified: Boolean(contact.instagram_username || inputData.instagram_username),
        instagram_photo_obtained: Boolean(contact.profile_image_url || inputData.profile_image),
        creative_generated: Boolean(latestJob.output_url && (latestJob.status === 'GENERATED' || latestJob.status === 'SENT')),
        delivery_status: latestDelivery?.status || (latestJob.status === 'SENT' ? 'SENT' : latestJob.status === 'SENDING' ? 'SENDING' : 'IDLE'),
        delivery_error: latestDelivery?.error || (latestJob.status === 'FAILED' ? latestJob.error : null),
      },
    });
  } catch (err) {
    console.error('[Follower Order GET Route Error]:', err);
    return toErrorResponse(err);
  }
}

/**
 * POST /api/contacts/[id]/follower-order
 * Triggers manual send or re-send using the EXACT same central service.
 * Never re-renders the image if an existing output_url is available.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const ctx = await requireRole('agent');
    const { id: contactId } = await context.params;
    const body = await request.json().catch(() => ({}));
    const admin = supabaseAdmin();

    const { data: contact, error: contactErr } = await admin
      .from('contacts')
      .select('id, name, phone, instagram_username, profile_image_url')
      .eq('id', contactId)
      .eq('account_id', ctx.accountId)
      .single();

    if (contactErr || !contact) {
      return NextResponse.json({ error: 'Contato não encontrado.' }, { status: 404 });
    }

    if (!contact.phone) {
      return NextResponse.json(
        { error: 'Contato não possui telefone WhatsApp cadastrado para envio.' },
        { status: 400 }
      );
    }

    const traceId = TraceLogger.generateTraceId('trc_manual');
    const forceResend = Boolean(body.force_resend || body.forceResend);
    const targetJobId = body.job_id || body.jobId;

    // 1. Locate existing job
    let existingJob: any = null;
    if (targetJobId) {
      const { data } = await admin
        .from('creative_jobs')
        .select('*')
        .eq('id', targetJobId)
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      existingJob = data;
    } else {
      // Find latest job for this contact
      const { data: jobs } = await admin
        .from('creative_jobs')
        .select('*')
        .eq('account_id', ctx.accountId)
        .eq('source_type', 'ORDER')
        .order('created_at', { ascending: false })
        .limit(10);

      existingJob = (jobs || []).find((j) => {
        const d = (j.input_data || {}) as Record<string, any>;
        return d.contact_id === contact.id || d.recipient === contact.phone || d.instagram_username === contact.instagram_username;
      });
    }

    const requestedUsername = (body.username || '').trim().replace(/^@+/, '');
    const isVerifiedRequested = Boolean(
      body.is_verified ||
      body.isVerified ||
      String(body.quantity).toUpperCase().includes('VERIFICAD')
    );
    const requestedQuantity = isVerifiedRequested
      ? 'VERIFICADO'
      : (body.quantity ? Number(String(body.quantity).replace(/\D/g, '')) : undefined);
    const requestedTemplateId = body.template_id || undefined;
    const requestedPlatform = (body.platform as ('instagram' | 'tiktok') | undefined) || undefined;
    const forceRegenerate = Boolean(body.regenerate || body.force_regenerate);

    const existingData = (existingJob?.input_data || {}) as Record<string, any>;
    const hasModifications = Boolean(
      (requestedUsername && requestedUsername.toLowerCase() !== String(existingData.instagram_username || existingData.username || contact.instagram_username || '').toLowerCase()) ||
      (isVerifiedRequested !== Boolean(existingData.is_verified || existingData.verified)) ||
      (requestedQuantity && requestedQuantity !== (existingData.is_verified ? 'VERIFICADO' : Number(existingData.quantity || 5000))) ||
      (requestedTemplateId && requestedTemplateId !== existingJob?.template_id) ||
      (requestedPlatform && requestedPlatform !== existingData.platform)
    );

    // 2. If existing job exists, has not been modified, and regenerate is NOT requested: send existing art!
    if (existingJob && existingJob.output_url && !forceRegenerate && !hasModifications) {
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
          job_id: existingJob.id,
          output_url: existingJob.output_url,
        });
      }

      if (!sendRes.success) {
        return NextResponse.json({
          success: false,
          error: sendRes.error || 'Falha ao enviar imagem pelo WhatsApp via UAZAPI.',
          job_id: existingJob.id,
        }, { status: 400 });
      }

      return NextResponse.json({
        success: true,
        message: 'Arte de confirmação reenviada com sucesso ao cliente!',
        job_id: existingJob.id,
        delivery_id: sendRes.deliveryId,
        provider_message_id: sendRes.providerMessageId,
        output_url: existingJob.output_url,
      });
    }

    // 3. Generate fresh/updated creative via handleFollowerOrder with custom template, @, and quantity!
    const effectiveUsername = requestedUsername || (contact.instagram_username || existingData.instagram_username || existingData.username || '').trim().replace(/^@+/, '');
    if (!effectiveUsername) {
      return NextResponse.json(
        { error: 'Informe o @ perfil do cliente para gerar a arte de confirmação.' },
        { status: 400 }
      );
    }

    const effectiveQuantity = isVerifiedRequested
      ? 'VERIFICADO'
      : (requestedQuantity || Number(existingData.quantity) || 5000);
    const effectiveTemplateId = requestedTemplateId || existingJob?.template_id || undefined;
    const effectivePlatform = requestedPlatform || existingData.platform || (effectiveUsername.includes('tiktok') ? 'tiktok' : 'instagram');

    const syntheticMessageId = `manual_gen_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const syntheticMessageText = isVerifiedRequested
      ? `Quero selo verificado para @${effectiveUsername}`
      : `Quero ${effectiveQuantity} seguidores para @${effectiveUsername}`;

    let conversationId = '';
    const { data: conv } = await admin
      .from('conversations')
      .select('id')
      .eq('account_id', ctx.accountId)
      .eq('contact_id', contact.id)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (conv) {
      conversationId = conv.id;
    } else {
      const { data: newConv } = await admin
        .from('conversations')
        .insert({ account_id: ctx.accountId, contact_id: contact.id, status: 'open' })
        .select('id')
        .single();
      conversationId = newConv?.id || '';
    }

    const orderRes = await handleFollowerOrder({
      accountId: ctx.accountId,
      contactId: contact.id,
      conversationId,
      phone: contact.phone,
      messageText: syntheticMessageText,
      messageId: syntheticMessageId,
      pushName: contact.name,
      traceId,
      overrideUsername: effectiveUsername,
      overrideQuantity: effectiveQuantity,
      overrideIsVerified: isVerifiedRequested,
      overridePlatform: effectivePlatform,
      overrideTemplateId: effectiveTemplateId,
      forceResend: true,
    });

    if (!orderRes.handled || !orderRes.creativeJob) {
      return NextResponse.json(
        { error: 'Falha ao processar e gerar criativo do pedido.' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: orderRes.deliverySuccess
        ? 'Nova arte gerada e enviada com sucesso ao WhatsApp!'
        : 'Nova arte gerada com sucesso!',
      job_id: orderRes.creativeJob.id,
      order_code: orderRes.orderCode,
      output_url: orderRes.creativeJob.output_url,
      delivery_success: orderRes.deliverySuccess,
    });
  } catch (err) {
    console.error('[Follower Order POST Route Error]:', err);
    return toErrorResponse(err);
  }
}
