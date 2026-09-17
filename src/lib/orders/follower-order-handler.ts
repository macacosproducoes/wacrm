/**
 * Follower Order Handler & Automation Engine
 *
 * Implements the deterministic end-to-end flow:
 * WhatsApp Message -> Parse Handle & Quantity -> Direct Instagram Profile Resolver
 * -> Update Contact -> Create Order -> Render Creative Template (960x960)
 * -> Upload to Storage -> Automatic Delivery via UAZAPI WhatsApp -> Update Status.
 */

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { extractInstagramIdentifier } from '@/lib/instagram-resolver/parser';
import { InstagramProfileResolver } from '@/lib/instagram-resolver/resolver';
import { CreativeJobManager } from '@/lib/creative-engine/jobs';
import { CreativeTemplateService } from '@/lib/creative-engine/templates';
import type { CreativeJob } from '@/lib/creative-engine/types';
import { TraceLogger } from '@/lib/whatsapp/trace';

export const FOLLOWER_TEMPLATE_ID = 'b7e8d641-5a02-4f76-88c9-cf91b29a5a78';

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
  username?: string;
  quantity?: number;
  quantityFormatted?: string;
}

/**
 * Deterministically parses a customer message for follower order intent,
 * Instagram handle, and follower quantity.
 *
 * Supported formats:
 * - "Sou @cristiano, quero 5.000 seguidores" -> cristiano, 5000
 * - "Quero 10.000 seguidores para @cristiano" -> cristiano, 10000
 * - "@cristiano quero 5k seguidores" -> cristiano, 5000
 * - "manda 5000 seguidores pro cristiano" -> cristiano, 5000
 */
export function parseFollowerOrder(text: string | null | undefined): ParsedFollowerOrder {
  if (!text || typeof text !== 'string') {
    return { isFollowerOrder: false };
  }

  const raw = text.trim();
  if (!raw) return { isFollowerOrder: false };

  // Check follower keyword intent
  const followerIntentRegex = /(?:seguidor|seguidores|follower|followers)/i;
  if (!followerIntentRegex.test(raw)) {
    return { isFollowerOrder: false };
  }

  // 1. Extract Instagram handle
  const instaResult = extractInstagramIdentifier(raw);
  if (!instaResult.detected || !instaResult.username) {
    return { isFollowerOrder: false };
  }
  const username = instaResult.username;

  // 2. Extract Quantity
  // Matches:
  // - "5.000 seguidores" / "5000 seguidores"
  // - "10k seguidores" / "10 mil seguidores"
  // - "quero 5.000" / "quantidade 5000"
  let quantity = 0;
  let quantityFormatted = '';

  const qtyFollowerRegex = /([0-9]{1,3}(?:\.[0-9]{3})+|[0-9]+)\s*(k|mil)?\s*(?:de\s*)?(?:seguidores|seguidor|followers|follower)/i;
  const followerQtyRegex = /(?:seguidores|seguidor|followers|follower)\s*(?:de|para|:)?\s*([0-9]{1,3}(?:\.[0-9]{3})+|[0-9]+)\s*(k|mil)?/i;

  const match = raw.match(qtyFollowerRegex) || raw.match(followerQtyRegex);

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

  if (!quantity) {
    return { isFollowerOrder: false };
  }

  return {
    isFollowerOrder: true,
    username,
    quantity,
    quantityFormatted,
  };
}

export interface HandleFollowerOrderParams {
  accountId: string;
  contactId: string;
  conversationId: string;
  phone: string;
  messageText: string;
  messageId: string;
  pushName?: string;
  traceId?: string;
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
  const { accountId, contactId, conversationId, phone, messageText, messageId, pushName, traceId } = params;

  const parsed = parseFollowerOrder(messageText);
  if (!parsed.isFollowerOrder || !parsed.username || !parsed.quantity) {
    return { handled: false };
  }

  if (traceId) {
    TraceLogger.log(traceId, '05', 'ORDER PARSED', {
      username: parsed.username,
      quantity: parsed.quantity,
      phone,
    });
  }

  console.log(`[FOLLOWER_ORDER] Detected valid order from phone ${phone}: @${parsed.username}, quantity: ${parsed.quantity}`);
  const supabase = getAdminClient();

  // 1. Update contact with instagram_username
  await supabase
    .from('contacts')
    .update({
      instagram_username: parsed.username,
      updated_at: new Date().toISOString(),
    })
    .eq('id', contactId)
    .eq('account_id', accountId);

