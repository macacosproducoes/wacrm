/**
 * Creative Engine - Job Processor & Idempotency Manager
 *
 * Orchestrates the full lifecycle:
 * CRM -> Business Event -> Creative Job -> Template Resolution -> Data Resolution
 *     -> Renderer -> Storage -> Delivery (Optional) -> Activity Log
 *
 * Guarantees strict idempotency and concurrency locking.
 */

import crypto from 'crypto';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import type {
  CreativeJob,
  JobStatus,
  SourceType,
  DeliveryOptions,
  DeliveryResult,
} from './types';
import { CreativeTemplateService } from './templates';
import { CreativeRenderer } from './renderer';
import { CreativeStorage } from './storage';
import { WhatsAppDeliveryProvider } from './delivery/whatsapp-provider';
import type { DeliveryProvider } from './delivery/provider';

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Supabase URL or Service Role Key missing in environment.');
  }
  return createSupabaseClient(url, key);
}

export interface EnqueueCreativeJobInput {
  accountId: string;
  templateId: string;
  templateVersion?: number;
  sourceType: SourceType;
  sourceId: string;
  creativeType?: string;
  inputData: Record<string, unknown>;
  idempotencyKey?: string;
  forceRegenerate?: boolean;
  deliver?: boolean;
  deliveryOptions?: DeliveryOptions;
  deliveryProvider?: DeliveryProvider;
}

export class CreativeJobManager {
  /**
   * Generates a deterministic idempotency key
   */
  static computeIdempotencyKey(
    accountId: string,
    templateId: string,
    templateVersion: number,
    sourceType: string,
    sourceId: string,
    creativeType = 'default'
  ): string {
    const raw = `${accountId}:${templateId}:${templateVersion}:${sourceType}:${sourceId}:${creativeType}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  /**
   * Enqueues or immediately executes a creative job with idempotency.
   */
  static async processJob(input: EnqueueCreativeJobInput): Promise<CreativeJob> {
    const supabase = getAdminClient();
    const {
      accountId,
      templateId,
      sourceType,
      sourceId,
      inputData,
      forceRegenerate = false,
      deliver = false,
      deliveryOptions,
    } = input;

    // 1. Resolve template to know active version if not explicitly passed
    const { template } = await CreativeTemplateService.getTemplate(templateId, accountId);
    const templateVersion = input.templateVersion || template.version;
    const creativeType = input.creativeType || 'default';

    // 2. Compute idempotency key
    const idempotencyKey = input.idempotencyKey || this.computeIdempotencyKey(
      accountId,
      templateId,
      templateVersion,
      sourceType,
      sourceId,
      creativeType
    );

    // 3. Check for existing job
    const { data: existingJob } = await supabase
      .from('creative_jobs')
      .select('*')
      .eq('account_id', accountId)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();

    if (existingJob) {
      // If already generated or sent and not forcing regeneration, return existing!
      if (!forceRegenerate && ['GENERATED', 'READY', 'SENT', 'SENDING'].includes(existingJob.status)) {
        console.log(`[CREATIVE] Idempotent hit: returning existing job ${existingJob.id} (${existingJob.status})`);
        
        // If delivery was requested and job is not sent yet, deliver now
        if (deliver && existingJob.status === 'GENERATED' && deliveryOptions) {
          await this.deliverJob(existingJob as CreativeJob, deliveryOptions, input.deliveryProvider);
        }
        return existingJob as CreativeJob;
      }

      // If currently processing by another worker within lock threshold (2 mins), avoid parallel collision
      if (existingJob.status === 'PROCESSING' && existingJob.locked_at) {
        const lockAgeMs = Date.now() - new Date(existingJob.locked_at).getTime();
        if (lockAgeMs < 120_000) {
          console.log(`[CREATIVE] Job ${existingJob.id} is actively processing by worker ${existingJob.locked_by}. Skipping parallel run.`);
          return existingJob as CreativeJob;
        }
      }
    }

    const workerId = `worker_${process.pid}_${Math.random().toString(36).substring(2, 7)}`;

    // 4. Create or update job record
    let job: CreativeJob;
    if (existingJob) {
      const { data: updated } = await supabase
        .from('creative_jobs')
        .update({
          status: 'PROCESSING',
          input_data: inputData,
          locked_at: new Date().toISOString(),
          locked_by: workerId,
          started_at: new Date().toISOString(),
          attempts: (existingJob.attempts || 0) + 1,
          error: null,
        })
        .eq('id', existingJob.id)
        .select('*')
        .single();
      job = updated as CreativeJob;
    } else {
      const { data: inserted, error: insertErr } = await supabase
        .from('creative_jobs')
        .insert({
          account_id: accountId,
          template_id: templateId,
          template_version: templateVersion,
          source_type: sourceType,
          source_id: sourceId,
          creative_type: creativeType,
          idempotency_key: idempotencyKey,
          input_data: inputData,
          status: 'PROCESSING',
          locked_at: new Date().toISOString(),
          locked_by: workerId,
          started_at: new Date().toISOString(),
          attempts: 1,
        })
        .select('*')
        .single();

      if (insertErr || !inserted) {
        throw new Error(`Failed to create creative job: ${insertErr?.message}`);
      }
      job = inserted as CreativeJob;
    }

    console.log(`[CREATIVE] job started: ${job.id} for source ${sourceType}:${sourceId}`);

    try {
      // 5. Template Resolution
      const templateDefinition = await CreativeTemplateService.getTemplateVersion(
        templateId,
        templateVersion,
        accountId
      );
      console.log(`[CREATIVE] template resolved: ${templateId} (v${templateVersion})`);

      // 6. Data Resolution (CRITICAL: Never fall back to WhatsApp avatar; Instagram photo is strictly separate)
      const resolvedData = { ...inputData };
      const contactObj = resolvedData.contact as Record<string, unknown> | undefined;
      if (contactObj && !resolvedData.profile_image) {
        resolvedData.profile_image = (contactObj.profile_image_url as string) || null;
      }
      console.log(`[CREATIVE] data resolved for job ${job.id}`);

      // 7. Render
      console.log(`[CREATIVE] render started for job ${job.id}`);
      const renderResult = await CreativeRenderer.render(templateDefinition, resolvedData);
      console.log(`[CREATIVE] render completed for job ${job.id} (${renderResult.pngBuffer.length} bytes)`);

      // 8. Storage Upload
      console.log(`[CREATIVE] storage upload starting for job ${job.id}`);
      const uploadResult = await CreativeStorage.uploadCreative(renderResult.pngBuffer, {
        accountId,
        templateId,
        templateVersion,
        sourceType,
        sourceId,
      });
      console.log(`[CREATIVE] storage uploaded: ${uploadResult.publicUrl}`);

      // 9. Update job as GENERATED
      const { data: completedJob } = await supabase
        .from('creative_jobs')
        .update({
          output_url: uploadResult.publicUrl,
          output_path: uploadResult.path,
          status: 'GENERATED',
          completed_at: new Date().toISOString(),
          locked_at: null,
          locked_by: null,
        })
        .eq('id', job.id)
        .select('*')
        .single();

      job = completedJob as CreativeJob;

      // 10. Optional Delivery
      if (deliver && deliveryOptions) {
        await this.deliverJob(job, deliveryOptions, input.deliveryProvider);
      }

      return job;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[CREATIVE] job failed: ${job.id}:`, errorMsg);

