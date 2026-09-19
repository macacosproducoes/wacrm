/**
 * Instagram Profile Resolver Service
 *
 * Coordinates profile resolution, caching, TTL, image hashing,
 * storage, and contact updates with full multi-tenant isolation.
 */

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import type {
  ResolvedContactInstagram,
  ResolveProfileOptions,
  InstagramProfileData,
} from './types';
import { parseInstagramUsername, buildInstagramProfileUrl } from './parser';
import { getInstagramProfileProvider } from './providers/factory';
import { ApiInstagramProfileProvider } from './providers/api-provider';
import { InstagramImageStorage } from './storage';

const DEFAULT_TTL_HOURS = 24;

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Supabase credentials missing.');
  }
  return createSupabaseClient(url, key);
}

export class InstagramProfileResolver {
  /**
   * Resolves Instagram profile for a contact, respecting cache, TTL, and manual overrides.
   */
  static async resolveContact(
    accountId: string,
    contactId: string,
    options: ResolveProfileOptions = {}
  ): Promise<ResolvedContactInstagram> {
    const supabase = getAdminClient();
    const ttlHours = options.ttlHours || DEFAULT_TTL_HOURS;

    // 1. Fetch current contact state
    const { data: contact, error: fetchErr } = await supabase
      .from('contacts')
      .select('*')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .single();

    if (fetchErr || !contact) {
      throw new Error(`Contact not found: ${contactId}`);
    }

    const rawUsername = contact.instagram_username;
    const normalizedUsername = parseInstagramUsername(rawUsername);

    if (!normalizedUsername) {
      return {
        contactId,
        instagramUsername: '',
        instagramUrl: '',
        profileImageUrl: contact.profile_image_url || null,
        profileImageSource: contact.profile_image_source || 'INSTAGRAM_PROVIDER',
        resolveStatus: 'NOT_REQUESTED',
        updatedAt: new Date().toISOString(),
      };
    }

    console.log(`[INSTAGRAM] INSTAGRAM_DETECTED: @${normalizedUsername} for contact ${contactId}`);
    console.log(`[INSTAGRAM] INSTAGRAM_NORMALIZED: ${normalizedUsername}`);

    // 2. Rule: Never overwrite a MANUAL photo automatically unless forceRefresh is true
    if (contact.profile_image_source === 'MANUAL' && !options.forceRefresh && contact.profile_image_url) {
      console.log(`[INSTAGRAM] Preserving manual photo for contact ${contactId}`);
      return {
        contactId,
        instagramUsername: normalizedUsername,
        instagramUrl: buildInstagramProfileUrl(normalizedUsername),
        profileImageUrl: contact.profile_image_url,
        profileImageSource: 'MANUAL',
        resolveStatus: 'IMAGE_AVAILABLE',
        hash: contact.profile_image_hash,
        updatedAt: contact.profile_image_updated_at || new Date().toISOString(),
      };
    }

    // 3. Cache & TTL Check
    if (
      !options.forceRefresh &&
      contact.instagram_resolve_status === 'IMAGE_AVAILABLE' &&
      contact.profile_image_url &&
      contact.profile_image_updated_at
    ) {
      const lastUpdatedMs = new Date(contact.profile_image_updated_at).getTime();
      const ageHours = (Date.now() - lastUpdatedMs) / (1000 * 60 * 60);

      if (ageHours < ttlHours) {
        console.log(`[INSTAGRAM] Cache HIT for @${normalizedUsername} (age: ${ageHours.toFixed(1)}h < ${ttlHours}h)`);
        return {
          contactId,
          instagramUsername: normalizedUsername,
          instagramUrl: buildInstagramProfileUrl(normalizedUsername),
          profileImageUrl: contact.profile_image_url,
          profileImageSource: contact.profile_image_source || 'STORED',
          resolveStatus: 'IMAGE_AVAILABLE',
          hash: contact.profile_image_hash,
          updatedAt: contact.profile_image_updated_at,
        };
      }
    }

    // 4. Set state to RESOLVING
    await supabase
      .from('contacts')
      .update({
        instagram_resolve_status: 'RESOLVING',
        instagram_last_attempt_at: new Date().toISOString(),
        instagram_attempt_count: (contact.instagram_attempt_count || 0) + 1,
      })
      .eq('id', contactId)
      .eq('account_id', accountId);

    console.log(`[INSTAGRAM] PROFILE_RESOLUTION_STARTED for @${normalizedUsername}`);

    try {
      // 5. Query Provider (Direct provider by default, with optional API fallback)
      const provider = getInstagramProfileProvider(options.providerName);
      let profileData: InstagramProfileData;

      try {
        profileData = await provider.resolve(normalizedUsername);
      } catch (directErr) {
        // If direct provider threw and an external API provider is configured, attempt fallback
        if (
          provider.providerName === 'direct' &&
          (process.env.INSTAGRAM_PROFILE_API_URL || process.env.INSTAGRAM_PROFILE_API_KEY)
        ) {
          console.warn(`[INSTAGRAM] Direct provider failed, attempting configured API fallback...`, directErr);
          const apiFallback = new ApiInstagramProfileProvider();
          profileData = await apiFallback.resolve(normalizedUsername);
        } else {
          throw directErr;
        }
      }

      // If direct provider returned without an image, and external API is configured, attempt API fallback
      if (
        !profileData.profileImageUrl &&
        provider.providerName === 'direct' &&
        (process.env.INSTAGRAM_PROFILE_API_URL || process.env.INSTAGRAM_PROFILE_API_KEY)
      ) {
        try {
          console.log(`[INSTAGRAM] Direct provider found no image, attempting configured API fallback...`);
          const apiFallback = new ApiInstagramProfileProvider();
          const fallbackData = await apiFallback.resolve(normalizedUsername);
          if (fallbackData.profileImageUrl) {
            profileData = fallbackData;
          }
        } catch (fallbackErr) {
          console.warn(`[INSTAGRAM] Fallback API provider attempt failed:`, fallbackErr);
        }
      }

      console.log(`[INSTAGRAM] PROFILE_RESOLUTION_SUCCESS from provider ${provider.providerName}`);

      let finalImageUrl = contact.profile_image_url || null;
      let finalHash = contact.profile_image_hash || null;
      let resolveStatus = 'IMAGE_UNAVAILABLE';

      // 6. Handle Profile Picture
      if (profileData.profileImageUrl) {
        console.log(`[INSTAGRAM] Downloading profile image from ${profileData.profileImageUrl.slice(0, 60)}...`);
        const validated = await InstagramImageStorage.downloadAndValidate(profileData.profileImageUrl);
        console.log(`[INSTAGRAM] PROFILE_IMAGE_DOWNLOADED (${validated.buffer.length} bytes, hash: ${validated.hash.slice(0, 10)})`);

        // Check if image hash is unchanged
        if (!options.forceRefresh && contact.profile_image_hash === validated.hash && contact.profile_image_url) {
          console.log(`[INSTAGRAM] Image hash matches stored hash. Reusing existing storage URL.`);
          finalImageUrl = contact.profile_image_url;
          finalHash = validated.hash;
        } else {
          // Store in Supabase Storage
          const stored = await InstagramImageStorage.storeProfileImage({
            accountId,
            contactId,
            buffer: validated.buffer,
            hash: validated.hash,
          });
          finalImageUrl = stored.publicUrl;
          finalHash = stored.hash;
          console.log(`[INSTAGRAM] PROFILE_IMAGE_STORED: ${stored.publicUrl}`);
        }

        resolveStatus = 'IMAGE_AVAILABLE';
      } else {
        console.log(`[INSTAGRAM] PROFILE_IMAGE_UNAVAILABLE for @${normalizedUsername}`);
        resolveStatus = 'IMAGE_UNAVAILABLE';
      }

      // 7. Update Contact in DB (CRITICAL: NEVER touch contact.avatar_url, which belongs strictly to WhatsApp)
      const updates: Record<string, unknown> = {
        instagram_username: normalizedUsername,
        instagram_url: profileData.profileUrl || buildInstagramProfileUrl(normalizedUsername),
        profile_image_url: finalImageUrl,
        profile_image_source: 'INSTAGRAM_PROVIDER',
        profile_image_updated_at: new Date().toISOString(),
        profile_image_hash: finalHash,
        instagram_resolve_status: resolveStatus,
        instagram_last_error: resolveStatus === 'IMAGE_UNAVAILABLE' ? 'IMAGE_UNAVAILABLE: Perfil não possui foto pública ou está inacessível' : null,
      };

      await supabase
        .from('contacts')
        .update(updates)
        .eq('id', contactId)
        .eq('account_id', accountId);

      return {
        contactId,
        instagramUsername: normalizedUsername,
        instagramUrl: profileData.profileUrl,
        profileImageUrl: finalImageUrl,
        profileImageSource: 'INSTAGRAM_PROVIDER',
        resolveStatus: resolveStatus as any,
        hash: finalHash,
        updatedAt: updates.profile_image_updated_at as string,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[INSTAGRAM] PROFILE_RESOLUTION_FAILED for @${normalizedUsername}:`, errorMsg);

      let formattedError = errorMsg;
      if (errorMsg.includes('429')) {
        formattedError = `INSTAGRAM_HTTP_429: ${errorMsg}`;
      } else if (errorMsg.includes('404') || errorMsg.toLowerCase().includes('not found')) {
        formattedError = `INSTAGRAM_PROFILE_NOT_FOUND: ${errorMsg}`;
      } else if (errorMsg.toLowerCase().includes('storage') || errorMsg.toLowerCase().includes('upload')) {
        formattedError = `STORAGE_UPLOAD_FAILED: ${errorMsg}`;
      } else if (errorMsg.toLowerCase().includes('invalid')) {
        formattedError = `IMAGE_INVALID: ${errorMsg}`;
      } else if (errorMsg.toLowerCase().includes('timeout') || errorMsg.toLowerCase().includes('abort')) {
        formattedError = `IMAGE_URL_UNREACHABLE: ${errorMsg}`;
      }

      await supabase
        .from('contacts')
        .update({
          instagram_resolve_status: 'FAILED',
          instagram_last_error: formattedError,
        })
        .eq('id', contactId)
        .eq('account_id', accountId);

      return {
        contactId,
        instagramUsername: normalizedUsername,
        instagramUrl: buildInstagramProfileUrl(normalizedUsername),
        profileImageUrl: contact.profile_image_url || null,
        profileImageSource: contact.profile_image_source || 'INSTAGRAM_PROVIDER',
        resolveStatus: 'FAILED',
        updatedAt: new Date().toISOString(),
        error: formattedError,
      };
    }
  }

  /**
   * Sets an explicit manual photo for a contact (e.g. uploaded by agent or sent via WhatsApp).
   * Will not be overwritten by automatic resolvers.
   */
  static async setManualPhoto(
    accountId: string,
    contactId: string,
    imageSource: string | Buffer
  ): Promise<ResolvedContactInstagram> {
    const supabase = getAdminClient();
    console.log(`[INSTAGRAM] MANUAL_PROFILE_IMAGE_UPLOADED for contact ${contactId}`);

    let validated;
    if (Buffer.isBuffer(imageSource)) {
      const sharpInstance = require('sharp')(imageSource);
      const meta = await sharpInstance.metadata();
      const normalized = await sharpInstance.png({ quality: 90 }).toBuffer();
      const hash = require('crypto').createHash('sha256').update(normalized).digest('hex');
      validated = { buffer: normalized, hash, width: meta.width || 300, height: meta.height || 300 };
    } else {
      validated = await InstagramImageStorage.downloadAndValidate(imageSource);
    }

    const stored = await InstagramImageStorage.storeProfileImage({
      accountId,
      contactId,
      buffer: validated.buffer,
      hash: validated.hash,
    });

    const now = new Date().toISOString();
    await supabase
      .from('contacts')
      .update({
        profile_image_url: stored.publicUrl,
        profile_image_source: 'MANUAL',
        profile_image_updated_at: now,
        profile_image_hash: stored.hash,
        instagram_resolve_status: 'IMAGE_AVAILABLE',
        instagram_last_error: null,
      })
      .eq('id', contactId)
      .eq('account_id', accountId);

    const { data: contact } = await supabase
      .from('contacts')
      .select('instagram_username')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .single();

    return {
      contactId,
      instagramUsername: contact?.instagram_username || '',
      instagramUrl: contact?.instagram_username ? buildInstagramProfileUrl(contact.instagram_username) : '',
      profileImageUrl: stored.publicUrl,
      profileImageSource: 'MANUAL',
      resolveStatus: 'IMAGE_AVAILABLE',
      hash: stored.hash,
      updatedAt: now,
    };
  }

  /**
   * Removes an Instagram profile photo from a contact.
   * CRITICAL: Leaves contact.avatar_url (WhatsApp photo) completely untouched.
   */
  static async removePhoto(accountId: string, contactId: string): Promise<void> {
    const supabase = getAdminClient();

    await supabase
      .from('contacts')
      .update({
        profile_image_url: null,
        profile_image_hash: null,
        profile_image_source: 'INSTAGRAM_PROVIDER',
        instagram_resolve_status: 'IMAGE_UNAVAILABLE',
        instagram_last_error: 'Foto do Instagram removida manualmente.',
      })
      .eq('id', contactId)
      .eq('account_id', accountId);
  }
}
