/**
 * Instagram Input Parser & Deterministic Conversation Detector
 *
 * Robustly parses and normalizes Instagram usernames and URLs,
 * and extracts handles from conversation text.
 */

import type { InstagramIdentifierResult } from './types';

// Reserved Instagram path names and common conversation/payment stop-words that are never usernames
const RESERVED_PATHS = new Set([
  'p',
  'reel',
  'reels',
  'stories',
  'tv',
  'explore',
  'direct',
  'accounts',
  'about',
  'developer',
  'legal',
  'privacy',
  'terms',
  'help',
  'api',
  'graphql',
  'directory',
  'download',
  // Common Brazilian conversation / payment keywords that must never be mistaken for handles
  'pix',
  'cartao',
  'cartão',
  'boleto',
  'pagamento',
  'pago',
  'paguei',
  'contato',
  'whatsapp',
  'dinheiro',
  'ted',
  'doc',
  'ola',
  'olá',
  'obrigado',
  'quero',
  'seguidores',
  'preco',
  'preço',
  'valor',
  'comprei',
  'tabela',
  'catalogo',
  'catálogo',
  'teste',
  'sim',
  'nao',
  'não',
  'eu',
  'ele',
  'ela',
  'nos',
  'nós',
  'voce',
  'você',
]);

/**
 * Validates whether a normalized string matches Instagram's username specification:
 * - 1 to 30 characters
 * - Letters, numbers, periods, and underscores
 * - Cannot start or end with a period
 * - Cannot contain consecutive periods (..)
 * - Cannot be an Instagram reserved path
 */
export function isValidInstagramUsername(username: string): boolean {
  if (!username || typeof username !== 'string') return false;
  const clean = username.trim().toLowerCase();

  if (clean.length < 1 || clean.length > 30) return false;
  if (!/^[a-z0-9._]+$/.test(clean)) return false;
  if (clean.startsWith('.') || clean.endsWith('.')) return false;
  if (clean.includes('..')) return false;
  if (RESERVED_PATHS.has(clean)) return false;

  return true;
}

/**
 * Parses and normalizes any Instagram handle or URL into a clean username.
 *
 * Examples:
 * - "@JoaoSilva" -> "joaosilva"
 * - "https://instagram.com/joaosilva" -> "joaosilva"
 * - "https://www.instagram.com/joaosilva/?igsh=xyz&utm_source=copy" -> "joaosilva"
 * - "www.instagram.com/joaosilva/" -> "joaosilva"
 * - "joaosilva" -> "joaosilva"
 */
