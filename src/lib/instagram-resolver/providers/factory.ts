/**
 * Instagram Profile Provider Factory
 *
 * Resolves the configured provider based on environment variables.
 */

import type { InstagramProfileProvider } from './provider';
import { MockInstagramProfileProvider } from './mock-provider';
import { ApiInstagramProfileProvider } from './api-provider';

export function getInstagramProfileProvider(providerNameOverride?: string): InstagramProfileProvider {
  const provider = (providerNameOverride || process.env.INSTAGRAM_PROFILE_PROVIDER || '').toLowerCase().trim();

  if (provider === 'api' || provider === 'rapidapi' || process.env.INSTAGRAM_PROFILE_API_URL) {
    return new ApiInstagramProfileProvider();
  }

  // Default / mock provider
  return new MockInstagramProfileProvider();
}
