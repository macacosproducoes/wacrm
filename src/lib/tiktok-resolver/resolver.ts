/**
 * TikTok Public Profile Resolver
 * Fetches publicly available TikTok profile metadata and avatar without requiring user credentials.
 */

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { parseTikTokUsername, buildTikTokProfileUrl } from './parser';
import { NEUTRAL_TIKTOK_AVATAR, type TikTokResolveResult } from './types';

const REQUEST_TIMEOUT_MS = 6000;

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createSupabaseClient(url, key);
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'");
}

function isSafeUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.startsWith('172.16.') ||
      host.endsWith('.local') ||
      host.endsWith('.internal')
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export class TikTokProfileResolver {
  /**
   * Resolves a public TikTok profile picture by username.
   */
  static async resolveProfile(username: string, accountId?: string): Promise<TikTokResolveResult> {
    const cleanUser = parseTikTokUsername(username);
    if (!cleanUser) {
      return {
        username,
        profileUrl: `https://www.tiktok.com/@${username}`,
        profileImageUrl: NEUTRAL_TIKTOK_AVATAR,
        resolveStatus: 'FAILED',
        error: 'Nome de usuário TikTok inválido.',
      };
    }

    const profileUrl = buildTikTokProfileUrl(cleanUser);

    try {
      console.log(`[TIKTOK_RESOLVER] Fetching public profile for @${cleanUser}...`);
      const userAgents = [
        'TelegramBot (like TwitterBot)',
        'Twitterbot/1.0',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      ];

      let rawImageUrl: string | null = null;

      for (const ua of userAgents) {
        try {
          const res = await fetch(profileUrl, {
            headers: {
              'User-Agent': ua,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
              'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });

          if (!res.ok) continue;

          const html = await res.text();

          // 1. Look for og:image meta tag
          const ogMatch =
            html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i) ||
            html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i);

          if (ogMatch && ogMatch[1]) {
            rawImageUrl = decodeXmlEntities(ogMatch[1].trim());
            break;
          }

          // 2. Look for universal data JSON
          const scriptMatch = html.match(
            /<script\s+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i
          );
          if (scriptMatch && scriptMatch[1]) {
            try {
              const json = JSON.parse(scriptMatch[1]);
              const userDetail = json?.['__DEFAULT_SCOPE__']?.['webapp.user-detail']?.userInfo?.user;
              const avatar = userDetail?.avatarLarger || userDetail?.avatarMedium || userDetail?.avatarThumb;
              if (avatar) {
                rawImageUrl = String(avatar).trim();
                break;
              }
            } catch {
              // Ignore JSON parse error
            }
          }
        } catch {
          // Try next UA
        }
      }

      if (!rawImageUrl || !isSafeUrl(rawImageUrl)) {
        console.warn(`[TIKTOK_RESOLVER] Could not extract public avatar for @${cleanUser}, using neutral avatar.`);
        return {
          username: cleanUser,
          profileUrl,
          profileImageUrl: NEUTRAL_TIKTOK_AVATAR,
          resolveStatus: 'IMAGE_UNAVAILABLE',
          error: 'Foto pública de perfil não encontrada ou restrita.',
        };
      }

      // Download and cache into Supabase Storage
      const imageRes = await fetch(rawImageUrl, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!imageRes.ok) {
        return {
          username: cleanUser,
          profileUrl,
          profileImageUrl: NEUTRAL_TIKTOK_AVATAR,
          resolveStatus: 'IMAGE_UNAVAILABLE',
          error: 'Falha ao baixar imagem de perfil do TikTok.',
        };
      }

      const buffer = Buffer.from(await imageRes.arrayBuffer());
      const contentType = imageRes.headers.get('content-type') || 'image/jpeg';

      const supabase = getAdminClient();
      if (supabase && accountId) {
        const storagePath = `account-${accountId}/tiktok/${cleanUser}-${Date.now()}.jpg`;
        const { error: uploadErr } = await supabase.storage
          .from('chat-media')
          .upload(storagePath, buffer, {
            contentType,
            upsert: true,
          });

        if (!uploadErr) {
          const { data: publicUrlData } = supabase.storage
            .from('chat-media')
            .getPublicUrl(storagePath);

          if (publicUrlData?.publicUrl) {
            console.log(`[TIKTOK_RESOLVER] Uploaded avatar to storage: ${publicUrlData.publicUrl}`);
            return {
              username: cleanUser,
              profileUrl,
              profileImageUrl: publicUrlData.publicUrl,
              resolveStatus: 'IMAGE_AVAILABLE',
            };
          }
        }
      }

      // Fallback to data URI if storage upload is unavailable
      const base64Data = `data:${contentType};base64,${buffer.toString('base64')}`;
      return {
        username: cleanUser,
        profileUrl,
        profileImageUrl: base64Data,
        resolveStatus: 'IMAGE_AVAILABLE',
      };
    } catch (err: unknown) {
      console.error(`[TIKTOK_RESOLVER] Unexpected error resolving @${cleanUser}:`, err);
      return {
        username: cleanUser,
        profileUrl,
        profileImageUrl: NEUTRAL_TIKTOK_AVATAR,
        resolveStatus: 'FAILED',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
