import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import type { MessageTemplate } from '@/types';

export async function GET() {
  try {
    const { accountId } = await requireRole('agent');
    const admin = supabaseAdmin();

    const { data: templates, error } = await admin
      .from('message_templates')
      .select('*')
      .or(`account_id.eq.${accountId},account_id.is.null`)
      .in('status', ['APPROVED', 'DRAFT'])
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[Templates API] Error fetching templates:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ templates: templates ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('agent');
    const admin = supabaseAdmin();
    const body = await request.json();

    const {
      id,
      name,
      category = 'Marketing',
      language = 'pt_BR',
      body_text,
      variations = [],
      header_content,
      footer_text,
    } = body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json(
        { error: 'Nome do template é obrigatório.' },
        { status: 400 }
      );
    }

    if (!body_text || typeof body_text !== 'string' || !body_text.trim()) {
      return NextResponse.json(
        { error: 'Texto principal da Variação 1 é obrigatório.' },
        { status: 400 }
      );
    }

    const sanitizedName = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_');

    const cleanedVariations = Array.isArray(variations)
      ? variations
          .map((v: unknown) => (typeof v === 'string' ? v.trim() : ''))
          .filter((v: string) => v.length > 0)
      : [body_text.trim()];

    // Ensure variation 1 is part of variations list
    if (!cleanedVariations.includes(body_text.trim())) {
      cleanedVariations.unshift(body_text.trim());
    }

    const validCategory = ['Marketing', 'Utility', 'Authentication'].includes(
      category
    )
      ? category
      : 'Marketing';

    const headerType =
      header_content && typeof header_content === 'string' && header_content.trim()
        ? 'text'
        : null;

    let savedTemplate: MessageTemplate | null = null;

    // 1. If an existing database UUID was passed, update it
    const isRealDbUuid =
      id &&
      typeof id === 'string' &&
      !id.startsWith('default-') &&
      !id.startsWith('tpl-') &&
      id.length > 20;

    if (isRealDbUuid) {
      const { data: updated, error: updateErr } = await admin
        .from('message_templates')
        .update({
          name: sanitizedName,
          category: validCategory,
          language,
          body_text: body_text.trim(),
          variations: cleanedVariations,
          header_type: headerType,
          header_content: header_content?.trim() || null,
          footer_text: footer_text?.trim() || null,
          status: 'APPROVED',
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .select()
        .maybeSingle();

      if (!updateErr && updated) {
        savedTemplate = updated as MessageTemplate;
      }
    }

    // 2. If not updated, check if a template with same name exists for this account
    if (!savedTemplate) {
      const { data: existing } = await admin
        .from('message_templates')
        .select('id')
        .eq('name', sanitizedName)
        .or(`account_id.eq.${accountId},account_id.is.null`)
        .maybeSingle();

      if (existing) {
        const { data: updated, error: updateErr } = await admin
          .from('message_templates')
          .update({
            category: validCategory,
            language,
            body_text: body_text.trim(),
            variations: cleanedVariations,
            header_type: headerType,
            header_content: header_content?.trim() || null,
            footer_text: footer_text?.trim() || null,
            status: 'APPROVED',
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id)
          .select()
          .single();

        if (!updateErr && updated) {
          savedTemplate = updated as MessageTemplate;
        }
      }
    }

    // 3. Otherwise insert a brand new template record
    if (!savedTemplate) {
      const { data: inserted, error: insertErr } = await admin
        .from('message_templates')
        .insert({
          user_id: userId,
          account_id: accountId,
          name: sanitizedName,
          category: validCategory,
          language,
          body_text: body_text.trim(),
          variations: cleanedVariations,
          header_type: headerType,
          header_content: header_content?.trim() || null,
          footer_text: footer_text?.trim() || null,
          status: 'APPROVED',
        })
        .select()
        .single();

      if (insertErr) {
        console.error('[Templates API] Insert error:', insertErr);
        return NextResponse.json({ error: insertErr.message }, { status: 500 });
      }

      savedTemplate = inserted as MessageTemplate;
    }

    return NextResponse.json({
      success: true,
      template: savedTemplate,
      message: `Template salvo com ${cleanedVariations.length} variação(ões).`,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
