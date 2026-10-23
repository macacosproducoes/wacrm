import { SupabaseClient } from '@supabase/supabase-js';

export interface CheckPaymentEligibilityInput {
  paymentId?: string;
  externalId?: string;
  amount?: number;
  buyer?: {
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    document?: string | null;
  };
  offer?: {
    name?: string | null;
  };
  product?: {
    name?: string | null;
  };
  rawPayload?: Record<string, unknown>;
  accountId?: string;
}

export const DEFAULT_ACTIVE_ACCOUNT_ID = '512ca9fc-083c-4f59-ab46-7a065a370e77';

export interface PaymentEligibilityResult {
  isEligible: boolean;
  isSmmOrEdgarProduct: boolean;
  isExistingCrmClient: boolean;
  contactId?: string;
  accountId?: string;
  matchedBy?: 'external_id' | 'product_name' | 'contact_id' | 'phone' | 'email';
  reason: string;
}

/**
 * Keywords and prefixes identifying Edgar Katsumi SMM or Apoio VIP products.
 */
const SMM_EDGAR_REGEX = /(smm|seguidores|curtidas|visualiza[çc][õo]es|views|reels|instagram|painel\s*smm|edgar|katsumi|apoio\s*vip|apoiovip|mimos)/i;

/**
 * Known third-party / external products from other stores or accounts that do NOT belong to this CRM.
 */
const KNOWN_EXTERNAL_PRODUCTS_REGEX = /(close\s*friends|aerotri|jf\s*packs|jfpacks)/i;

/**
 * Validates whether a payment transaction received via Buckpay/Wiinpay
 * should trigger WhatsApp automation, CRM notifications, and audio alerts.
 *
 * RULE:
 * 1. Must be an SMM / Edgar Katsumi product (by external_id prefix or product/offer name), OR
 * 2. Must belong to an existing CRM client (matched by contact_id, phone, or email in the contacts table).
 *
 * If a transaction is for another product (e.g., "Close Friends") and the buyer is not an existing CRM lead,
 * it MUST be safely ignored to prevent sending audios or notifications for unrelated products.
 */
