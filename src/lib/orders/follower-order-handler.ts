/**
 * Follower Order Handler & Automation Engine
 *
 * Implements the deterministic end-to-end flow:
 * WhatsApp Message -> Parse Handle & Quantity -> Direct Instagram Profile Resolver
 * -> Update Contact -> Create Order -> Render Creative Template (960x960)
 * -> Upload to Storage -> Automatic Delivery via UAZAPI WhatsApp -> Update Status.
 */

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { extractInstagramIdentifier, parseInstagramUsername } from '@/lib/instagram-resolver/parser';
import { InstagramProfileResolver } from '@/lib/instagram-resolver/resolver';
import { extractTikTokIdentifier, parseTikTokUsername, TikTokProfileResolver, NEUTRAL_TIKTOK_AVATAR } from '@/lib/tiktok-resolver';
import { CreativeJobManager } from '@/lib/creative-engine/jobs';
import { CreativeTemplateService } from '@/lib/creative-engine/templates';
import type { CreativeJob } from '@/lib/creative-engine/types';
import { TraceLogger } from '@/lib/whatsapp/trace';

export const FOLLOWER_TEMPLATE_ID = 'b7e8d641-5a02-4f76-88c9-cf91b29a5a78';

/**
 * Standard neutral Instagram silhouette SVG data-URI.
 * Used exclusively when the Instagram profile picture cannot be resolved or is private/blocked,
 * strictly guaranteeing that the contact's WhatsApp photo is NEVER used as a fallback mask.
 */
export const NEUTRAL_INSTAGRAM_AVATAR =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 240' width='240' height='240'%3E%3Crect width='240' height='240' fill='%231e293b'/%3E%3Cpath fill='%2394a3b8' d='M120 125a42 42 0 1 0 0-84 42 42 0 0 0 0 84zm0 18c-38 0-72 18-72 54v13h144v-13c0-36-34-54-72-54z'/%3E%3C/svg%3E";

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Supabase URL or Service Role Key missing.');
  }
  return createSupabaseClient(url, key);
}

export interface ParsedFollowerOrder {
  isFollowerOrder: boolean;
  platform?: 'instagram' | 'tiktok';
  username?: string;
  quantity?: number;
  quantityFormatted?: string;
  isVerified?: boolean;
}

/**
 * Deterministically parses a customer message for follower order intent,
 * Instagram/TikTok handle, and follower quantity.
 *
 * Supported formats:
 * - "Sou o cristiano quero 5.000 seguidores" -> cristiano, 5000, instagram
 * - "Quero 5 mil seguidores para o @cristiano" -> cristiano, 5000, instagram
 * - "5 mil para tick tok @alvesbarros135" -> alvesbarros135, 5000, tiktok
 * - "Quero 5000 pro tiktok @alvesbarros135" -> alvesbarros135, 5000, tiktok
 * - "tiktok.com/@alvesbarros135 5000 seguidores" -> alvesbarros135, 5000, tiktok
 */
