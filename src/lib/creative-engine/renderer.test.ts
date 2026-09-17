import { describe, expect, it } from 'vitest';
import { CreativeRenderer, escapeXml } from './renderer';
import type { TemplateDefinition } from './types';

describe('Creative Engine - Deterministic Renderer', () => {
  const sampleTemplate: TemplateDefinition = {
    width: 600,
    height: 400,
    background: '#0f172a',
    elements: [
      {
        id: 'box1',
        type: 'ROUNDED_RECTANGLE',
        x: 40,
        y: 40,
        width: 520,
        height: 320,
        borderRadius: 16,
        fill: '#1e293b',
        stroke: '#38bdf8',
        strokeWidth: 2,
      },
      {
        id: 'text1',
        type: 'TEXT',
        x: 60,
        y: 80,
        width: 480,
        height: 40,
        text: 'Notificação: {{customer.name}}',
        fontSize: 24,
        color: '#ffffff',
        alignment: 'left',
      },
      {
        id: 'line1',
        type: 'LINE',
        x: 60,
        y: 140,
        x2: 540,
        y2: 140,
        width: 480,
        height: 1,
        stroke: '#475569',
        strokeWidth: 2,
      },
      {
        id: 'circle1',
        type: 'CIRCLE_IMAGE',
        x: 60,
        y: 170,
        width: 100,
        height: 100,
        borderColor: '#38bdf8',
        borderWidth: 2,
      },
    ],
  };

  it('renders a valid PNG buffer with expected dimensions', async () => {
    const context = {
      customer: { name: 'João Santos' },
    };

    const result = await CreativeRenderer.render(sampleTemplate, context);

    expect(result.pngBuffer).toBeInstanceOf(Buffer);
    expect(result.pngBuffer.length).toBeGreaterThan(500);
    expect(result.width).toBe(600);
    expect(result.height).toBe(400);
    expect(result.svg).toContain('João Santos');
  });

  it('guarantees 100% deterministic output (same data = identical PNG buffer)', async () => {
    const context = {
      customer: { name: 'Deterministico Teste' },
    };

    const render1 = await CreativeRenderer.render(sampleTemplate, context);
    const render2 = await CreativeRenderer.render(sampleTemplate, context);

    expect(render1.pngBuffer.length).toBe(render2.pngBuffer.length);
    expect(render1.pngBuffer.equals(render2.pngBuffer)).toBe(true);
    expect(render1.svg).toBe(render2.svg);
  });

  it('properly escapes XML entities to prevent injection', () => {
    expect(escapeXml('<script>alert("xss")&\'test\'</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&amp;&apos;test&apos;&lt;/script&gt;'
    );
  });

  it('renders GROUP elements and nested children with relative offsets', async () => {
    const groupTemplate: TemplateDefinition = {
      width: 400,
      height: 300,
      background: '#000000',
      elements: [
        {
          id: 'grp1',
          type: 'GROUP',
          x: 50,
          y: 50,
          width: 200,
          height: 100,
          children: [
            {
              id: 'child1',
              type: 'TEXT',
              x: 10,
              y: 10,
              width: 180,
              height: 30,
              text: 'Texto no Grupo',
              fontSize: 18,
              color: '#ffffff',
            },
          ],
        },
      ],
    };

    const res = await CreativeRenderer.render(groupTemplate, {});
    expect(res.svg).toContain('Texto no Grupo');
    expect(res.pngBuffer).toBeInstanceOf(Buffer);
  });
});
