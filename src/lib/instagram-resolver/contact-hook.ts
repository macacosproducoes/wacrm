/**
 * Instagram Contact Hook
 *
 * Automatically inspects incoming messages for Instagram handles, updates the contact,
 * and kicks off asynchronous background resolution without blocking the webhook or AI agent.
 */

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { extractInstagramIdentifier } from './parser';
import { InstagramProfileResolver } from './resolver';

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Supabase credentials missing.');
  }
  return createSupabaseClient(url, key);
}

export interface HandleInboundMessageInstagramResult {
  detected: boolean;
  multipleDetected?: boolean;
  username?: string;
  allUsernames?: string[];
  contactUpdated?: boolean;
}

/**
 * Non-blocking hook invoked on incoming messages to detect Instagram handles
 */
export async function handleInboundMessageInstagram(params: {
  accountId: string;
  contactId: string;
  messageText: string;
}): Promise<HandleInboundMessageInstagramResult> {
  const { accountId, contactId, messageText } = params;

  if (!messageText || !contactId) {
    return { detected: false };
  }

  const detection = extractInstagramIdentifier(messageText);
  if (!detection.detected) {
    return { detected: false };
  }

  if (detection.multipleDetected) {
    console.log(`[INSTAGRAM] MULTIPLE_PROFILES_DETECTED in message:`, detection.allUsernames);
    return {
      detected: true,
      multipleDetected: true,
      allUsernames: detection.allUsernames,
    };
  }

  const username = detection.username!;
  console.log(`[INSTAGRAM] Single handle detected in message: @${username} for contact ${contactId}`);

  try {
    const supabase = getAdminClient();

    // Check existing contact to see if handle changed
    const { data: contact } = await supabase
      .from('contacts')
      .select('instagram_username, profile_image_source')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .single();

    const handleChanged = contact?.instagram_username !== username;

    if (handleChanged) {
      console.log(`[INSTAGRAM] Updating contact handle to @${username}`);
      await supabase
        .from('contacts')
        .update({
          instagram_username: username,
          instagram_url: detection.profileUrl,
          instagram_resolve_status: 'PENDING',
        })
        .eq('id', contactId)
        .eq('account_id', accountId);

      // Trigger background resolution (fire-and-forget, never block response)
      void InstagramProfileResolver.resolveContact(accountId, contactId).catch((err) => {
        console.warn(`[INSTAGRAM] Background resolution error for @${username}:`, err);
      });
    }

    return {
      detected: true,
      multipleDetected: false,
      username,
      contactUpdated: handleChanged,
    };
  } catch (err) {
    console.warn(`[INSTAGRAM] Error in handleInboundMessageInstagram:`, err);
    return {
      detected: true,
      username,
      contactUpdated: false,
    };
  }
}
