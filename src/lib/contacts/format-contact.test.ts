import { describe, it, expect } from 'vitest';
import { formatContactDisplayName } from './format-contact';
import { getContactAvatarUrl } from './avatar';

describe('formatContactDisplayName', () => {
  it('preserves real names', () => {
    expect(formatContactDisplayName('Larissa - Engajamento Real')).toBe('Larissa - Engajamento Real');
    expect(formatContactDisplayName('Dr. Carlos Silva', '5511999999999')).toBe('Dr. Carlos Silva');
  });

  it('formats BR numbers with country code', () => {
    expect(formatContactDisplayName('+5511971121710')).toBe('+55 (11) 97112-1710');
    expect(formatContactDisplayName('5511971121710')).toBe('+55 (11) 97112-1710');
  });

  it('cleans Contato prefix and formats number', () => {
    expect(formatContactDisplayName('Contato 11971121710')).toBe('+55 (11) 97112-1710');
  });
});

describe('getContactAvatarUrl', () => {
  it('returns null for missing or empty avatar_url', () => {
    expect(getContactAvatarUrl({ avatar_url: null })).toBeNull();
    expect(getContactAvatarUrl({ avatar_url: '' })).toBeNull();
    expect(getContactAvatarUrl(undefined)).toBeNull();
  });

  it('rejects simulated / dicebear avatar URLs', () => {
    expect(
      getContactAvatarUrl({
        avatar_url: 'https://api.dicebear.com/7.x/personas/svg?seed=test',
      })
    ).toBeNull();
  });

  it('returns real WhatsApp CDN photo URLs', () => {
    const realUrl =
      'https://pps.whatsapp.net/v/t61.24694-24/684207652_2292565314909544_7297238804182902960_n.jpg';
    expect(getContactAvatarUrl({ avatar_url: realUrl })).toBe(realUrl);
  });

  it('returns real base64 image data URLs', () => {
    const dataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRg...';
    expect(getContactAvatarUrl({ avatar_url: dataUrl })).toBe(dataUrl);
  });
});
