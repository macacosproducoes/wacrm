import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DirectInstagramProfileProvider } from './direct-provider';

describe('DirectInstagramProfileProvider', () => {
  let provider: DirectInstagramProfileProvider;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    provider = new DirectInstagramProfileProvider();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('rejects invalid username', async () => {
    await expect(provider.resolve('invalid..user')).rejects.toThrow('Invalid Instagram username');
  });

  it('extracts profile image and display name from Open Graph tags', async () => {
    const mockHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta property="og:title" content="João Silva (&#064;joaosilva) &#x2022; Instagram photos and videos" />
          <meta property="og:image" content="https://scontent.cdninstagram.com/avatar.jpg?foo=1&amp;bar=2" />
          <meta property="og:description" content="Fotógrafo e designer." />
        </head>
        <body></body>
      </html>
    `;

    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      url: 'https://www.instagram.com/joaosilva/',
      text: async () => mockHtml,
    } as unknown as Response);

    const result = await provider.resolve('joaosilva');
    expect(result.username).toBe('joaosilva');
    expect(result.profileUrl).toBe('https://www.instagram.com/joaosilva/');
    expect(result.profileImageUrl).toBe('https://scontent.cdninstagram.com/avatar.jpg?foo=1&bar=2');
    expect(result.displayName).toBe('João Silva');
    expect(result.biography).toBe('Fotógrafo e designer.');
    expect(result.source).toBe('INSTAGRAM_PROVIDER');
  });

  it('extracts profile image from Schema.org JSON-LD when og:image is absent', async () => {
    const mockHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Maria Souza (@mariasouza)</title>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "ProfilePage",
              "image": "https://scontent.cdninstagram.com/maria_avatar.jpg"
            }
          </script>
        </head>
        <body></body>
      </html>
    `;

    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      url: 'https://www.instagram.com/mariasouza/',
      text: async () => mockHtml,
    } as unknown as Response);

    const result = await provider.resolve('mariasouza');
    expect(result.profileImageUrl).toBe('https://scontent.cdninstagram.com/maria_avatar.jpg');
    expect(result.displayName).toBe('Maria Souza');
  });

  it('extracts profile image from inlined JSON profile_pic_url_hd', async () => {
    const mockHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Carlos (@carlos)</title></head>
        <body>
          <script>
            window.__initialData = {"user":{"profile_pic_url_hd":"https:\\/\\/scontent.cdninstagram.com\\/carlos_hd.jpg\\u0026token=123"}};
          </script>
        </body>
      </html>
    `;

    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      url: 'https://www.instagram.com/carlos/',
      text: async () => mockHtml,
    } as unknown as Response);

    const result = await provider.resolve('carlos');
    expect(result.profileImageUrl).toBe('https://scontent.cdninstagram.com/carlos_hd.jpg&token=123');
  });

  it('throws for 404 profile', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 404,
      ok: false,
      url: 'https://www.instagram.com/nonexistent_user/',
      text: async () => 'Not found',
    } as unknown as Response);

    await expect(provider.resolve('nonexistent_user')).rejects.toThrow('Instagram profile not found: @nonexistent_user (HTTP 404)');
  });

  it('rejects unexpected redirect domain (SSRF guard)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      url: 'http://169.254.169.254/secret',
      text: async () => '<html></html>',
    } as unknown as Response);

    await expect(provider.resolve('victim')).rejects.toThrow('Unexpected redirect domain');
  });

  it('resolves photo via Meta Threads fallback when Instagram direct fails with 429', async () => {
    const mockThreadsHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta property="og:title" content="Maju Brook (&#064;majubrook) • Threads" />
          <meta property="og:image" content="https://scontent.cdninstagram.com/maju_avatar.jpg" />
          <meta property="og:description" content="Moda e lifestyle" />
        </head>
        <body></body>
      </html>
    `;

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('instagram.com')) {
        return {
          status: 429,
          ok: false,
          url,
          text: async () => 'Too Many Requests',
        } as unknown as Response;
      }
      if (url.includes('threads.net')) {
        return {
          status: 200,
          ok: true,
          url,
          text: async () => mockThreadsHtml,
        } as unknown as Response;
      }
      return { status: 404, ok: false } as unknown as Response;
    });

    const result = await provider.resolve('majubrook');
    expect(result.username).toBe('majubrook');
    expect(result.profileImageUrl).toBe('https://scontent.cdninstagram.com/maju_avatar.jpg');
    expect(result.displayName).toBe('Maju Brook');
  });

  it('ignores Threads placeholder image and returns null image', async () => {
    const mockThreadsPlaceholderHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta property="og:title" content="Threads • Log in" />
          <meta property="og:image" content="https://static.cdninstagram.com/rsrc.php/yd/r/kHwIMM5b8PW.webp" />
        </head>
        <body></body>
      </html>
    `;

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('instagram.com')) {
        return {
          status: 429,
          ok: false,
          url,
          text: async () => 'Too Many Requests',
        } as unknown as Response;
      }
      if (url.includes('threads.net')) {
        return {
          status: 200,
          ok: true,
          url,
          text: async () => mockThreadsPlaceholderHtml,
        } as unknown as Response;
      }
      return { status: 404, ok: false } as unknown as Response;
    });

    const result = await provider.resolve('unknown_user');
    expect(result.username).toBe('unknown_user');
    expect(result.profileImageUrl).toBeNull();
  });
});

