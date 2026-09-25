/**
 * TikTok Profile Resolver Types & Constants
 */

export type TikTokResolveStatus =
  | 'NOT_REQUESTED'
  | 'RESOLVING'
  | 'IMAGE_AVAILABLE'
  | 'IMAGE_UNAVAILABLE'
  | 'FAILED';

export interface TikTokProfileData {
  username: string;
  url: string;
  avatarUrl?: string | null;
  nickname?: string | null;
}

export interface TikTokResolveResult {
  username: string;
  profileUrl: string;
  profileImageUrl: string | null;
  resolveStatus: TikTokResolveStatus;
  error?: string | null;
}

/**
 * Neutral silhouette SVG data-URI for TikTok profiles.
 * Used when public avatar is inaccessible or blocked, ensuring deterministic template rendering.
 */
export const NEUTRAL_TIKTOK_AVATAR =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 240' width='240' height='240'%3E%3Crect width='240' height='240' fill='%230f172a'/%3E%3Ccircle cx='120' cy='95' r='42' fill='%2325f4ee' opacity='0.8'/%3E%3Cpath fill='%23fe2c55' opacity='0.8' d='M120 155c-38 0-70 18-70 50v15h140v-15c0-32-32-50-70-50z'/%3E%3Cpath fill='%23ffffff' d='M120 90a36 36 0 1 0 0-72 36 36 0 0 0 0 72zm0 18c-32 0-60 16-60 46v12h120v-12c0-30-28-46-60-46z'/%3E%3C/svg%3E";