export function parseFollowerOrder(text: string | null | undefined): ParsedFollowerOrder {
  if (!text || typeof text !== 'string') {
    return { isFollowerOrder: false };
  }

  const raw = text.trim();
  if (!raw) return { isFollowerOrder: false };

  const isVerifiedIntent = /(?:verificad[oa]|selo(?:\s+azul)?|badge)/i.test(raw);

  // Check follower, platform or verified order intent
  const followerIntentRegex = /(?:seguidor|seguidores|follower|followers|tiktok|tick\s*tok|tik\s*tok|verificad[oa]|selo|badge)/i;
  if (!followerIntentRegex.test(raw)) {
    return { isFollowerOrder: false };
  }

  // Detect platform (TikTok vs Instagram)
  const isTikTok = /(?:tiktok|tick\s*tok|tik\s*tok)/i.test(raw);
  const platform: 'instagram' | 'tiktok' = isTikTok ? 'tiktok' : 'instagram';

  let username: string | undefined = undefined;

  if (isTikTok) {
    // 1. Try TikTok parser
    const tiktokRes = extractTikTokIdentifier(raw);
    if (tiktokRes.username) {
      username = tiktokRes.username;
    } else {
      // Fallback: check @handle or leading username
      const handleMatch = raw.match(/@([a-zA-Z0-9_.-]{2,30})/);
      if (handleMatch) {
        username = parseTikTokUsername(handleMatch[1]) || undefined;
      }
    }
  } else {
    // 1. Extract Instagram handle
    const instaResult = extractInstagramIdentifier(raw);
    username = instaResult.username || undefined;

    // Fallback: If message begins with handle, e.g. "cristiano quero 5000 seguidores"
    if (!username) {
      const leadingMatch = raw.match(/^([a-zA-Z0-9._]{2,30})\s+(?:quero|manda|envia|comprar|favor|por\s+favor)\b/i);
      if (leadingMatch) {
        const candidate = parseInstagramUsername(leadingMatch[1]);
        if (candidate) {
          username = candidate;
        }
      }
    }
  }

  if (!username) {
    return { isFollowerOrder: false };
  }

  // 2. Extract Quantity
  // Matches:
  // - "5.000 seguidores" / "5000 seguidores" / "30.000" / "50.000" / "100.000"
  // - "10k seguidores" / "10 mil seguidores" / "30k" / "50 mil" / "100k"
  // - "5 mil para tick tok" / "quero 5.000" / "quantidade 5000"
  let quantity = 0;
  let quantityFormatted = '';

  const qtyFollowerRegex = /([0-9]{1,3}(?:\.[0-9]{3})+|[0-9]+)\s*(k|mil)?\s*(?:de\s*)?(?:seguidores|seguidor|followers|follower)/i;
  const followerQtyRegex = /(?:seguidores|seguidor|followers|follower)\s*(?:de|para|:)?\s*([0-9]{1,3}(?:\.[0-9]{3})+|[0-9]+)\s*(k|mil)?/i;
  const genericQtyRegex = /([0-9]{1,3}(?:\.[0-9]{3})+|[0-9]+)\s*(k|mil)?\s*(?:de\s*)?(?:para|pro|no|em|do)?\s*(?:tiktok|tick\s*tok|tik\s*tok|insta|instagram)/i;
  const verbQtyRegex = /(?:quero|comprar|manda|envia|coloca|adicionar|pedido\s+de)\s+([0-9]{1,3}(?:\.[0-9]{3})+|[0-9]+)\s*(k|mil)?/i;

  const match = raw.match(qtyFollowerRegex) || raw.match(followerQtyRegex) || raw.match(genericQtyRegex) || raw.match(verbQtyRegex);

  if (match) {
    const rawNumber = match[1].replace(/\./g, '');
    const multiplier = match[2]?.toLowerCase();
    let num = parseInt(rawNumber, 10);

    if (multiplier === 'k' || multiplier === 'mil') {
      num = num * 1000;
    }

    if (!isNaN(num) && num > 0) {
      quantity = num;
      quantityFormatted = num.toLocaleString('pt-BR');
    }
  }

  // If user requested verified badge and no numeric follower amount was provided
  if (!quantity && isVerifiedIntent) {
    quantity = 1;
    quantityFormatted = 'Selo Verificado';
  }

  if (!quantity) {
    return { isFollowerOrder: false };
  }

  return {
    isFollowerOrder: true,
    platform,
    username,
    quantity,
    quantityFormatted,
    isVerified: isVerifiedIntent,
  };
}

export interface HandleFollowerOrderParams {
  accountId: string;
  contactId: string;
  conversationId?: string;
  phone: string;
  messageText?: string;
  messageId?: string;
  pushName?: string;
  traceId?: string;
  overrideUsername?: string;
  overrideQuantity?: number | string;
  overridePlatform?: 'instagram' | 'tiktok';
  overrideTemplateId?: string;
  overrideIsVerified?: boolean;
  forceResend?: boolean;
}

export interface HandleFollowerOrderResult {
  handled: boolean;
  orderCode?: string;
  username?: string;
  quantity?: number;
  profileImageUrl?: string | null;
  creativeJob?: CreativeJob;
  deliverySuccess?: boolean;
}

/**
 * Handles the complete follower order workflow
 */
