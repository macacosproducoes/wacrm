/**
 * Creative Engine - Template Service
 *
 * Manages multi-tenant templates, immutable version history snapshots,
 * and status transitions (DRAFT -> ACTIVE -> ARCHIVED).
 */

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import type {
  CreativeTemplate,
  CreativeTemplateVersion,
  TemplateDefinition,
  TemplateStatus,
} from './types';

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Supabase URL or Service Role Key missing in environment.');
  }
  return createSupabaseClient(url, key);
}

export interface CreateTemplateInput {
  accountId: string;
  userId?: string | null;
  name: string;
  description?: string;
  category?: string;
  type?: string;
  status?: TemplateStatus;
  definition: TemplateDefinition;
}

export interface UpdateTemplateInput {
  name?: string;
  description?: string;
  category?: string;
  type?: string;
  status?: TemplateStatus;
  definition?: TemplateDefinition;
  publishNewVersion?: boolean;
}

export class CreativeTemplateService {
  /**
   * Create a new template and its initial version snapshot (v1)
   */
  static async createTemplate(input: CreateTemplateInput): Promise<CreativeTemplate> {
    const supabase = getAdminClient();
    const version = 1;

    console.log(`[CREATIVE] creating template "${input.name}" for account ${input.accountId}`);

    const { data: template, error: templateErr } = await supabase
      .from('creative_templates')
      .insert({
        account_id: input.accountId,
        created_by: input.userId || null,
        name: input.name,
        description: input.description || null,
        category: input.category || 'general',
        type: input.type || 'image/png',
        status: input.status || 'DRAFT',
        version,
        definition: input.definition,
      })
      .select('*')
      .single();

    if (templateErr || !template) {
      console.error('[Creative Engine:Template] Error creating template:', templateErr);
      throw new Error(`Failed to create template: ${templateErr?.message}`);
    }

    // Create immutable v1 snapshot
    const { error: versionErr } = await supabase
      .from('creative_template_versions')
      .insert({
        template_id: template.id,
        account_id: input.accountId,
        created_by: input.userId || null,
        version,
        definition: input.definition,
      });

    if (versionErr) {
      console.warn('[Creative Engine:Template] Failed to create v1 snapshot:', versionErr);
    }

    return template as CreativeTemplate;
  }

  /**
   * Updates a template. If definition changes or publishNewVersion is requested,
   * creates a new immutable version snapshot.
   */
  static async updateTemplate(
    templateId: string,
    accountId: string,
    input: UpdateTemplateInput,
    userId?: string | null
  ): Promise<CreativeTemplate> {
    const supabase = getAdminClient();

    // Get current template
    const { data: existing, error: getErr } = await supabase
      .from('creative_templates')
      .select('*')
      .eq('id', templateId)
      .eq('account_id', accountId)
      .single();

    if (getErr || !existing) {
      throw new Error(`Template not found or unauthorized: ${templateId}`);
    }

    let nextVersion = existing.version;
    const shouldBumpVersion = input.publishNewVersion || (
      input.definition &&
      JSON.stringify(input.definition) !== JSON.stringify(existing.definition)
    );

    if (shouldBumpVersion) {
      nextVersion = existing.version + 1;
    }

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (input.name !== undefined) updates.name = input.name;
    if (input.description !== undefined) updates.description = input.description;
    if (input.category !== undefined) updates.category = input.category;
    if (input.type !== undefined) updates.type = input.type;
    if (input.status !== undefined) updates.status = input.status;
    if (input.definition !== undefined) updates.definition = input.definition;
    if (shouldBumpVersion) updates.version = nextVersion;

    const { data: updated, error: updateErr } = await supabase
      .from('creative_templates')
      .update(updates)
      .eq('id', templateId)
      .eq('account_id', accountId)
      .select('*')
      .single();

    if (updateErr || !updated) {
      throw new Error(`Failed to update template: ${updateErr?.message}`);
    }

    // Save version snapshot if bumped
    if (shouldBumpVersion && input.definition) {
      await supabase.from('creative_template_versions').insert({
        template_id: templateId,
        account_id: accountId,
        created_by: userId || null,
        version: nextVersion,
        definition: input.definition,
      });
      console.log(`[CREATIVE] Published template version v${nextVersion} for ${templateId}`);
    }

    return updated as CreativeTemplate;
  }

  /**
   * Retrieves a template by ID
   */
  static async getTemplate(
    templateId: string,
    accountId: string
  ): Promise<{ template: CreativeTemplate; versions: CreativeTemplateVersion[] }> {
    const supabase = getAdminClient();

    const { data: template, error: getErr } = await supabase
      .from('creative_templates')
      .select('*')
      .eq('id', templateId)
      .eq('account_id', accountId)
      .single();

    if (getErr || !template) {
      throw new Error(`Template not found: ${templateId}`);
    }

    const { data: versions } = await supabase
      .from('creative_template_versions')
      .select('*')
      .eq('template_id', templateId)
      .eq('account_id', accountId)
      .order('version', { ascending: false });

    return {
      template: template as CreativeTemplate,
      versions: (versions || []) as CreativeTemplateVersion[],
    };
  }

  /**
   * Retrieves a specific historical version definition
   */
  static async getTemplateVersion(
    templateId: string,
    version: number,
    accountId: string
  ): Promise<TemplateDefinition> {
    const supabase = getAdminClient();

    const { data: ver, error } = await supabase
      .from('creative_template_versions')
      .select('definition')
      .eq('template_id', templateId)
      .eq('account_id', accountId)
      .eq('version', version)
      .single();

    if (error || !ver) {
      // Fallback: check if current template has this version
      const { data: tpl } = await supabase
        .from('creative_templates')
        .select('definition, version')
        .eq('id', templateId)
        .eq('account_id', accountId)
        .single();

      if (tpl && tpl.version === version) {
        return tpl.definition as TemplateDefinition;
      }
      throw new Error(`Template version v${version} not found for template ${templateId}`);
    }

    return ver.definition as TemplateDefinition;
  }

  /**
   * List templates for an account
   */
  static async listTemplates(
    accountId: string,
    filter?: { category?: string; status?: TemplateStatus; search?: string }
  ): Promise<CreativeTemplate[]> {
    const supabase = getAdminClient();

    let query = supabase
      .from('creative_templates')
      .select('*')
      .eq('account_id', accountId)
      .order('updated_at', { ascending: false });

    if (filter?.category) {
      query = query.eq('category', filter.category);
    }
    if (filter?.status) {
      query = query.eq('status', filter.status);
    }
    if (filter?.search) {
      query = query.ilike('name', `%${filter.search}%`);
    }

    const { data, error } = await query;
    if (error) {
      console.error('[Creative Engine:Template] listTemplates error:', error);
      return [];
    }

    return (data || []) as CreativeTemplate[];
  }

  /**
   * Duplicates a template
   */
  static async duplicateTemplate(
    templateId: string,
    accountId: string,
    newName?: string,
    userId?: string | null
  ): Promise<CreativeTemplate> {
    const { template } = await this.getTemplate(templateId, accountId);

    return this.createTemplate({
      accountId,
      userId,
      name: newName || `${template.name} (Cópia)`,
      description: template.description || undefined,
      category: template.category,
      type: template.type,
      status: 'DRAFT',
      definition: template.definition,
    });
  }

  /**
   * Archives a template
   */
  static async archiveTemplate(templateId: string, accountId: string): Promise<CreativeTemplate> {
    return this.updateTemplate(templateId, accountId, { status: 'ARCHIVED' });
  }
}