export function parseInstagramUsername(input: string | null | undefined): string | null {
  if (!input || typeof input !== 'string') return null;

  let raw = input.trim();
  if (!raw) return null;

  // 1. If it looks like a URL (contains "instagram.com")
  if (raw.toLowerCase().includes('instagram.com')) {
    try {
      // Ensure it has a protocol so URL parser succeeds
      let urlString = raw;
      if (!/^https?:\/\//i.test(urlString)) {
        urlString = 'https://' + urlString.replace(/^www\./i, 'www.');
      }
      const parsed = new URL(urlString);

      // Verify domain is instagram.com
      const host = parsed.hostname.toLowerCase();
      if (!host.endsWith('instagram.com')) {
        return null;
      }

      // Extract first path segment
      const segments = parsed.pathname
        .split('/')
        .map((s) => s.trim())
        .filter(Boolean);

      if (segments.length === 0) return null;

      const candidate = segments[0].replace(/^@+/, '');
      const normalized = candidate.toLowerCase();
      return isValidInstagramUsername(normalized) ? normalized : null;
    } catch {
      // Fallback regex if URL parsing fails on weird input
      const match = raw.match(/instagram\.com\/([a-zA-Z0-9._]+)/i);
      if (match && match[1]) {
        const candidate = match[1].toLowerCase();
        return isValidInstagramUsername(candidate) ? candidate : null;
      }
      return null;
    }
  }

  // 2. Direct username or @mention
  // Strip query parameters or trailing fragments if user passed e.g. "joaosilva?igsh=123"
  const strippedQuery = raw.split(/[?#]/)[0].trim();
  // Strip trailing slashes and leading @ symbols
  const candidate = strippedQuery.replace(/^\/+|\/+$/g, '').replace(/^@+/, '').trim().toLowerCase();

  return isValidInstagramUsername(candidate) ? candidate : null;
}

/**
 * Builds the canonical public profile URL for a given username
 */
export function buildInstagramProfileUrl(username: string): string {
  const clean = username.replace(/^@+/, '').trim().toLowerCase();
  return `https://www.instagram.com/${clean}/`;
}

/**
 * Deterministically extracts Instagram handles or profile URLs from conversation text.
 *
 * Detects patterns like:
 * - "meu insta é @joaosilva"
 * - "segue lá https://instagram.com/joaosilva"
 * - "meus perfis @loja1 e @loja2" (detects multiple)
 */
export function extractInstagramIdentifier(text: string | null | undefined): InstagramIdentifierResult {
  if (!text || typeof text !== 'string') {
    return { detected: false };
  }

  const rawText = text.trim();
  if (!rawText) {
    return { detected: false };
  }

  const detectedUsernames = new Set<string>();

  // 1. Match full Instagram URLs: (https?://)?(www\.)?instagram\.com/([a-zA-Z0-9._]+)
  const urlRegex = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/([a-zA-Z0-9._]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(rawText)) !== null) {
    const candidate = match[1];
    const parsed = parseInstagramUsername(candidate);
    if (parsed) {
      detectedUsernames.add(parsed);
    }
  }

  // 2. Match @mentions: e.g. "@joaosilva" or "@loja_123.oficial"
  // Negative lookbehind or boundary to avoid email addresses (e.g. not user@domain.com)
  const mentionRegex = /(?:^|[\s,;:!?"'()[\]{}])@([a-zA-Z0-9._]{1,30})\b/gi;
  while ((match = mentionRegex.exec(rawText)) !== null) {
    const candidate = match[1];
    const parsed = parseInstagramUsername(candidate);
    if (parsed) {
      detectedUsernames.add(parsed);
    }
  }

  // 3. Match contextual phrases like "insta: joaosilva" or "instagram é joaosilva"
  // ONLY if no explicit URL or @mention was found (prevents false matches on message body words like "pix")
  if (detectedUsernames.size === 0) {
    const contextRegex = /(?:insta(?:gram)?|perfil)\s*(?:é|e|:|-|=|\s)\s*([a-zA-Z0-9._]{2,30})\b/gi;
    while ((match = contextRegex.exec(rawText)) !== null) {
      const candidate = match[1];
      const parsed = parseInstagramUsername(candidate);
      if (parsed) {
        detectedUsernames.add(parsed);
      }
    }
  }

  // 4. If text is purely a naked username (single word without spaces, e.g. "joaosilva")
  if (detectedUsernames.size === 0 && /^[a-zA-Z0-9._]{3,30}$/.test(rawText)) {
    const parsed = parseInstagramUsername(rawText);
    if (parsed) {
      detectedUsernames.add(parsed);
    }
  }

  const usernames = Array.from(detectedUsernames);

  if (usernames.length === 0) {
    return { detected: false, username: null, profileUrl: null };
  }

  if (usernames.length > 1) {
    return {
      detected: true,
      multipleDetected: true,
      allUsernames: usernames,
      candidates: usernames,
      username: usernames[0],
      profileUrl: buildInstagramProfileUrl(usernames[0]),
    };
  }

  const singleUsername = usernames[0];
  return {
    detected: true,
    multipleDetected: false,
    allUsernames: usernames,
    candidates: usernames,
    username: singleUsername,
    profileUrl: buildInstagramProfileUrl(singleUsername),
  };
}