export async function handleFollowerOrder(
  params: HandleFollowerOrderParams
): Promise<HandleFollowerOrderResult> {
  const {
    accountId,
    contactId,
    conversationId,
    phone,
    messageText,
    messageId = `manual_${Date.now()}`,
    pushName,
    traceId,
    overrideUsername,
    overrideQuantity,
    overridePlatform,
    overrideTemplateId,
    forceResend = false,
  } = params;

  let parsed: ParsedFollowerOrder;
  if (overrideUsername && overrideQuantity !== undefined) {
    const rawUser = overrideUsername.trim().replace(/^@+/, '');
    const isTtk =
      overridePlatform === 'tiktok' ||
      /(?:tiktok|tick\s*tok)/i.test(overrideUsername);
    const isExplicitVerified = Boolean(
      params.overrideIsVerified ||
      String(overrideQuantity).toUpperCase().includes('VERIFICAD')
    );
    const qtyNum = isExplicitVerified
      ? 1
      : typeof overrideQuantity === 'number'
      ? overrideQuantity
      : parseInt(String(overrideQuantity).replace(/\D/g, ''), 10) || 5000;
    parsed = {
      isFollowerOrder: true,
      platform: overridePlatform || (isTtk ? 'tiktok' : 'instagram'),
      username: rawUser,
      quantity: qtyNum,
      quantityFormatted: isExplicitVerified ? 'Selo Verificado' : qtyNum.toLocaleString('pt-BR'),
      isVerified: isExplicitVerified,
    };
  } else {
    parsed = parseFollowerOrder(messageText);
    if (!parsed.isFollowerOrder || !parsed.username || !parsed.quantity) {
      return { handled: false };
    }
  }

  if (traceId) {
    TraceLogger.log(traceId, 'T4', 'PARSER EXECUTED', {
      isFollowerOrder: true,
      username: parsed.username,
      quantity: parsed.quantity,
    });
    TraceLogger.log(traceId, 'T5', 'INSTAGRAM IDENTIFIED', {
      username: parsed.username,
      quantity: parsed.quantity,
      phone,
    });
  }

  const orderUsername = parsed.username || '';
  const orderQuantity = parsed.quantity || 5000;

  console.log(`[FOLLOWER_ORDER] Detected valid order (${parsed.platform || 'instagram'}) from phone ${phone}: @${orderUsername}, quantity: ${orderQuantity}`);
  const supabase = getAdminClient();

  const isTikTok = parsed.platform === 'tiktok';
  const platformLabel = isTikTok ? 'TikTok' : 'Instagram';
  const serviceLabel = isTikTok ? 'Seguidores TikTok' : 'Seguidores Instagram';

  // 1. Update contact with username
  await supabase
    .from('contacts')
    .update({
      instagram_username: orderUsername,
      updated_at: new Date().toISOString(),
    })
    .eq('id', contactId)
    .eq('account_id', accountId);

  // 2. Execute Profile Resolver to fetch real avatar (CRITICAL: NEVER touches contact.avatar_url)
  let profileImageUrl: string | null = null;
  let resolveError: string | null = null;

  if (isTikTok) {
    console.log(`[FOLLOWER_ORDER] Resolving TikTok profile for @${orderUsername}...`);
    try {
      const resolved = await TikTokProfileResolver.resolveProfile(orderUsername, accountId);
      profileImageUrl = resolved.profileImageUrl || null;
      resolveError = resolved.error || null;
      if (profileImageUrl && resolved.resolveStatus === 'IMAGE_AVAILABLE' && !profileImageUrl.startsWith('data:')) {
        await supabase
          .from('contacts')
          .update({
            profile_image_url: profileImageUrl,
            profile_image_source: 'TIKTOK_PROVIDER',
            profile_image_updated_at: new Date().toISOString(),
          })
          .eq('id', contactId);
      }
      console.log(`[FOLLOWER_ORDER] TikTok profile photo resolved: ${profileImageUrl ? 'FOUND' : 'NOT_FOUND'}`);
    } catch (tikErr: unknown) {
      resolveError = tikErr instanceof Error ? tikErr.message : String(tikErr);
      console.warn(`[FOLLOWER_ORDER] TikTok profile resolver warning:`, tikErr);
    }
  } else {
    console.log(`[FOLLOWER_ORDER] Resolving Instagram profile for @${parsed.username}...`);
    try {
      const resolved = await InstagramProfileResolver.resolveContact(accountId, contactId, { forceRefresh: true });
      profileImageUrl = resolved.profileImageUrl || null;
      resolveError = resolved.error || null;
      console.log(`[FOLLOWER_ORDER] Instagram profile photo resolved: ${profileImageUrl ? 'FOUND' : 'NOT_FOUND'}`);
    } catch (resErr: unknown) {
      resolveError = resErr instanceof Error ? resErr.message : String(resErr);
      console.warn(`[FOLLOWER_ORDER] Instagram profile resolver warning:`, resErr);
    }
  }

  // Fetch updated contact (checking strictly profile_image_url, NOT avatar_url)
  const { data: contact } = await supabase
    .from('contacts')
    .select('id, name, phone, profile_image_url, instagram_username, instagram_resolve_status, instagram_last_error')
    .eq('id', contactId)
    .single();

  const finalResolvedImage = contact?.profile_image_url || profileImageUrl;
  const isImageAvailable = Boolean(finalResolvedImage && !finalResolvedImage.startsWith('data:image/svg'));

  if (traceId) {
    if (isImageAvailable) {
      TraceLogger.log(traceId, 'T6', `${platformLabel.toUpperCase()} RESOLVED`, {
        username: parsed.username,
        status: 'IMAGE_AVAILABLE',
        profileImageUrl: finalResolvedImage!.slice(0, 60) + '...',
      });
    } else {
      TraceLogger.log(traceId, 'T6', `${platformLabel.toUpperCase()}_IMAGE_UNAVAILABLE`, {
        username: parsed.username,
        status: 'IMAGE_UNAVAILABLE',
        reason: resolveError || contact?.instagram_last_error || `Foto pública indisponível ou inacessível no ${platformLabel}`,
        fallbackAction: 'Silhueta neutra utilizada. Foto do WhatsApp mantida intacta sem substituição.',
      });
    }
  }

  // Final template image: Use strictly the resolved platform photo if available.
  // If unavailable, use the neutral platform silhouette - NEVER fall back to the contact's WhatsApp avatar!
  const neutralAvatar = isTikTok ? NEUTRAL_TIKTOK_AVATAR : NEUTRAL_INSTAGRAM_AVATAR;
  const templateProfileImage = finalResolvedImage || neutralAvatar;

  const isVerifiedOrder = Boolean(
    parsed.isVerified ||
    params.overrideIsVerified ||
    String(overrideQuantity).toUpperCase().includes('VERIFICAD')
  );

  // 3. Generate Order Code & Idempotency Key
  const orderCode = isVerifiedOrder
    ? `PED-VERIFICADO-${orderUsername.toUpperCase()}`
    : `PED-${orderQuantity}-${orderUsername.toUpperCase()}`;
  const idempotencyKey = `follower_order_${accountId}_${contactId}_${orderUsername}_${orderQuantity}_${isVerifiedOrder ? 'verif_' : ''}${messageId}`;

  if (traceId) {
    TraceLogger.log(traceId, 'T7', 'ORDER CREATED', {
      orderCode,
      idempotencyKey,
      contactId,
      hasPhoto: isImageAvailable,
    });
  }

  // 4. Resolve Follower Creative Template
  let templateId = overrideTemplateId || FOLLOWER_TEMPLATE_ID;
  const { template } = await CreativeTemplateService.getTemplate(templateId, accountId).catch(async () => {
    // Fallback: search by category 'followers'
    const { data: fallbackTmpl } = await supabase
      .from('creative_templates')
      .select('*')
      .eq('account_id', accountId)
      .eq('category', 'followers')
      .eq('status', 'ACTIVE')
      .limit(1)
      .maybeSingle();

    if (!fallbackTmpl) {
      throw new Error(`Active follower confirmation template not found for account ${accountId}`);
    }
    return { template: fallbackTmpl };
  });

  templateId = template.id;

  // 5. Build Template Rendering Context
  const recipientName = contact?.name && !contact.name.startsWith('Cliente')
    ? contact.name
    : pushName || parsed.username;

  const finalServiceLabel = isVerifiedOrder
    ? (isTikTok ? 'Selo Verificado TikTok' : 'Selo Verificado Instagram')
    : serviceLabel;

  const quantityDisplay = isVerifiedOrder
    ? (parsed.quantity && parsed.quantity > 1 ? `${parsed.quantityFormatted} + Selo Verificado` : 'Selo Verificado')
    : (parsed.quantityFormatted || String(parsed.quantity));

  const renderContext = {
    title: isVerifiedOrder ? 'SOLICITAÇÃO DE VERIFICAÇÃO' : 'CONFIRMAÇÃO DE PEDIDO',
    name: recipientName,
    code: orderCode,
    platform: parsed.platform || 'instagram',
    platform_label: platformLabel,
    username: parsed.username,
    instagram_username: parsed.username,
    quantity: quantityDisplay,
    service: finalServiceLabel,
    is_verified: isVerifiedOrder,
    verified: isVerifiedOrder,
    verified_badge: isVerifiedOrder ? '✓' : '',
    date: new Date().toLocaleDateString('pt-BR'),
    profile_image: templateProfileImage,
    amount: 'R$ 49,90',
    trace_id: traceId,
    contact_id: contactId,
    phone,
    recipient: phone,
    order: {
      code: orderCode,
      quantity: quantityDisplay,
      service: finalServiceLabel,
      amount: 'R$ 49,90',
      date: new Date().toLocaleDateString('pt-BR'),
    },
    customer: {
      name: recipientName,
      phone,
    },
    instagram: {
      username: parsed.username,
      profile_image: templateProfileImage,
    },
    tiktok: {
      username: parsed.username,
      profile_image: templateProfileImage,
    },
  };

  if (traceId) {
    TraceLogger.log(traceId, 'T8', 'CREATIVE JOB CREATED', {
      templateId,
      orderCode,
    });
  }

  // 6. Process Creative Job (Render -> Storage)
  console.log(`[FOLLOWER_ORDER] Triggering Creative Job render for order #${orderCode}...`);

  if (traceId) {
    TraceLogger.log(traceId, 'T9', 'RENDER INITIATED', {
      orderCode,
      templateId,
    });
  }

  const job = await CreativeJobManager.processJob({
    accountId,
    templateId,
    sourceType: 'ORDER',
    sourceId: orderCode,
    creativeType: 'follower_confirmation',
    inputData: renderContext,
    idempotencyKey,
    deliver: false, // Unified delivery is executed via sendFollowerOrderCreative below!
  });

  if (traceId) {
    TraceLogger.log(traceId, 'T10', 'RENDER COMPLETED', {
      jobId: job.id,
      dimensions: '960x960',
    });
    TraceLogger.log(traceId, 'T11', 'STORAGE UPLOAD', {
      jobId: job.id,
      outputUrl: job.output_url ? job.output_url.slice(0, 60) + '...' : null,
    });
  }

  // 7. Automated Delivery - strictly routes through the EXACT SAME service as manual send
  console.log(`[FOLLOWER_ORDER] Dispatching delivery via unified send service for job ${job.id}...`);
  const sendRes = await sendFollowerOrderCreative({
    jobId: job.id,
    accountId,
    contactId,
    phone,
    forceResend: Boolean(forceResend),
    traceId,
  });

  const { data: finalJob } = await supabase
    .from('creative_jobs')
    .select('*')
    .eq('id', job.id)
    .single();

  const currentJob = finalJob || job;
  console.log(`[FOLLOWER_ORDER] Order #${orderCode} finished. Status: ${currentJob.status}, Delivered: ${sendRes.success}`);

  return {
    handled: true,
    orderCode,
    username: parsed.username,
    quantity: parsed.quantity,
    profileImageUrl: finalResolvedImage || undefined,
    creativeJob: currentJob,
    deliverySuccess: sendRes.success,
  };
}

