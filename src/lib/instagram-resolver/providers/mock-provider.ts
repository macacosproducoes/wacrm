/**
 * Instagram Profile Resolver - Mock Provider
 *
 * Provides deterministic test profiles for unit tests, local staging, and preview environments.
 */

import type { InstagramProfileProvider } from './provider';
import type { InstagramProfileData } from '../types';
import { buildInstagramProfileUrl } from '../parser';
import { createSvgPlaceholder } from '@/lib/creative-engine/image-provider';

export class MockInstagramProfileProvider implements InstagramProfileProvider {
  readonly providerName = 'mock';

  public customMocks: Map<string, Partial<InstagramProfileData>> = new Map();

  async resolve(username: string): Promise<InstagramProfileData> {
    const cleanUsername = username.trim().toLowerCase();

    // Check if a custom mock is registered
    const custom = this.customMocks.get(cleanUsername);
    if (custom) {
      return {
        username: cleanUsername,
        profileUrl: buildInstagramProfileUrl(cleanUsername),
        profileImageUrl: custom.profileImageUrl !== undefined ? custom.profileImageUrl : createSvgPlaceholder(200, 200, `@${cleanUsername}`),
        displayName: custom.displayName || `Perfil de ${cleanUsername}`,
        source: 'INSTAGRAM_PROVIDER',
        fetchedAt: new Date().toISOString(),
        ...custom,
      };
    }

    // Special test usernames
    if (cleanUsername === 'not_found' || cleanUsername === 'nonexistent_user_999') {
      throw new Error(`Instagram profile not found: @${cleanUsername}`);
    }

    if (cleanUsername === 'no_photo_user') {
      return {
        username: cleanUsername,
        profileUrl: buildInstagramProfileUrl(cleanUsername),
        profileImageUrl: null,
        displayName: 'Usuário Sem Foto',
        source: 'INSTAGRAM_PROVIDER',
        fetchedAt: new Date().toISOString(),
      };
    }

    // Default mock response: deterministic SVG avatar
    return {
      username: cleanUsername,
      profileUrl: buildInstagramProfileUrl(cleanUsername),
      profileImageUrl: createSvgPlaceholder(250, 250, `@${cleanUsername}`, '#1e293b', '#38bdf8'),
      displayName: `Nome de @${cleanUsername}`,
      biography: 'Bio de demonstração do perfil do Instagram.',
      source: 'INSTAGRAM_PROVIDER',
      fetchedAt: new Date().toISOString(),
    };
  }
}
