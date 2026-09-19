/**
 * Creative Engine - Deterministic Visual Renderer
 *
 * Compiles a structured TemplateDefinition and business context into a high-fidelity SVG,
 * then renders it via Sharp into a pixel-perfect, deterministic PNG.
 * 100% deterministic: NO LLM or generative AI drawing.
 */

import type {
  TemplateDefinition,
  CreativeElement,
  TextElement,
  ImageElement,
  CircleImageElement,
  ShapeElement,
  LineElement,
  GroupElement,
} from './types';
import { resolveTextTemplate, evaluateVariable } from './variables';
import { ImageProvider } from './image-provider';

export interface RenderResult {
  pngBuffer: Buffer;
  svg: string;
  width: number;
  height: number;
}

export interface RenderOptions {
  customFormatters?: Record<string, (val: unknown, arg?: string) => string>;
  imageFetchTimeoutMs?: number;
}

/**
 * Escapes XML special characters for safe inclusion in SVG text and attributes
 */
export function escapeXml(str: unknown): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Breaks long text into lines based on maxWidth and approx character widths
 */
function wrapTextLines(text: string, maxWidth?: number, fontSize = 24): string[] {
  if (!text) return [];
  const rawLines = text.split(/\r?\n/);
  if (!maxWidth || maxWidth <= 0) return rawLines;

  // Approximate character width in standard proportional fonts is ~0.55 * fontSize
  const approxCharWidth = fontSize * 0.55;
  const maxCharsPerLine = Math.max(10, Math.floor(maxWidth / approxCharWidth));

  const result: string[] = [];
  for (const rawLine of rawLines) {
    if (rawLine.length <= maxCharsPerLine) {
      result.push(rawLine);
      continue;
    }

    const words = rawLine.split(' ');
    let currentLine = '';

    for (const word of words) {
      if (!currentLine) {
        currentLine = word;
      } else if ((currentLine + ' ' + word).length <= maxCharsPerLine) {
        currentLine += ' ' + word;
      } else {
        result.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) {
      result.push(currentLine);
    }
  }

  return result;
}

export class CreativeRenderer {
  /**
   * Main render function: resolves variables, resolves images, generates SVG, and converts to PNG.
   */
  static async render(
    template: TemplateDefinition,
    context: Record<string, unknown> = {},
    options: RenderOptions = {}
  ): Promise<RenderResult> {
    const width = Math.max(100, Math.round(template.width || 1080));
    const height = Math.max(100, Math.round(template.height || 1080));

    // Sort elements by zIndex (stable ascending order)
    const elements = [...(template.elements || [])].sort(
      (a, b) => (a.zIndex || 0) - (b.zIndex || 0)
    );

    // Defs collection for clipPaths, gradients, etc.
    const defs: string[] = [];

    // Pre-resolve all dynamic and static images asynchronously with SSRF protection
    const renderedElements: string[] = [];

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      const rendered = await this.renderElement(
        el,
        context,
        defs,
        options,
        `el_${i}`
      );
      if (rendered) {
        renderedElements.push(rendered);
      }
    }

    // Background generation
    const bgSvg = this.renderBackground(template.background, width, height);

    const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <defs>
    ${defs.join('\n    ')}
  </defs>
  ${bgSvg}
  ${renderedElements.join('\n  ')}
</svg>`;

    // Deterministic compile: Try @resvg/resvg-js first (Rust N-API, standalone, zero libvips dependencies)
    // with embedded true-type font buffers (guarantees text glyph rendering on AWS Lambda/Vercel Serverless)
    // and automatic fallback to Sharp.
    let pngBuffer: Buffer;
    try {
      const { Resvg } = await import('@resvg/resvg-js');
      const { getFontFiles } = await import('./embedded-fonts');
      const fontFiles = getFontFiles();

      const resvg = new Resvg(svg, {
        fitTo: { mode: 'width', value: width },
        shapeRendering: 2,
        textRendering: 1,
        imageRendering: 0,
        font: {
          loadSystemFonts: true,
          fontFiles,
          defaultFontFamily: 'Roboto',
        },
      });
      const pngData = resvg.render();
      pngBuffer = Buffer.from(pngData.asPng());
    } catch (resvgErr) {
      console.warn('[CreativeRenderer] @resvg/resvg-js failed, falling back to sharp:', resvgErr);
      const sharpModule = (await import('sharp')).default;
      pngBuffer = await sharpModule(Buffer.from(svg))
        .png({
          quality: 95,
          compressionLevel: 8,
          adaptiveFiltering: true,
        })
        .toBuffer();
    }

    return {
      pngBuffer,
      svg,
      width,
      height,
    };
  }

  /**
   * Generates background rect/gradient
   */
  private static renderBackground(
    background: TemplateDefinition['background'],
    width: number,
    height: number
  ): string {
    if (!background) {
      return `<rect width="${width}" height="${height}" fill="#ffffff"/>`;
    }

    if (typeof background === 'string') {
      const trimmed = background.trim();
      if (trimmed.startsWith('#') || trimmed.startsWith('rgb') || trimmed.startsWith('hsl')) {
        return `<rect width="${width}" height="${height}" fill="${escapeXml(trimmed)}"/>`;
      }
      return `<rect width="${width}" height="${height}" fill="${escapeXml(trimmed)}"/>`;
    }

    if (background.type === 'color') {
      return `<rect width="${width}" height="${height}" fill="${escapeXml(background.value || '#ffffff')}"/>`;
    }

    return `<rect width="${width}" height="${height}" fill="#ffffff"/>`;
  }

  /**
   * Renders a single CreativeElement into SVG
   */
  private static async renderElement(
    el: CreativeElement,
    context: Record<string, unknown>,
    defs: string[],
    options: RenderOptions,
    uniqueId: string
  ): Promise<string> {
    const opacity = el.opacity !== undefined ? Math.max(0, Math.min(1, el.opacity)) : 1;
    const opacityAttr = opacity < 1 ? ` opacity="${opacity}"` : '';

    const rotation = el.rotation || 0;
    const transformAttr = rotation !== 0
      ? ` transform="rotate(${rotation}, ${el.x + el.width / 2}, ${el.y + el.height / 2})"`
      : '';

    switch (el.type) {
      case 'TEXT':
        return this.renderTextElement(el as TextElement, context, options, transformAttr, opacityAttr);

      case 'IMAGE':
      case 'LOGO':
        return await this.renderImageElement(
          el as ImageElement,
          context,
          options,
          defs,
          uniqueId,
          transformAttr,
          opacityAttr
        );

      case 'CIRCLE_IMAGE':
        return await this.renderCircleImageElement(
          el as CircleImageElement,
          context,
          options,
          defs,
          uniqueId,
          transformAttr,
          opacityAttr
        );

      case 'RECTANGLE':
      case 'ROUNDED_RECTANGLE':
        return this.renderShapeElement(el as ShapeElement, transformAttr, opacityAttr);

      case 'LINE':
        return this.renderLineElement(el as LineElement, transformAttr, opacityAttr);

      case 'GROUP':
        return await this.renderGroupElement(el as GroupElement, context, defs, options, uniqueId, transformAttr, opacityAttr);

      default:
        return '';
    }
  }

  /**
   * Renders a TEXT element with multiline and alignment support
   */
  private static renderTextElement(
    el: TextElement,
    context: Record<string, unknown>,
    options: RenderOptions,
    transformAttr: string,
    opacityAttr: string
  ): string {
    let rawText = el.text || '';
    if (el.variable) {
      const evaluated = evaluateVariable(el.variable, context, options.customFormatters);
      rawText = evaluated !== null && evaluated !== undefined ? String(evaluated) : '';
    } else {
      rawText = resolveTextTemplate(rawText, context, options.customFormatters);
    }

    const fontSize = el.fontSize || 24;
    const fontFamily = el.fontFamily || "Roboto, Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
    const fontWeight = el.fontWeight || 'normal';
    const color = el.color || '#000000';
    const alignment = el.alignment || 'left';
    const lineHeight = el.lineHeight || 1.25;
    const letterSpacing = el.letterSpacing ? ` letter-spacing="${el.letterSpacing}px"` : '';

    let textAnchor = 'start';
    let anchorX = el.x;
    if (alignment === 'center') {
      textAnchor = 'middle';
      anchorX = el.x + el.width / 2;
    } else if (alignment === 'right') {
      textAnchor = 'end';
      anchorX = el.x + el.width;
    }

    const lines = wrapTextLines(rawText, el.maxWidth || el.width, fontSize);
    if (lines.length === 0) return '';

    const tspans = lines.map((line, idx) => {
      const dy = idx === 0 ? 0 : `${lineHeight}em`;
      return `<tspan x="${anchorX}" dy="${dy}">${escapeXml(line)}</tspan>`;
    }).join('');

    return `<text x="${anchorX}" y="${el.y + fontSize}" font-family="${escapeXml(fontFamily)}" font-size="${fontSize}" font-weight="${fontWeight}" fill="${escapeXml(color)}" text-anchor="${textAnchor}"${letterSpacing}${transformAttr}${opacityAttr}>${tspans}</text>`;
  }

  /**
   * Renders an IMAGE or LOGO element
   */
  private static async renderImageElement(
    el: ImageElement,
    context: Record<string, unknown>,
    options: RenderOptions,
    defs: string[],
    uniqueId: string,
    transformAttr: string,
    opacityAttr: string
  ): Promise<string> {
    let sourceUrl = el.source;
    if (el.variable) {
      const resolved = evaluateVariable(el.variable, context);
      if (typeof resolved === 'string') {
        sourceUrl = resolved;
      }
    }

    const dataUri = await ImageProvider.resolveImageDataUri(sourceUrl, {
      fallbackUrl: el.fallbackUrl,
      timeoutMs: options.imageFetchTimeoutMs,
    });

    const preserveAspect = el.fit === 'contain'
      ? 'xMidYMid meet'
      : el.fit === 'fill'
      ? 'none'
      : 'xMidYMid slice'; // cover by default

    // Handle rounded corners via clipPath if specified
    let clipAttr = '';
    if (el.borderRadius && el.borderRadius > 0) {
      const clipId = `clip_rect_${uniqueId}`;
      defs.push(`
        <clipPath id="${clipId}">
          <rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" rx="${el.borderRadius}" ry="${el.borderRadius}"/>
        </clipPath>
      `);
      clipAttr = ` clip-path="url(#${clipId})"`;
    }

    return `<image href="${dataUri}" xlink:href="${dataUri}" x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" preserveAspectRatio="${preserveAspect}"${clipAttr}${transformAttr}${opacityAttr}/>`;
  }

  /**
   * Renders a CIRCLE_IMAGE element with exact circular clipping
   */
  private static async renderCircleImageElement(
    el: CircleImageElement,
    context: Record<string, unknown>,
    options: RenderOptions,
    defs: string[],
    uniqueId: string,
    transformAttr: string,
    opacityAttr: string
  ): Promise<string> {
    let sourceUrl = el.source;
    if (sourceUrl && sourceUrl.includes('{{')) {
      sourceUrl = resolveTextTemplate(sourceUrl, context);
    }
    if (el.variable) {
      const resolved = evaluateVariable(el.variable, context);
      if (typeof resolved === 'string') {
        sourceUrl = resolved;
      }
    }

    const dataUri = await ImageProvider.resolveImageDataUri(sourceUrl, {
      fallbackUrl: el.fallbackUrl,
      timeoutMs: options.imageFetchTimeoutMs,
    });

    const radius = Math.min(el.width, el.height) / 2;
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;

    const clipId = `clip_circle_${uniqueId}`;
    defs.push(`
      <clipPath id="${clipId}">
        <circle cx="${cx}" cy="${cy}" r="${radius}"/>
      </clipPath>
    `);

    const imageSvg = `<image href="${dataUri}" xlink:href="${dataUri}" x="${cx - radius}" y="${cy - radius}" width="${radius * 2}" height="${radius * 2}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})"${transformAttr}${opacityAttr}/>`;

    // Optional border circle on top
    let borderSvg = '';
    if (el.borderWidth && el.borderWidth > 0 && el.borderColor) {
      borderSvg = `\n  <circle cx="${cx}" cy="${cy}" r="${radius - el.borderWidth / 2}" fill="none" stroke="${escapeXml(el.borderColor)}" stroke-width="${el.borderWidth}"${transformAttr}${opacityAttr}/>`;
    }

    return imageSvg + borderSvg;
  }

  /**
   * Renders RECTANGLE or ROUNDED_RECTANGLE
   */
  private static renderShapeElement(
    el: ShapeElement,
    transformAttr: string,
    opacityAttr: string
  ): string {
    const fill = el.fill || 'none';
    const stroke = el.stroke ? ` stroke="${escapeXml(el.stroke)}"` : '';
    const strokeWidth = el.strokeWidth ? ` stroke-width="${el.strokeWidth}"` : '';
    const rx = el.borderRadius || 0;
    const rxAttr = rx > 0 ? ` rx="${rx}" ry="${rx}"` : '';

    return `<rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" fill="${escapeXml(fill)}"${stroke}${strokeWidth}${rxAttr}${transformAttr}${opacityAttr}/>`;
  }

  /**
   * Renders a LINE element
   */
  private static renderLineElement(
    el: LineElement,
    transformAttr: string,
    opacityAttr: string
  ): string {
    const stroke = el.stroke || '#000000';
    const strokeWidth = el.strokeWidth || 1;
    const dash = el.strokeDasharray ? ` stroke-dasharray="${escapeXml(el.strokeDasharray)}"` : '';

    return `<line x1="${el.x}" y1="${el.y}" x2="${el.x2}" y2="${el.y2}" stroke="${escapeXml(stroke)}" stroke-width="${strokeWidth}"${dash}${transformAttr}${opacityAttr}/>`;
  }

  /**
   * Renders a GROUP element with nested children
   */
  private static async renderGroupElement(
    el: GroupElement,
    context: Record<string, unknown>,
    defs: string[],
    options: RenderOptions,
    uniqueId: string,
    transformAttr: string,
    opacityAttr: string
  ): Promise<string> {
    const childrenSvg: string[] = [];
    if (Array.isArray(el.children)) {
      for (let i = 0; i < el.children.length; i++) {
        const child = el.children[i];
        // Relative offset to parent group
        const offsetChild = {
          ...child,
          x: el.x + (child.x || 0),
          y: el.y + (child.y || 0),
        };
        const rendered = await this.renderElement(
          offsetChild,
          context,
          defs,
          options,
          `${uniqueId}_child_${i}`
        );
        if (rendered) childrenSvg.push(rendered);
      }
    }

    return `<g${transformAttr}${opacityAttr}>
    ${childrenSvg.join('\n    ')}
  </g>`;
  }
}
