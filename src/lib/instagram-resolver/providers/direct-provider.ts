/**
 * Direct Instagram Profile Provider
 *
 * Fetches publicly available metadata directly from Instagram's public profile page
 * using server-side fetching, standard web metadata parsing (Open Graph, Twitter Cards,
 * Schema.org JSON-LD, inlined script payloads), and strict SSRF / security safeguards.
 *
 * Does not require external paid APIs or scrapers.
 * Does not require user credentials, passwords, or session cookies.
 */

import type { InstagramProfileProvider } from './provider';
import type { InstagramProfileData } from '../types';
import { parseInstagramUsername, buildInstagramProfileUrl } from '../parser';

const REQUEST_TIMEOUT_MS = 8000;

// Whitelisted social preview crawlers (Instagram guarantees public Open Graph metadata without 429 or login walls)
const USER_AGENTS = [
  'WhatsApp/2.21.12.21 A',
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'Twitterbot/1.0',
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'TelegramBot (like TwitterBot)',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/bot.html)',
];

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#064;/g, '@')
    .replace(/&#x2022;/g, '•')
    .replace(/&#8226;/g, '•');
}

/**
 * Checks if an image URL is a Meta generic/fallback placeholder rather than a real user avatar.
 */
function isStaticPlaceholder(url: string | null | undefined): boolean {
  if (!url) return true;
  const lower = url.toLowerCase();
  return (
    lower.includes('rsrc.php') ||
    lower.includes('khwimm5b8pw') ||
    lower.includes('no-avatar') ||
    lower.includes('default-avatar') ||
    lower.includes('placeholder') ||
    lower.includes('transparent.png')
  );
}

export class DirectInstagramProfileProvider implements InstagramProfileProvider {
  readonly providerName = 'direct';

  async resolve(username: string): Promise<InstagramProfileData> {
    const cleanUsername = parseInstagramUsername(username);
    if (!cleanUsername) {
      throw new Error(`Invalid Instagram username: "${username}"`);
    }

    const profileUrl = buildInstagramProfileUrl(cleanUsername);
    console.log(`[INSTAGRAM_DIRECT] Resolving @${cleanUsername} directly via ${profileUrl}`);

    let lastError: Error | null = null;
    let is404 = false;

    // Strategy 1: Direct Instagram Open Graph / Schema / Inlined JSON
    for (let i = 0; i < USER_AGENTS.length; i++) {
      const ua = USER_AGENTS[i];
      try {
        const result = await this.fetchAndExtract(cleanUsername, profileUrl, ua);
        if (result && result.profileImageUrl && !isStaticPlaceholder(result.profileImageUrl)) {
          console.log(`[INSTAGRAM_DIRECT] Successfully resolved photo for @${cleanUsername} directly on attempt ${i + 1}`);
          return result;
        } else if (result && result.displayName && result.displayName !== cleanUsername) {
          // If we found profile info (name, bio) but no photo, check Threads for the photo
          const threadsFallback = await this.fetchViaThreads(cleanUsername, profileUrl);
          if (threadsFallback?.profileImageUrl) {
            return {
              ...result,
              profileImageUrl: threadsFallback.profileImageUrl,
            };
          }
          return result;
        }
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.message.includes('Unexpected redirect domain')) {
          throw error;
        }
        if (error.message.includes('404')) {
          is404 = true;
          lastError = error;
          break; // Profile does not exist on Instagram
        }
        if (error.message.includes('429')) {
          console.warn(`[INSTAGRAM_DIRECT] Direct attempt hit 429 rate limit. Switching immediately to Meta Threads fallback...`);
          lastError = error;
          break; // Break early to avoid waiting through all UAs on an IP-level rate limit
        }
        lastError = error;
        console.warn(`[INSTAGRAM_DIRECT] Direct attempt ${i + 1} for @${cleanUsername} failed: ${lastError.message}`);
      }
    }

    if (is404 && lastError) {
      throw lastError;
    }

    // Strategy 2: Meta Threads.net Open Graph fallback
    // Ordinary/common Instagram profiles are often blocked on direct instagram.com from datacenter/cloud IPs (HTTP 429),
    // but Meta serves their exact Instagram CDN avatar publicly via Threads.net Open Graph without rate limiting.
    console.log(`[INSTAGRAM_DIRECT] Attempting Meta Threads Open Graph fallback for @${cleanUsername}...`);
    try {
      const threadsResult = await this.fetchViaThreads(cleanUsername, profileUrl);
      if (threadsResult && threadsResult.profileImageUrl) {
        console.log(`[INSTAGRAM_DIRECT] Successfully resolved photo for @${cleanUsername} via Threads Open Graph!`);
        return threadsResult;
      }
    } catch (threadsErr: unknown) {
      console.warn(`[INSTAGRAM_DIRECT] Threads fallback failed for @${cleanUsername}:`, threadsErr);
    }

    return {
      username: cleanUsername,
      profileUrl,
      profileImageUrl: null,
      displayName: cleanUsername,
      source: 'INSTAGRAM_PROVIDER',
      fetchedAt: new Date().toISOString(),
    };
  }

  private async fetchViaThreads(
    username: string,
    profileUrl: string
  ): Promise<InstagramProfileData | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const threadsUrl = `https://www.threads.net/@${username}`;
      const response = await fetch(threadsUrl, {
        headers: {
          'User-Agent': 'WhatsApp/2.21.12.21 A',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
          'Cache-Control': 'no-cache',
        },
        redirect: 'follow',
        signal: controller.signal,
      });

      if (!response.ok) {
        return null;
      }

      // Check redirected URL SSRF
      if (response.url) {
        const finalHost = new URL(response.url).hostname.toLowerCase();
        if (!finalHost.endsWith('threads.net')) {
          return null;
        }
      }

      const html = await response.text();

      // Extract og:image or twitter:image
      const ogMatch =
        html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/i) ||
        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i);

      let profileImageUrl: string | null = null;
      if (ogMatch && ogMatch[1]) {
        const candidate = decodeHtmlEntities(ogMatch[1].trim());
        if (candidate.startsWith('http') && !isStaticPlaceholder(candidate)) {
          profileImageUrl = candidate;
        }
      }

      // Extract Display Name
      let displayName = username;
      const titleMatch =
        html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
        html.match(/<title>([^<]+)<\/title>/i);

      if (titleMatch && titleMatch[1]) {
        const cleanTitle = decodeHtmlEntities(titleMatch[1]);
        const namePart = cleanTitle.split(/[(•|]/)[0]?.trim();
        if (namePart && namePart.length > 0 && namePart !== 'Threads') {
          displayName = namePart;
        }
      }

      // Extract Biography
      let biography: string | undefined;
      const descMatch =
        html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
        html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);

      if (descMatch && descMatch[1]) {
        biography = decodeHtmlEntities(descMatch[1].trim());
      }

      if (!profileImageUrl) {
        return null;
      }

      return {
        username,
        profileUrl,
        profileImageUrl,
        displayName,
        biography,
        source: 'INSTAGRAM_PROVIDER',
        fetchedAt: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async fetchAndExtract(
    username: string,
    profileUrl: string,
    userAgent: string
  ): Promise<InstagramProfileData | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(profileUrl, {
        headers: {
          'User-Agent': userAgent,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
        },
        redirect: 'follow',
        signal: controller.signal,
      });

      if (response.status === 404) {
        throw new Error(`Instagram profile not found: @${username} (HTTP 404)`);
      }

      if (!response.ok) {
        throw new Error(`Instagram responded with HTTP status ${response.status}`);
      }

      // Check redirected URL to ensure it stayed on instagram.com (SSRF guard)
      if (response.url) {
        const finalHost = new URL(response.url).hostname.toLowerCase();
        if (!finalHost.endsWith('instagram.com')) {
          throw new Error(`Unexpected redirect domain: ${finalHost}`);
        }
      }

      const html = await response.text();

      // 1. Extract profile image from Open Graph / Twitter Card
      let profileImageUrl: string | null = null;
      const ogMatch =
        html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/i) ||
        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i);

      if (ogMatch && ogMatch[1]) {
        profileImageUrl = decodeHtmlEntities(ogMatch[1].trim());
      }

      // 2. Fallback: Extract from Schema.org JSON-LD structured data
      if (!profileImageUrl) {
        const jsonLdMatches = html.matchAll(/<script type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/gi);
        for (const match of jsonLdMatches) {
          try {
            const parsed = JSON.parse(match[1]);
            const candidate = parsed.image || parsed.thumbnailUrl;
            if (candidate && typeof candidate === 'string' && candidate.startsWith('http')) {
              profileImageUrl = decodeHtmlEntities(candidate.trim());
              break;
            }
          } catch {
            // Non-blocking parse error
          }
        }
      }

      // 3. Fallback: Extract from inlined JSON profile_pic_url_hd or profile_pic_url
      if (!profileImageUrl) {
        const inlineMatch =
          html.match(/"profile_pic_url_hd":"([^"]+)"/) ||
          html.match(/"profile_pic_url":"([^"]+)"/);

        if (inlineMatch && inlineMatch[1]) {
          const raw = inlineMatch[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
          if (raw.startsWith('http')) {
            profileImageUrl = raw.trim();
          }
        }
      }

      // Extract Display Name from og:title or HTML title
      // Format usually: "Name (@username) • Instagram photos and videos"
      let displayName = username;
      const titleMatch =
        html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
        html.match(/<title>([^<]+)<\/title>/i);

      if (titleMatch && titleMatch[1]) {
        const cleanTitle = decodeHtmlEntities(titleMatch[1]);
        const namePart = cleanTitle.split(/[(•|]/)[0]?.trim();
        if (namePart && namePart.length > 0 && namePart !== 'Instagram') {
          displayName = namePart;
        }
      }

      // Extract Biography / Description
      let biography: string | undefined;
      const descMatch =
        html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
        html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);

      if (descMatch && descMatch[1]) {
        biography = decodeHtmlEntities(descMatch[1].trim());
      }

      return {
        username,
        profileUrl,
        profileImageUrl: profileImageUrl || null,
        displayName,
        biography,
        source: 'INSTAGRAM_PROVIDER',
        fetchedAt: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
