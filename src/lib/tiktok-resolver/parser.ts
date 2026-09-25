/**
 * TikTok Identifier Parser
 * Extracts and validates TikTok usernames and URLs from freeform customer text.
 */

const TIKTOK_USERNAME_REGEX = /^[a-zA-Z0-9_.-]{2,30}$/;

/**
 * Validates and cleans a raw TikTok username.
 * Strips leading '@', trailing slashes, and spaces.
 */
export function parseTikTokUsername(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;

  const cleaned = raw
    .trim()
    .replace(/^@+/, '')
    .replace(/\/+$/, '')
    .replace(/[?#].*$/, '')
    .trim();

  if (!cleaned) return null;
  if (!TIKTOK_USERNAME_REGEX.test(cleaned)) return null;

  return cleaned.toLowerCase();
}

/**
 * Checks if a string is a TikTok URL.
 */
export function isTikTokUrl(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  return /tiktok\.com/i.test(url);
}

/**
 * Formats a clean canonical profile URL for a TikTok username.
 */
export function buildTikTokProfileUrl(username: string): string {
  const clean = parseTikTokUsername(username) || username.replace(/^@+/, '').trim();
  return `https://www.tiktok.com/@${clean}`;
}

/**
 * Extracts a TikTok username and URL from freeform text.
 */
export function extractTikTokIdentifier(text: string | null | undefined): {
  username: string | null;
  url: string | null;
} {
  if (!text || typeof text !== 'string') {
    return { username: null, url: null };
  }

  const raw = text.trim();

  // 1. Direct TikTok URL (e.g. https://www.tiktok.com/@alvesbarros135 or tiktok.com/@alvesbarros135)
  const urlMatch = raw.match(/(?:https?:\/\/)?(?:www\.|vm\.|vt\.)?tiktok\.com\/@([a-zA-Z0-9_.-]{2,30})/i);
  if (urlMatch && urlMatch[1]) {
    const username = parseTikTokUsername(urlMatch[1]);
    if (username) {
      return {
        username,
        url: buildTikTokProfileUrl(username),
      };
    }
  }

  // 2. Explicit TikTok prefix in message:
  // e.g. "tiktok: @user", "tiktok @user", "tiktok: user", "tick tok: user", "tik tok @user"
  const prefixMatch = raw.match(/(?:tiktok|tick\s*tok|tik\s*tok)\s*(?::|-|de|para|pro|do)?\s*@?([a-zA-Z0-9_.-]{2,30})/i);
  if (prefixMatch && prefixMatch[1]) {
    const candidate = prefixMatch[1].trim();
    // Exclude general stop words
    if (!/^(seguidor|seguidores|para|quero|comprar|manda|envia|sim|nao|e|eh)$/i.test(candidate)) {
      const username = parseTikTokUsername(candidate);
      if (username) {
        return {
          username,
          url: buildTikTokProfileUrl(username),
        };
      }
    }
  }

  // 3. Any @handle if the text mentions tiktok
  const hasTikTokKeyword = /(?:tiktok|tick\s*tok|tik\s*tok)/i.test(raw);
  if (hasTikTokKeyword) {
    const handleMatch = raw.match(/@([a-zA-Z0-9_.-]{2,30})/i);
    if (handleMatch && handleMatch[1]) {
      const username = parseTikTokUsername(handleMatch[1]);
      if (username) {
        return {
          username,
          url: buildTikTokProfileUrl(username),
        };
      }
    }
  }

  return { username: null, url: null };
}