export async function checkPaymentEligibility(
  admin: SupabaseClient | null,
  input: CheckPaymentEligibilityInput
): Promise<PaymentEligibilityResult> {
  let accountId = input.accountId;
  if (!accountId || accountId === 'ce78c02b-49e0-43bf-b384-7cdd52f61b9f') {
    accountId = DEFAULT_ACTIVE_ACCOUNT_ID;
  }
  const extId = (input.externalId || '').trim();
  const raw = input.rawPayload || {};
  const rawData = (raw.data || {}) as Record<string, unknown>;
  const rawMeta = (raw.metadata || {}) as Record<string, unknown>;

  // 1. Collect all product / offer candidate names
  const candidateNames: string[] = [
    input.offer?.name,
    input.product?.name,
    (rawData.offer as Record<string, unknown>)?.name as string,
    (rawData.product as Record<string, unknown>)?.name as string,
    rawMeta.product_name as string,
    rawMeta.service_name as string,
    rawMeta.message as string,
    (raw.product as Record<string, unknown>)?.name as string,
    raw.product_name as string,
    raw.description as string,
  ].filter((n): n is string => typeof n === 'string' && n.trim().length > 0);

  const productText = candidateNames.join(' | ');

  // 2. Check if product is explicitly known to be external (e.g. "Close Friends Mensal")
  const isExplicitlyExternal =
    candidateNames.length > 0 &&
    candidateNames.some((name) => KNOWN_EXTERNAL_PRODUCTS_REGEX.test(name)) &&
    !candidateNames.some((name) => SMM_EDGAR_REGEX.test(name));

  // 3. Check SMM / Edgar signatures
  let isSmmOrEdgarProduct = false;
  let matchedBy: PaymentEligibilityResult['matchedBy'] = undefined;

  if (
    extId.startsWith('smm_') ||
    extId.startsWith('apoiovip_edgar_') ||
    extId.startsWith('edgar_') ||
    extId.startsWith('apoio-vip_')
  ) {
    isSmmOrEdgarProduct = true;
    matchedBy = 'external_id';
  } else if (!isExplicitlyExternal && SMM_EDGAR_REGEX.test(productText)) {
    isSmmOrEdgarProduct = true;
    matchedBy = 'product_name';
  }

  // 4. Check if buyer is an EXISTING CRM client
  let isExistingCrmClient = false;
  let matchedContactId: string | undefined = undefined;

  if (admin) {
    // 4a. Check contactId embedded in external_id (e.g. smm_<contact_id>_<timestamp>_<random>)
    if (extId.startsWith('smm_')) {
      const parts = extId.split('_');
      if (parts.length >= 3 && parts[1].length >= 32) {
        const potentialContactId = parts[1];
        const { data: c } = await admin
          .from('contacts')
          .select('id, account_id')
          .eq('id', potentialContactId)
          .maybeSingle();

        if (c?.id) {
          isExistingCrmClient = true;
          matchedContactId = c.id;
          matchedBy = matchedBy || 'contact_id';
          if (c.account_id) {
            accountId = c.account_id;
          }
        }
      }
    }

    // 4b. Check by buyer phone
    const buyerPhone = input.buyer?.phone || (rawMeta.phone as string);
    if (!matchedContactId && buyerPhone) {
      const rawDigits = String(buyerPhone).replace(/\D/g, '');
      if (rawDigits.length >= 8) {
        const last8 = rawDigits.slice(-8);
        const { data: c } = await admin
          .from('contacts')
          .select('id, phone')
          .eq('account_id', accountId)
          .or(`phone.ilike.%${last8}%,phone_normalized.ilike.%${last8}%`)
          .limit(1)
          .maybeSingle();

        if (c?.id) {
          isExistingCrmClient = true;
          matchedContactId = c.id;
          matchedBy = matchedBy || 'phone';
        } else {
          // Check recent conversation
          const { data: conv } = await admin
            .from('conversations')
            .select('contact_id')
            .eq('account_id', accountId)
            .ilike('customer_phone', `%${last8}%`)
            .not('contact_id', 'is', null)
            .limit(1)
            .maybeSingle();

          if (conv?.contact_id) {
            isExistingCrmClient = true;
            matchedContactId = conv.contact_id;
            matchedBy = matchedBy || 'phone';
          }
        }
      }
    }

    // 4c. Check by buyer email (only real customer emails, ignoring auto-generated smm_... emails)
    const buyerEmail = input.buyer?.email || (rawMeta.email as string);
    if (!matchedContactId && buyerEmail && !buyerEmail.includes('@painelsmm.com')) {
      const cleanEmail = buyerEmail.trim().toLowerCase();
      const { data: c } = await admin
        .from('contacts')
        .select('id')
        .eq('account_id', accountId)
        .eq('email', cleanEmail)
        .limit(1)
        .maybeSingle();

      if (c?.id) {
        isExistingCrmClient = true;
        matchedContactId = c.id;
        matchedBy = matchedBy || 'email';
      }
    }
  }

  // 5. Final decision:
  // Must be an SMM/Edgar product, OR an existing CRM client.
  // If explicitly external and NOT an existing CRM client, reject immediately.
  if (isExplicitlyExternal && !isExistingCrmClient) {
    return {
      isEligible: false,
      isSmmOrEdgarProduct: false,
      isExistingCrmClient: false,
      reason: `Produto externo não relacionado ao Edgar/SMM: "${productText || 'Sem nome'}"`,
    };
  }

  const isEligible = isSmmOrEdgarProduct || isExistingCrmClient;

  let reason = '';
  if (isSmmOrEdgarProduct && isExistingCrmClient) {
    reason = 'Produto SMM/Edgar com cliente cadastrado no CRM';
  } else if (isSmmOrEdgarProduct) {
    reason = 'Produto SMM/Edgar (novo pedido)';
  } else if (isExistingCrmClient) {
    reason = 'Cliente existente do CRM';
  } else {
    reason = `Produto externo ("${productText || extId || 'Desconhecido'}") e comprador não cadastrado no CRM`;
  }

  return {
    isEligible,
    isSmmOrEdgarProduct,
    isExistingCrmClient,
    contactId: matchedContactId,
    accountId,
    matchedBy,
    reason,
  };
}