export interface SendFollowerOrderCreativeParams {
  jobId?: string;
  orderCode?: string;
  accountId: string;
  contactId?: string;
  phone?: string;
  forceResend?: boolean;
  traceId?: string;
}

export interface SendFollowerOrderCreativeResult {
  success: boolean;
  alreadySent?: boolean;
  error?: string;
  job?: CreativeJob;
  deliveryResult?: any;
  deliveryId?: string;
  providerMessageId?: string;
}

/**
 * Unified delivery pipeline for both AUTOMATIC and MANUAL sends.
 * Guarantees zero behavioral drift:
 * - Uses existing render (never re-generates image if valid output exists)
 * - Checks idempotency (prevents duplicate sends unless forceResend is true)
 * - Calls central WhatsAppDeliveryProvider via CreativeJobManager.deliverJob
 * - Records delivery in creative_deliveries, messages, and emits inbox realtime event
 */
export async function sendFollowerOrderCreative(
  params: SendFollowerOrderCreativeParams
): Promise<SendFollowerOrderCreativeResult> {
  const { jobId, orderCode, accountId, contactId, forceResend = false, traceId } = params;
  const supabase = getAdminClient();

  // 1. Resolve Creative Job
  let query = supabase.from('creative_jobs').select('*').eq('account_id', accountId);
  if (jobId) {
    query = query.eq('id', jobId);
  } else if (orderCode) {
    query = query.eq('source_type', 'ORDER').eq('source_id', orderCode);
  } else if (contactId) {
    query = query
      .eq('source_type', 'ORDER')
      .contains('input_data', { contact_id: contactId })
      .order('created_at', { ascending: false })
      .limit(1);
  } else {
    return { success: false, error: 'Identificador do pedido ou criativo não fornecido.' };
  }

  const { data: job, error: jobErr } = await query.maybeSingle();
  if (jobErr || !job) {
    return { success: false, error: 'Criativo do pedido não encontrado.' };
  }

  // 2. Validate render output
  if (!job.output_url || job.status === 'PROCESSING') {
    return {
      success: false,
      error: 'A imagem do template ainda está sendo gerada. Aguarde alguns instantes.',
      job: job as CreativeJob,
    };
  }

  if (job.status === 'FAILED') {
    return {
      success: false,
      error: job.error || 'Falha na renderização do criativo.',
      job: job as CreativeJob,
    };
  }

  // 3. Resolve destination phone
  let targetPhone = params.phone;
  const inputData = (job.input_data || {}) as Record<string, any>;
  if (!targetPhone) {
    targetPhone = inputData.recipient || inputData.phone;
  }
  if (!targetPhone && (contactId || inputData.contact_id)) {
    const cid = contactId || inputData.contact_id;
    const { data: contact } = await supabase.from('contacts').select('phone').eq('id', cid).single();
    targetPhone = contact?.phone || undefined;
  }

  if (!targetPhone) {
    return {
      success: false,
      error: 'Telefone do cliente não encontrado para envio pelo WhatsApp.',
      job: job as CreativeJob,
    };
  }

  // 4. Check Idempotency: verify existing successful delivery
  const { data: existingDeliveries } = await supabase
    .from('creative_deliveries')
    .select('id, provider_message_id, status, created_at, sent_at')
    .eq('job_id', job.id)
    .eq('status', 'SENT')
    .order('created_at', { ascending: false });

  if (existingDeliveries && existingDeliveries.length > 0 && !forceResend) {
    console.log(`[FOLLOWER_ORDER] Job ${job.id} was already sent previously. Requires confirmation for resend.`);
    return {
      success: false,
      alreadySent: true,
      error: 'Esta confirmação já foi enviada. Deseja reenviar?',
      job: job as CreativeJob,
      deliveryId: existingDeliveries[0].id,
      providerMessageId: existingDeliveries[0].provider_message_id,
    };
  }

  // 5. Build message caption
  const recipientName = inputData.name || 'Cliente';
  const code = job.source_id || inputData.code || 'PED';
  const username = inputData.instagram_username || inputData.username || '';
  const quantityFormatted = inputData.quantity || '5.000';
  const platform = inputData.platform || 'instagram';
  const platformLabel = platform === 'tiktok' ? 'TikTok' : 'Instagram';
  const serviceLabel = platform === 'tiktok' ? 'Seguidores TikTok' : 'Seguidores Instagram';

  const caption =
    `✅ *Confirmação de Pedido*\n\n` +
    `Olá *${recipientName}*, seu pedido de seguidores foi registrado com sucesso!\n\n` +
    `📌 *Código:* #${code}\n` +
    `👤 *${platformLabel}:* @${username}\n` +
    `🚀 *Quantidade:* ${quantityFormatted} seguidores\n` +
    `📦 *Serviço:* ${serviceLabel}\n\n` +
    `Agradecemos pela preferência!`;

  const deliveryOptions = {
    recipient: targetPhone,
    caption,
    metadata: { traceId: traceId || inputData.trace_id },
  };

  // 6. Deliver via central WhatsAppDeliveryProvider
  console.log(`[FOLLOWER_ORDER] Delivering job ${job.id} (resend: ${forceResend}) to ${targetPhone}...`);
  const deliveryResult = await CreativeJobManager.deliverJob(job as CreativeJob, deliveryOptions);

  if (!deliveryResult.success) {
    console.error(`[FOLLOWER_ORDER] Delivery failed for job ${job.id}:`, deliveryResult.error);
    return {
      success: false,
      error: deliveryResult.error || 'Falha no envio da mídia via WhatsApp / UAZAPI.',
      job: job as CreativeJob,
      deliveryResult,
    };
  }

  console.log(`[FOLLOWER_ORDER] Delivery successful for job ${job.id}: messageId ${deliveryResult.providerMessageId}`);
  return {
    success: true,
    job: { ...(job as CreativeJob), status: 'SENT' },
    deliveryResult,
    providerMessageId: deliveryResult.providerMessageId,
  };
}
