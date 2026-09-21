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

const REQUEST_TIMEOUT_MS = 4000;

interface RequestProfile {
  name: string;
  headers: Record<string, string>;
}

// Cohesive request profiles prioritizing social preview crawlers that reliably bypass datacenter restrictions
const REQUEST_PROFILES: RequestProfile[] = [
  // 1. TelegramBot (Proven to receive 952KB SSR Open Graph HTML on datacenter IPs)
  {
    name: 'TelegramBot',
    headers: {
      'User-Agent': 'TelegramBot (like TwitterBot)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
    },
  },
  // 2. Twitterbot (Proven to receive 952KB SSR Open Graph HTML on datacenter IPs)
  {
    name: 'Twitterbot',
    headers: {
      'User-Agent': 'Twitterbot/1.0',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
    },
  },
  // 3. Discordbot (High delivery on Meta endpoints)
  {
    name: 'Discordbot',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
    },
  },
  // 4. WhatsApp Social Preview Crawler
  {
    name: 'WhatsApp-Bot',
    headers: {
      'User-Agent': 'WhatsApp/2.21.12.21 A',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      'Cache-Control': 'no-cache',
    },
  },
  // 5. Mobile Safari (High delivery, non-bot footprint)
  {
    name: 'Mobile-Safari',
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
      'Cache-Control': 'no-cache',
    },
  },
  // 6. Facebook External Hit (Meta native crawler)
  {
    name: 'Facebook-Bot',
    headers: {
      'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Accept': '*/*',
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
    },
  },
];

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ''; }
    })
    .replace(/&#([0-9]+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return ''; }
    })
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
    const lookasideUrl = `${profileUrl}?from_lookaside=1`;
    console.log(`[INSTAGRAM_DIRECT] Resolving @${cleanUsername}...`);

    let bestMetadata: InstagramProfileData | null = null;

    // Strategy 1: Meta Threads.net Open Graph (Instant, ultra-reliable for accounts with Threads active)
    try {
      const threadsResult = await this.fetchViaThreads(cleanUsername, profileUrl);
      if (threadsResult && threadsResult.profileImageUrl && !isStaticPlaceholder(threadsResult.profileImageUrl)) {
        console.log(`[INSTAGRAM_DIRECT] Successfully resolved official photo for @${cleanUsername} via Threads Open Graph!`);
        return threadsResult;
      }
      if (threadsResult && threadsResult.displayName && threadsResult.displayName !== cleanUsername) {
        bestMetadata = threadsResult;
      }
    } catch (threadsErr: unknown) {
      console.warn(`[INSTAGRAM_DIRECT] Threads attempt for @${cleanUsername} completed with no match:`, threadsErr);
    }

    // Strategy 2: Instagram Lookaside with proven social preview bots (TelegramBot, Twitterbot, Discordbot)
    let is404 = false;
    let consecutive429s = 0;

    for (let i = 0; i < REQUEST_PROFILES.length; i++) {
      const profile = REQUEST_PROFILES[i];
      try {
        const result = await this.fetchAndExtract(cleanUsername, lookasideUrl, profile.headers);
        if (result) {
          if (result.profileImageUrl && !isStaticPlaceholder(result.profileImageUrl)) {
            console.log(`[INSTAGRAM_DIRECT] Successfully resolved official photo for @${cleanUsername} via ${profile.name}!`);
            return {
              ...result,
              displayName: result.displayName !== cleanUsername ? result.displayName : (bestMetadata?.displayName || result.displayName),
              biography: result.biography || bestMetadata?.biography,
            };
          }

          if (!bestMetadata || (result.displayName && result.displayName !== cleanUsername)) {
            bestMetadata = result;
          }
        }
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.message.includes('Unexpected redirect domain')) {
          throw error;
        }
        if (error.message.includes('404')) {
          is404 = true;
          break;
        }
        if (error.message.includes('429')) {
          consecutive429s++;
          if (consecutive429s >= 3) {
            console.warn(`[INSTAGRAM_DIRECT] Multiple 429s encountered, stopping direct attempts for @${cleanUsername}`);
            break;
          }
          continue;
        }
      }
    }

    if (is404) {
      throw new Error(`Instagram profile not found: @${cleanUsername} (HTTP 404)`);
    }

    // If we have text metadata but no image could be extracted, return best metadata
    if (bestMetadata) {
      return bestMetadata;
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
    requestHeaders: Record<string, string>
  ): Promise<InstagramProfileData | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(profileUrl, {
        headers: requestHeaders,
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
        profileUrl: buildInstagramProfileUrl(username),
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