  // 2. Execute Instagram Profile Resolver to fetch real avatar
  console.log(`[FOLLOWER_ORDER] Resolving Instagram profile for @${parsed.username}...`);
  let profileImageUrl: string | null = null;
  try {
    const resolved = await InstagramProfileResolver.resolveContact(accountId, contactId, { forceRefresh: false });
    profileImageUrl = resolved.profileImageUrl || null;
    console.log(`[FOLLOWER_ORDER] Profile photo resolved: ${profileImageUrl ? 'FOUND' : 'NOT_FOUND'}`);
  } catch (resErr) {
    console.warn(`[FOLLOWER_ORDER] Profile resolver warning:`, resErr);
  }

  if (traceId) {
    TraceLogger.log(traceId, '06', 'INSTAGRAM RESOLVED', {
      username: parsed.username,
      profileImageUrl: profileImageUrl ? profileImageUrl.slice(0, 50) + '...' : null,
    });
  }

  // Fetch updated contact
  const { data: contact } = await supabase
    .from('contacts')
    .select('id, name, phone, profile_image_url, instagram_username')
    .eq('id', contactId)
    .single();

  if (traceId) {
    TraceLogger.log(traceId, '07', 'CONTACT UPDATED', {
      contactId,
      username: contact?.instagram_username || parsed.username,
      hasPhoto: !!contact?.profile_image_url,
    });
  }

  const finalAvatarUrl = contact?.profile_image_url || profileImageUrl || 'https://pps.whatsapp.net/v/t61.24694-24/placeholder.jpg';

  // 3. Generate Order Code & Idempotency Key
  const orderCode = `PED-${parsed.quantity}-${parsed.username.toUpperCase()}`;
  const idempotencyKey = `follower_order_${accountId}_${contactId}_${parsed.username}_${parsed.quantity}_${messageId}`;

  if (traceId) {
    TraceLogger.log(traceId, '08', 'ORDER CREATED', {
      orderCode,
      idempotencyKey,
    });
  }

  // 4. Resolve Follower Creative Template
  let templateId = FOLLOWER_TEMPLATE_ID;
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

  const renderContext = {
    title: 'CONFIRMAÇÃO DE PEDIDO',
    name: recipientName,
    code: orderCode,
    instagram_username: parsed.username,
    quantity: parsed.quantityFormatted || String(parsed.quantity),
    service: 'Seguidores Instagram',
    date: new Date().toLocaleDateString('pt-BR'),
    profile_image: finalAvatarUrl,
    amount: 'R$ 49,90',
    trace_id: traceId,
  };

  if (traceId) {
    TraceLogger.log(traceId, '09', 'CREATIVE JOB CREATED', {
      templateId,
      orderCode,
    });
  }

  // 6. Process Creative Job (Render -> Storage -> WhatsApp Delivery)
  console.log(`[FOLLOWER_ORDER] Triggering Creative Job for order #${orderCode}...`);
  const caption = `✅ *Confirmação de Pedido*\n\n` +
    `Olá *${recipientName}*, seu pedido de seguidores foi registrado com sucesso!\n\n` +
    `📌 *Código:* #${orderCode}\n` +
    `👤 *Instagram:* @${parsed.username}\n` +
    `🚀 *Quantidade:* ${parsed.quantityFormatted} seguidores\n` +
    `📦 *Serviço:* Seguidores Instagram\n\n` +
    `Agradecemos pela preferência!`;

  const job = await CreativeJobManager.processJob({
    accountId,
    templateId,
    sourceType: 'ORDER',
    sourceId: orderCode,
    creativeType: 'follower_confirmation',
    inputData: renderContext,
    idempotencyKey,
    deliver: true,
    deliveryOptions: {
      recipient: phone,
      caption,
      metadata: { traceId },
    },
  });

  if (traceId) {
    TraceLogger.log(traceId, '10', 'CREATIVE RENDERED', {
      jobId: job.id,
      dimensions: '960x960',
    });
    TraceLogger.log(traceId, '11', 'STORAGE UPLOAD', {
      jobId: job.id,
      outputUrl: job.output_url ? job.output_url.slice(0, 60) + '...' : null,
    });
  }

  console.log(`[FOLLOWER_ORDER] Job completed: ${job.id}, status: ${job.status}, output_url: ${job.output_url}`);

  return {
    handled: true,
    orderCode,
    username: parsed.username,
    quantity: parsed.quantity,
    profileImageUrl: finalAvatarUrl,
    creativeJob: job,
    deliverySuccess: job.status === 'SENT',
  };
}
