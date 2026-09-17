/**
 * Creative Engine - Storage Manager
 *
 * Saves generated creative assets into the CRM's Supabase Storage bucket following
 * the account-isolated conventions (account-<accountId>/creatives/...).
 */

import { createClient as createSupabaseClient } from '@supabase/supabase-js';

const STORAGE_BUCKET = 'chat-media';

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Supabase URL or Service Role Key missing in environment.');
  }

  return createSupabaseClient(url, key);
}

export interface CreativeStorageUploadOptions {
  accountId: string;
  templateId: string;
  templateVersion: number;
  sourceType: string;
  sourceId: string;
  fileName?: string;
}

export interface CreativeStorageUploadResult {
  path: string;
  publicUrl: string;
}

export class CreativeStorage {
  /**
   * Generates standard object path:
   * account-<accountId>/creatives/<templateId>/v<version>/<sourceType>-<sourceId>-<timestamp>.png
   */
  static buildPath(options: CreativeStorageUploadOptions): string {
    const { accountId, templateId, templateVersion, sourceType, sourceId, fileName } = options;
    const cleanSourceType = (sourceType || 'manual').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const cleanSourceId = (sourceId || 'default').replace(/[^a-z0-9_-]/g, '_').slice(0, 30);
    const time = Date.now();
    const finalName = fileName || `${cleanSourceType}-${cleanSourceId}-${time}.png`;

    return `account-${accountId}/creatives/${templateId}/v${templateVersion}/${finalName}`;
  }

  /**
   * Uploads rendered creative PNG buffer to Supabase Storage
   */
  static async uploadCreative(
    buffer: Buffer,
    options: CreativeStorageUploadOptions
  ): Promise<CreativeStorageUploadResult> {
    const supabase = getAdminClient();
    const path = this.buildPath(options);

    const { error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(path, buffer, {
        contentType: 'image/png',
        upsert: true,
      });

    if (uploadError) {
      console.error('[Creative Engine:Storage] Failed to upload creative:', uploadError);
      throw new Error(`Failed to upload creative to storage: ${uploadError.message}`);
    }

    const { data: urlData } = supabase.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(path);

    return {
      path,
      publicUrl: urlData.publicUrl,
    };
  }

  /**
   * Deletes a creative from storage
   */
  static async deleteCreative(path: string): Promise<void> {
    const supabase = getAdminClient();
    await supabase.storage.from(STORAGE_BUCKET).remove([path]);
  }
}
