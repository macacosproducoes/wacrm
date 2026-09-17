import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockInstagramProfileProvider } from './providers/mock-provider';
import { DirectInstagramProfileProvider } from './providers/direct-provider';
import { ApiInstagramProfileProvider } from './providers/api-provider';
import { getInstagramProfileProvider } from './providers/factory';

describe('MockInstagramProfileProvider', () => {
  let provider: MockInstagramProfileProvider;

  beforeEach(() => {
    provider = new MockInstagramProfileProvider();
  });

  it('resolves valid username to structured profile data', async () => {
    const data = await provider.resolve('joaosilva');
    expect(data.username).toBe('joaosilva');
    expect(data.profileUrl).toBe('https://www.instagram.com/joaosilva/');
    expect(data.displayName).toBe('Nome de @joaosilva');
    expect(data.source).toBe('INSTAGRAM_PROVIDER');
    expect(data.profileImageUrl).toBeDefined();
  });

  it('returns null profileImageUrl for users without profile photo', async () => {
    const data = await provider.resolve('no_photo_user');
    expect(data.username).toBe('no_photo_user');
    expect(data.profileImageUrl).toBeNull();
  });

  it('throws error for non-existent profiles', async () => {
    await expect(provider.resolve('not_found')).rejects.toThrow('Instagram profile not found: @not_found');
  });

  it('supports custom registered mocks', async () => {
    provider.customMocks.set('custom_client', {
      displayName: 'Cliente Especial',
      profileImageUrl: 'https://example.com/avatar.png',
    });

    const data = await provider.resolve('custom_client');
    expect(data.displayName).toBe('Cliente Especial');
    expect(data.profileImageUrl).toBe('https://example.com/avatar.png');
  });
});

describe('getInstagramProfileProvider factory', () => {
  it('returns DirectInstagramProfileProvider when "direct" is requested', () => {
    const provider = getInstagramProfileProvider('direct');
    expect(provider).toBeInstanceOf(DirectInstagramProfileProvider);
    expect(provider.providerName).toBe('direct');
  });

  it('returns ApiInstagramProfileProvider when "api" is requested', () => {
    const provider = getInstagramProfileProvider('api');
    expect(provider).toBeInstanceOf(ApiInstagramProfileProvider);
    expect(provider.providerName).toBe('external_api');
  });

  it('returns MockInstagramProfileProvider when "mock" is requested', () => {
    const provider = getInstagramProfileProvider('mock');
    expect(provider).toBeInstanceOf(MockInstagramProfileProvider);
    expect(provider.providerName).toBe('mock');
  });
});

