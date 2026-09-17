/**
 * Instagram Profile Resolver - Image Storage & Validation
 *
 * Downloads profile pictures with SSRF protection, inspects magic bytes via Sharp,
 * computes SHA-256 hash, and stores them under account-isolated Supabase Storage paths.
 */

import crypto from 'crypto';
import sharp from 'sharp';
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
      // 1. SSRF Protection on external URL
      const isDeliverable = await isDeliverableUrl(sourceUrl);
      if (!isDeliverable) {
        throw new Error('SSRF Block: Refusing to download profile image from private or non-public address.');
      }

      // 2. Download with timeout
      const res = await fetch(sourceUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'WACRM-InstagramResolver/1.0',
          'Accept': 'image/jpeg,image/png,image/webp,image/*;q=0.8',
        },
        signal: AbortSignal.timeout(6000),
        redirect: 'manual',
      });

      if (!res.ok) {
        throw new Error(`Failed to download profile image: HTTP ${res.status}`);
      }

      const arrayBuffer = await res.arrayBuffer();
      rawBuffer = Buffer.from(arrayBuffer);
    }

    if (rawBuffer.length > MAX_IMAGE_BYTES) {
      throw new Error(`Profile image exceeds size limit of ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
    }

    // 3. Inspect real image bytes using Sharp (ensures valid JPEG/PNG/WebP, not disguised executable)
    const imageInstance = sharp(rawBuffer);
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

    const { error: uploadErr } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(path, buffer, {
        contentType: 'image/png',
        upsert: true,
      });

    if (uploadErr) {
      throw new Error(`Failed to store profile image: ${uploadErr.message}`);
    }

    const { data: urlData } = supabase.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(path);

    const meta = await sharp(buffer).metadata();

    return {
      publicUrl: urlData.publicUrl,
      path,
      hash,
      width: meta.width || 300,
      height: meta.height || 300,
    };
  }
}
