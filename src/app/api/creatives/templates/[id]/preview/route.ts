import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { CreativeTemplateService } from '@/lib/creative-engine/templates';
import { CreativeRenderer } from '@/lib/creative-engine/renderer';
import type { TemplateDefinition } from '@/lib/creative-engine/types';

export async function POST(
  request: Request,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const { accountId } = await requireRole('viewer');
    const params = await props.params;
    const body = await request.json().catch(() => ({}));

    let definition: TemplateDefinition;

    // If definition is provided directly in body (e.g. live editor editing without saving)
    if (body?.definition && typeof body.definition === 'object') {
      definition = body.definition;
    } else {
      // Otherwise load saved template version
      const version = body?.version ? Number(body.version) : undefined;
      if (version) {
        definition = await CreativeTemplateService.getTemplateVersion(params.id, version, accountId);
      } else {
        const { template } = await CreativeTemplateService.getTemplate(params.id, accountId);
        definition = template.definition;
      }
    }

    const testData = (body?.testData || {}) as Record<string, unknown>;

    // Use the exact production deterministic renderer!
    const renderResult = await CreativeRenderer.render(definition, testData);

    const pngBase64 = renderResult.pngBuffer.toString('base64');
    const pngDataUrl = `data:image/png;base64,${pngBase64}`;

    return NextResponse.json({
      pngDataUrl,
      width: renderResult.width,
      height: renderResult.height,
      sizeBytes: renderResult.pngBuffer.length,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
