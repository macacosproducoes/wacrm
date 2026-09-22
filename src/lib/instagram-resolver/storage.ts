/**
 * Instagram Profile Resolver - Image Storage & Validation
 *
 * Downloads profile pictures with SSRF protection, inspects magic bytes via Sharp,
 * computes SHA-256 hash, and stores them under account-isolated Supabase Storage paths.
 */

import crypto from 'crypto';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';

const STORAGE_BUCKET = 'chat-media';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Supabase URL or Service Role Key missing in environment.');
  }
  return createSupabaseClient(url, key);
}

export interface ValidatedProfileImage {
  buffer: Buffer;
  hash: string;
  width: number;
  height: number;
  format: string;
}

export interface StoredProfileImageResult {
  publicUrl: string;
  path: string;
  hash: string;
  width: number;
  height: number;
}

export class InstagramImageStorage {
  /**
   * Downloads and validates an image from an external URL or data URI.
   * Enforces SSRF protection, size caps, and Sharp image parsing.
   */
  static async downloadAndValidate(sourceUrl: string): Promise<ValidatedProfileImage> {
    let rawBuffer: Buffer;

    if (sourceUrl.startsWith('data:image/')) {
      const commaIndex = sourceUrl.indexOf(',');
      if (commaIndex === -1) {
        throw new Error('Invalid data URI format');
      }
      const base64Data = sourceUrl.slice(commaIndex + 1);
      rawBuffer = Buffer.from(base64Data, 'base64');
    } else {
      // 1. Download with secure redirect follower & SSRF protection
      let currentUrl = sourceUrl;
      let hops = 0;
      let res: Response | null = null;

      while (true) {
        const isDeliverable = await isDeliverableUrl(currentUrl);
        if (!isDeliverable) {
          throw new Error('SSRF Block: Refusing to download profile image from private or non-public address.');
        }

        res = await fetch(currentUrl, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Referer': 'https://www.instagram.com/',
          },
          signal: AbortSignal.timeout(10000),
          redirect: 'manual',
        });

        // Follow 3xx redirects securely validating each hop
        if (res.status >= 300 && res.status < 400) {
          hops++;
          if (hops > 5) {
            throw new Error('Too many redirects while downloading profile image');
          }
          const location = res.headers.get('location');
          if (!location) {
            throw new Error(`HTTP ${res.status} redirect without Location header`);
          }
          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }

        break;
      }

      if (!res || !res.ok) {
        throw new Error(`Failed to download profile image: HTTP ${res ? res.status : 'NO_RESPONSE'}`);
      }

      const arrayBuffer = await res.arrayBuffer();
      rawBuffer = Buffer.from(arrayBuffer);
    }

    if (rawBuffer.length > MAX_IMAGE_BYTES) {
      throw new Error(`Profile image exceeds size limit of ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
    }

    // 3. Inspect real image bytes using Sharp (ensures valid JPEG/PNG/WebP, not disguised executable)
    const sharpModule = (await import('sharp')).default;
    const imageInstance = sharpModule(rawBuffer);
    const metadata = await imageInstance.metadata();

    if (!metadata.format || !['jpeg', 'png', 'webp', 'svg', 'gif'].includes(metadata.format)) {
      throw new Error(`Invalid or unsupported image format: ${metadata.format || 'unknown'}`);
    }

    // 4. Convert to normalized PNG for crisp deterministic storage
    const normalizedBuffer = await imageInstance
      .png({ quality: 90 })
      .toBuffer();

    // 5. Calculate SHA-256 hash
    const hash = crypto.createHash('sha256').update(normalizedBuffer).digest('hex');

    return {
      buffer: normalizedBuffer,
      hash,
      width: metadata.width || 300,
      height: metadata.height || 300,
      format: 'png',
    };
  }

  /**
   * Stores profile image into Supabase Storage with predictable account-isolated path
   */
  static async storeProfileImage(params: {
    accountId: string;
    contactId: string;
    buffer: Buffer;
    hash: string;
  }): Promise<StoredProfileImageResult> {
    const { accountId, contactId, buffer, hash } = params;
    const supabase = getAdminClient();

    const shortHash = hash.slice(0, 16);
    const path = `account-${accountId}/contacts/${contactId}/instagram_avatar_${shortHash}.png`;

    try {
      const { error: uploadErr } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(path, buffer, {
          contentType: 'image/png',
          upsert: true,
        });

      if (uploadErr) {
        console.warn(`[INSTAGRAM_STORAGE] Storage upload warning: ${uploadErr.message}. Utilizing resilient data URI fallback.`);
        const base64DataUri = `data:image/png;base64,${buffer.toString('base64')}`;
        return {
          publicUrl: base64DataUri,
          path,
          hash,
          width: 300,
          height: 300,
        };
      }

      const { data: urlData } = supabase.storage
        .from(STORAGE_BUCKET)
        .getPublicUrl(path);

      const sharpModule = (await import('sharp')).default;
      const meta = await sharpModule(buffer).metadata();

      // Append version query param to guarantee fresh rendering and bypass CDN cache
      const finalUrl = `${urlData.publicUrl}?v=${shortHash}`;

      return {
        publicUrl: finalUrl,
        path,
        hash,
        width: meta.width || 300,
        height: meta.height || 300,
      };
    } catch (storageErr) {
      console.warn(`[INSTAGRAM_STORAGE] Unexpected storage failure, using data URI fallback:`, storageErr);
      const base64DataUri = `data:image/png;base64,${buffer.toString('base64')}`;
      return {
        publicUrl: base64DataUri,
        path,
        hash,
        width: 300,
        height: 300,
      };
    }
  }
}
