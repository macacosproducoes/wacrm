import { describe, expect, it } from 'vitest';
import { ImageProvider, createSvgPlaceholder } from './image-provider';

describe('Creative Engine - ImageProvider & SSRF Guard', () => {
  it('returns data URI directly when already encoded', async () => {
    const rawDataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const resolved = await ImageProvider.resolveImageDataUri(rawDataUri);
    expect(resolved).toBe(rawDataUri);
  });

  it('blocks private IPs, localhost, and AWS metadata addresses (SSRF Protection)', async () => {
    const targets = [
      'http://127.0.0.1/test.png',
      'http://localhost:3000/image.jpg',
      'http://169.254.169.254/latest/meta-data',
      'http://192.168.1.50/secret.png',
      'http://10.0.0.1/admin.png',
    ];

    for (const url of targets) {
      const resolved = await ImageProvider.resolveImageDataUri(url);
      expect(resolved.startsWith('data:image/svg+xml;base64,')).toBe(true);
      const decodedSvg = Buffer.from(resolved.split(',')[1], 'base64').toString('utf8');
      expect(decodedSvg).toContain('Origem Bloqueada');
    }
  });

  it('produces a valid SVG placeholder for missing or empty source', async () => {
    const resolved = await ImageProvider.resolveImageDataUri('');
    expect(resolved.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const decodedSvg = Buffer.from(resolved.split(',')[1], 'base64').toString('utf8');
    expect(decodedSvg).toContain('Sem Imagem');
  });

  it('createSvgPlaceholder generates deterministic base64 svg', () => {
    const placeholder = createSvgPlaceholder(250, 250, 'Custom Label');
    expect(placeholder).toContain('data:image/svg+xml;base64,');
    const decoded = Buffer.from(placeholder.split(',')[1], 'base64').toString('utf8');
    expect(decoded).toContain('Custom Label');
    expect(decoded).toContain('width="250"');
  });
});
