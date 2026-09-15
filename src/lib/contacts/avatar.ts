/**
 * Contact Avatar Helper
 *
 * Resolves 100% real contact photo URLs (from WhatsApp CDN, storage or base64 thumbnail).
 * Returns null if no real photo exists, letting UI display authentic initials/user badges without simulation.
 */

export function getContactAvatarUrl(contact?: {
  name?: string | null;
  phone?: string | null;
  avatar_url?: string | null;
}): string | null {
  const url = contact?.avatar_url?.trim();
  if (!url) return null;

  // Never return fake/simulated avatar generator URLs
  if (
    url.includes('dicebear.com') ||
    url.includes('generated') ||
    url.includes('placeholder')
  ) {
    return null;
  }

  // Real WhatsApp CDN, public URL, or base64 thumbnail
  if (
    url.startsWith('https://') ||
    url.startsWith('http://') ||
    url.startsWith('data:image/')
  ) {
    return url;
  }

  return null;
}

