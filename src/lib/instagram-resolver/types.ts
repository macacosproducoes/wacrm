/**
 * Instagram Profile Resolver - Types
 *
 * Types for parsing, normalizing, resolving, caching, and storing
 * Instagram profiles and profile pictures for CRM contacts & Creative Engine.
 */

export type ProfileImageSource = 'MANUAL' | 'STORED' | 'INSTAGRAM_PROVIDER';

export type InstagramResolveStatus =
  | 'NOT_REQUESTED'
  | 'PENDING'
  | 'RESOLVING'
  | 'RESOLVED'
  | 'IMAGE_AVAILABLE'
  | 'IMAGE_UNAVAILABLE'
  | 'FAILED'
  | 'MANUAL_REQUIRED';

export interface InstagramIdentifierResult {
  detected: boolean;
  username?: string | null;
  profileUrl?: string | null;
  multipleDetected?: boolean;
  allUsernames?: string[];
  candidates?: string[];
}

export interface InstagramProfileData {
  username: string;
  profileUrl: string;
  profileImageUrl?: string | null;
  displayName?: string | null;
  biography?: string | null;
  followersCount?: number | null;
  isPrivate?: boolean | null;
  isVerified?: boolean | null;
  source: ProfileImageSource;
  fetchedAt: string;
}

export interface ResolveProfileOptions {
  forceRefresh?: boolean;
  providerName?: string;
  ttlHours?: number;
}

export interface ResolvedContactInstagram {
  contactId: string;
  instagramUsername: string;
  instagramUrl: string;
  profileImageUrl?: string | null;
  profileImageSource: ProfileImageSource;
  resolveStatus: InstagramResolveStatus;
  hash?: string | null;
  updatedAt: string;
  error?: string | null;
}
