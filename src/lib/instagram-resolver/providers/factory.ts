/**
 * Instagram Profile Provider Factory
 *
 * Resolves the configured provider based on environment variables.
 * Default in production is DirectInstagramProfileProvider.
 */

import type { InstagramProfileProvider } from './provider';
import { DirectInstagramProfileProvider } from './direct-provider';
import { MockInstagramProfileProvider } from './mock-provider';
import { ApiInstagramProfileProvider } from './api-provider';

export function getInstagramProfileProvider(providerNameOverride?: string): InstagramProfileProvider {
  const provider = (providerNameOverride || process.env.INSTAGRAM_PROFILE_PROVIDER || '').toLowerCase().trim();

  if (provider === 'direct') {
    return new DirectInstagramProfileProvider();
  }

  if (provider === 'api' || provider === 'rapidapi') {
    return new ApiInstagramProfileProvider();
  }

  if (provider === 'mock') {
    return new MockInstagramProfileProvider();
  }

  // In test environment without explicit provider, default to Mock
  if (process.env.NODE_ENV === 'test') {
    return new MockInstagramProfileProvider();
  }

  // Default in production: Direct public resolution without external paid APIs
  return new DirectInstagramProfileProvider();
}
