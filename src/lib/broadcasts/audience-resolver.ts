import { SupabaseClient } from '@supabase/supabase-js';
import { Contact } from '@/types';

export type AudienceType =
  | 'unpaid'          // Leads que não finalizaram a compra / não pagaram
  | 'new_24h'         // Leads novos das últimas 24 horas
  | 'new_24h_unpaid'  // Leads novos (24h) que não pagaram
  | 'tags'            // Por etiquetas (tags)
  | 'all'             // Toda a base
  | 'csv'             // Importar planilha CSV
  | 'custom_field';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export interface AudienceConfig {
  type: AudienceType;
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  excludeTagIds?: string[];
}

export interface AudienceCounts {
  totalContacts: number;
  unpaidCount: number;
  new24hCount: number;
  new24hUnpaidCount: number;
  paidCount: number;
}

/**
 * Returns a set of contact IDs that have confirmed paid purchases.
 * Sources:
 * 1. automation_logs (trigger_event = 'first_payment_approved', status = 'success')
 * 2. webhook_events (processing_status = 'COMPLETED')
 */
export async function getPaidContactIds(
  supabase: SupabaseClient,
  accountId?: string | null
): Promise<Set<string>> {
  const paidIds = new Set<string>();

  try {
    // 1. From automation_logs
    let logQuery = supabase
      .from('automation_logs')
      .select('contact_id')
      .eq('trigger_event', 'first_payment_approved')
      .eq('status', 'success');

    if (accountId) {
      logQuery = logQuery.eq('account_id', accountId);
    }

    const { data: logs } = await logQuery;
    for (const l of logs || []) {
      if (l.contact_id) paidIds.add(l.contact_id);
    }

    // 2. From completed webhook_events
    const { data: webhooks } = await supabase
      .from('webhook_events')
      .select('external_event_id, payload')
      .in('provider', ['buckpay', 'wiinpay'])
      .eq('processing_status', 'COMPLETED')
      .limit(200);

    for (const w of webhooks || []) {
      const ext = String(w.external_event_id || '');
      if (ext.startsWith('smm_')) {
        const parts = ext.split('_');
        if (parts[1] && parts[1].length >= 32) {
          paidIds.add(parts[1]);
        }
      }
    }
  } catch (err) {
    console.warn('[getPaidContactIds] Warning fetching paid contact IDs:', err);
  }

  return paidIds;
}

/**
 * Fetches quick summary counts for all smart audience segments.
 */
export async function fetchAudienceQuickCounts(
  supabase: SupabaseClient,
  accountId?: string | null
): Promise<AudienceCounts> {
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // 1. Total contacts
    let allQuery = supabase
      .from('contacts')
      .select('id, created_at');

    if (accountId) {
      allQuery = allQuery.eq('account_id', accountId);
    }

    const { data: contacts } = await allQuery;
    const allContacts = contacts || [];
    const totalContacts = allContacts.length;

    // 2. Paid contacts
    const paidIds = await getPaidContactIds(supabase, accountId);
    const paidCount = paidIds.size;

    // 3. Unpaid contacts
    const unpaidContacts = allContacts.filter((c) => !paidIds.has(c.id));
    const unpaidCount = unpaidContacts.length;

    // 4. New in last 24h
    const new24hContacts = allContacts.filter((c) => c.created_at && c.created_at >= oneDayAgo);
    const new24hCount = new24hContacts.length;

    // 5. New in last 24h who didn't pay
    const new24hUnpaidCount = new24hContacts.filter((c) => !paidIds.has(c.id)).length;

    return {
      totalContacts,
      unpaidCount,
      new24hCount,
      new24hUnpaidCount,
      paidCount,
    };
  } catch (err) {
    console.warn('[fetchAudienceQuickCounts] Error calculating counts:', err);
    return {
      totalContacts: 0,
      unpaidCount: 0,
      new24hCount: 0,
      new24hUnpaidCount: 0,
      paidCount: 0,
    };
  }
}

/**
 * Resolves contacts for a given AudienceConfig.
 * Handles:
 * - 'unpaid': leads without completed payments
 * - 'new_24h': leads created in the last 24 hours
 * - 'new_24h_unpaid': leads created in the last 24 hours without completed payments
 * - 'tags': filtered by tags
 * - 'all': all contacts in account
 * - 'custom_field': filtered by custom field
 */