      await supabase
        .from('creative_jobs')
        .update({
          status: 'FAILED',
          error: errorMsg,
          locked_at: null,
          locked_by: null,
        })
        .eq('id', job.id);

      throw err;
    }
  }

  /**
   * Delivers a generated creative job via specified or default provider
   */
  static async deliverJob(
    job: CreativeJob,
    options: DeliveryOptions,
    customProvider?: DeliveryProvider
  ): Promise<DeliveryResult> {
    const supabase = getAdminClient();

    await supabase
      .from('creative_jobs')
      .update({ status: 'SENDING' })
      .eq('id', job.id);

    const provider = customProvider || new WhatsAppDeliveryProvider();
    const result = await provider.deliver(job, options);

    if (result.success) {
      await supabase
        .from('creative_jobs')
        .update({
          status: 'SENT',
          sent_at: new Date().toISOString(),
        })
        .eq('id', job.id);
    } else {
      await supabase
        .from('creative_jobs')
        .update({
          status: 'FAILED',
          error: result.error || 'Delivery failed',
        })
        .eq('id', job.id);
    }

    return result;
  }

  /**
   * Lists jobs for an account with status/source filters
   */
  static async listJobs(
    accountId: string,
    filter?: { status?: JobStatus; sourceType?: string; limit?: number }
  ): Promise<CreativeJob[]> {
    const supabase = getAdminClient();

    let query = supabase
      .from('creative_jobs')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(filter?.limit || 50);

    if (filter?.status) query = query.eq('status', filter.status);
    if (filter?.sourceType) query = query.eq('source_type', filter.sourceType);

    const { data, error } = await query;
    if (error) {
      console.error('[Creative Engine:Job] listJobs error:', error);
      return [];
    }

    return (data || []) as CreativeJob[];
  }
}
