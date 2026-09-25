import { describe, it, expect } from 'vitest';
import { parseTikTokUsername, extractTikTokIdentifier, isTikTokUrl } from './parser';

describe('TikTok Identifier Parser', () => {
  it('parses direct usernames', () => {
    expect(parseTikTokUsername('@alvesbarros135')).toBe('alvesbarros135');
    expect(parseTikTokUsername('alvesbarros135')).toBe('alvesbarros135');
    expect(parseTikTokUsername('user.name_123/')).toBe('user.name_123');
  });

  it('detects TikTok URLs', () => {
    expect(isTikTokUrl('https://www.tiktok.com/@alvesbarros135')).toBe(true);
    expect(isTikTokUrl('https://instagram.com/user')).toBe(false);
  });

  it('extracts identifier from URL in text', () => {
    const res = extractTikTokIdentifier('Quero seguidores para https://www.tiktok.com/@alvesbarros135');
    expect(res.username).toBe('alvesbarros135');
    expect(res.url).toBe('https://www.tiktok.com/@alvesbarros135');
  });

  it('extracts identifier with keyword tiktok in message', () => {
    const res1 = extractTikTokIdentifier('meu tiktok e @alvesbarros135 manda 5000');
    expect(res1.username).toBe('alvesbarros135');

    const res2 = extractTikTokIdentifier('tick tok: alvesbarros135');
    expect(res2.username).toBe('alvesbarros135');

    const res3 = extractTikTokIdentifier('5 mil para tick tok @alvesbarros135');
    expect(res3.username).toBe('alvesbarros135');
  });
});
