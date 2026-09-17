/**
 * Creative Engine - Image Provider
 *
 * Securely loads, normalizes, and validates images from diverse sources (URLs, storage, data URIs)
 * with strict SSRF protection, timeout boundaries, and deterministic fallbacks.
 */

import { isDeliverableUrl } from '@/lib/webhooks/ssrf';

export interface ImageFetchOptions {
  timeoutMs?: number;
  maxSizeBytes?: number;
  fallbackUrl?: string;
  allowSvg?: boolean;
}

const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Creates a clean, deterministic SVG placeholder data URI
 */
export function createSvgPlaceholder(
  width = 200,
  height = 200,
  label = 'Image Not Found',
  bgColor = '#334155',
  textColor = '#94a3b8'
): string {
  const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="${bgColor}"/>
    <circle cx="${width / 2}" cy="${height / 2 - 15}" r="${Math.min(width, height) * 0.18}" fill="none" stroke="${textColor}" stroke-width="2"/>
    <text x="${width / 2}" y="${height / 2 + 25}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="${Math.max(12, Math.round(width * 0.06))}" fill="${textColor}" text-anchor="middle" font-weight="500">${label}</text>
  </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

export class ImageProvider {
  /**
   * Resolves an image source into a valid data URI or Buffer.
   * If source is already a data URI, validates and returns it.
   * If source is a remote URL, enforces SSRF protection and downloads with timeout.
   */
  static async resolveImageDataUri(
    source: string | null | undefined,
    options: ImageFetchOptions = {}
  ): Promise<string> {
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    const maxSizeBytes = options.maxSizeBytes || DEFAULT_MAX_SIZE_BYTES;

    if (!source || typeof source !== 'string' || !source.trim()) {
      if (options.fallbackUrl) {
        return this.resolveImageDataUri(options.fallbackUrl, {
          ...options,
          fallbackUrl: undefined,
        });
      }
      return createSvgPlaceholder(200, 200, 'Sem Imagem');
    }

    const cleanSource = source.trim();

    // 1. Data URI: already base64 encoded
    if (cleanSource.startsWith('data:image/')) {
      return cleanSource;
    }

    // 2. Validate URL protocol
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(cleanSource);
    } catch {
      console.warn('[Creative Engine:ImageProvider] Invalid URL syntax:', cleanSource);
      return createSvgPlaceholder(200, 200, 'URL Inválida');
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      console.warn('[Creative Engine:ImageProvider] Unsupported protocol:', parsedUrl.protocol);
      return createSvgPlaceholder(200, 200, 'Protocolo Inválido');
    }

    // 3. SSRF Protection: ensure target host resolves to publicly routable IPs only
    const isDeliverable = await isDeliverableUrl(cleanSource);
    if (!isDeliverable) {
      console.warn('[Creative Engine:ImageProvider] SSRF block: refusing non-public or internal URL:', cleanSource);
      return createSvgPlaceholder(200, 200, 'Origem Bloqueada');
    }

    // 4. Fetch with timeout and size guards
    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(cleanSource, {
        signal: controller.signal,
        redirect: 'manual', // Prevent SSRF via 3xx redirect to private targets
        headers: {
          'User-Agent': 'CreativeEngine/1.0',
          'Accept': 'image/png,image/jpeg,image/webp,image/svg+xml,*/*',
        },
      });

      if (!response.ok) {
        console.warn(`[Creative Engine:ImageProvider] Fetch failed with status ${response.status} for: ${cleanSource}`);
        if (options.fallbackUrl) {
          return this.resolveImageDataUri(options.fallbackUrl, {
            ...options,
            fallbackUrl: undefined,
          });
        }
        return createSvgPlaceholder(200, 200, 'Erro Download');
      }

      const contentType = response.headers.get('content-type') || 'image/png';
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      if (buffer.length > maxSizeBytes) {
        console.warn(`[Creative Engine:ImageProvider] Image exceeds max allowed size (${buffer.length} > ${maxSizeBytes})`);
        return createSvgPlaceholder(200, 200, 'Imagem Muito Grande');
      }

      const mime = contentType.split(';')[0].trim() || 'image/png';
      return `data:${mime};base64,${buffer.toString('base64')}`;
    } catch (err: unknown) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      console.warn(`[Creative Engine:ImageProvider] Failed to fetch image (${isAbort ? 'Timeout' : (err as Error).message}): ${cleanSource}`);
      if (options.fallbackUrl) {
        return this.resolveImageDataUri(options.fallbackUrl, {
          ...options,
          fallbackUrl: undefined,
        });
      }
      return createSvgPlaceholder(200, 200, isAbort ? 'Tempo Excedido' : 'Falha na Imagem');
    } finally {
      clearTimeout(timeoutTimer);
    }
  }
}