export async function resolveBroadcastContacts(
  supabase: SupabaseClient,
  audience: AudienceConfig,
  accountId?: string | null
): Promise<Contact[]> {
  let contacts: Contact[] = [];
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  switch (audience.type) {
    case 'unpaid': {
      // All contacts of this account who haven't paid
      let q = supabase.from('contacts').select('*');
      if (accountId) q = q.eq('account_id', accountId);
      const { data, error } = await q;
      if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);

      const paidIds = await getPaidContactIds(supabase, accountId);
      contacts = (data || []).filter((c) => !paidIds.has(c.id));
      break;
    }

    case 'new_24h': {
      // Contacts created in the last 24 hours
      let q = supabase
        .from('contacts')
        .select('*')
        .gte('created_at', oneDayAgo);
      if (accountId) q = q.eq('account_id', accountId);
      const { data, error } = await q;
      if (error) throw new Error(`Failed to fetch new contacts: ${error.message}`);
      contacts = data || [];
      break;
    }

    case 'new_24h_unpaid': {
      // Contacts created in the last 24 hours who haven't paid
      let q = supabase
        .from('contacts')
        .select('*')
        .gte('created_at', oneDayAgo);
      if (accountId) q = q.eq('account_id', accountId);
      const { data, error } = await q;
      if (error) throw new Error(`Failed to fetch new contacts: ${error.message}`);

      const paidIds = await getPaidContactIds(supabase, accountId);
      contacts = (data || []).filter((c) => !paidIds.has(c.id));
      break;
    }

    case 'all': {
      let q = supabase.from('contacts').select('*');
      if (accountId) q = q.eq('account_id', accountId);
      const { data, error } = await q;
      if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
      contacts = data || [];
      break;
    }

    case 'tags': {
      if (audience.tagIds && audience.tagIds.length > 0) {
        const { data: contactTags, error: tagError } = await supabase
          .from('contact_tags')
          .select('contact_id')
          .in('tag_id', audience.tagIds);

        if (tagError) throw new Error(`Failed to fetch contact tags: ${tagError.message}`);

        if (contactTags && contactTags.length > 0) {
          const uniqueContactIds = [...new Set(contactTags.map((ct) => ct.contact_id))];
          contacts = [];
          const CHUNK_SIZE = 100;
          for (let i = 0; i < uniqueContactIds.length; i += CHUNK_SIZE) {
            const chunk = uniqueContactIds.slice(i, i + CHUNK_SIZE);
            let q = supabase.from('contacts').select('*').in('id', chunk);
            if (accountId) q = q.eq('account_id', accountId);
            const { data, error } = await q;
            if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
            if (data) contacts.push(...data);
          }
        }
      }
      break;
    }

    case 'custom_field': {
      if (audience.customField) {
        const { fieldId, operator, value } = audience.customField;
        let query = supabase
          .from('contact_custom_values')
          .select('contact_id')
          .eq('custom_field_id', fieldId);

        if (operator === 'is') query = query.eq('value', value);
        else if (operator === 'is_not') query = query.neq('value', value);
        else if (operator === 'contains') query = query.ilike('value', `%${value}%`);

        const { data: matches, error: matchErr } = await query;
        if (matchErr) throw new Error(`Custom-field filter failed: ${matchErr.message}`);

        const contactIds = [...new Set((matches || []).map((m) => m.contact_id))];
        if (contactIds.length > 0) {
          const CHUNK_SIZE = 100;
          for (let i = 0; i < contactIds.length; i += CHUNK_SIZE) {
            const chunk = contactIds.slice(i, i + CHUNK_SIZE);
            let q = supabase.from('contacts').select('*').in('id', chunk);
            if (accountId) q = q.eq('account_id', accountId);
            const { data, error } = await q;
            if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
            if (data) contacts.push(...data);
          }
        }
      }
      break;
    }

    default:
      contacts = [];
      break;
  }

  // Apply exclude tags (works across all contact-derived audience types)
  if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
    const { data: excludeRows } = await supabase
      .from('contact_tags')
      .select('contact_id')
      .in('tag_id', audience.excludeTagIds);

    const excludedIds = new Set((excludeRows || []).map((r) => r.contact_id));
    contacts = contacts.filter((c) => !excludedIds.has(c.id));
  }

  return contacts;
}
