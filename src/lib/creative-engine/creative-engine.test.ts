import { describe, expect, it } from 'vitest';
import { CreativeJobManager } from './jobs';
import { CreativeRenderer } from './renderer';
import { CreativeStorage } from './storage';
import { MockDeliveryProvider } from './delivery/mock-provider';
import type { TemplateDefinition, CreativeJob } from './types';

describe('Creative Engine - End-to-End & Idempotency', () => {
  const accountId = 'acc_test_12345';
  const templateId = 'tpl_notif_001';
  const templateVersion = 1;

  const sampleDefinition: TemplateDefinition = {
    width: 800,
    height: 600,
    background: '#1e1b4b',
    elements: [
      {
        id: 'card',
        type: 'ROUNDED_RECTANGLE',
        x: 50,
        y: 50,
        width: 700,
        height: 500,
        borderRadius: 20,
        fill: '#312e81',
        stroke: '#6366f1',
        strokeWidth: 2,
      },
      {
        id: 'title',
        type: 'TEXT',
        x: 90,
        y: 100,
        width: 620,
        height: 50,
        text: 'Protocolo: {{order.code}}',
        fontSize: 32,
        fontWeight: 'bold',
        color: '#a5b4fc',
      },
      {
        id: 'recipient',
        type: 'TEXT',
        x: 90,
        y: 180,
        width: 620,
        height: 40,
        text: 'Titular: {{contact.name | capitalize}}',
        fontSize: 26,
        color: '#ffffff',
      },
      {
        id: 'total',
        type: 'TEXT',
        x: 90,
        y: 250,
        width: 620,
        height: 40,
        text: 'Total: {{order.amount | currency}}',
        fontSize: 28,
        fontWeight: 'bold',
        color: '#4ade80',
      },
    ],
  };

  it('computes deterministic idempotency keys and differentiates different sources', () => {
    const key1 = CreativeJobManager.computeIdempotencyKey(
      accountId,
      templateId,
      templateVersion,
      'ORDER',
      'ord_999'
    );
    const key2 = CreativeJobManager.computeIdempotencyKey(
      accountId,
      templateId,
      templateVersion,
      'ORDER',
      'ord_999'
    );
    const keyDiff = CreativeJobManager.computeIdempotencyKey(
      accountId,
      templateId,
      templateVersion,
      'ORDER',
      'ord_1000'
    );

    expect(key1).toBe(key2);
    expect(key1).not.toBe(keyDiff);
    expect(key1).toHaveLength(64); // SHA-256 hex string
  });

  it('builds account-isolated storage path', () => {
    const path = CreativeStorage.buildPath({
      accountId: 'account-uuid-99',
      templateId: 'tpl-1',
      templateVersion: 2,
      sourceType: 'ORDER',
      sourceId: '123',
      fileName: 'custom-file.png',
    });

    expect(path).toBe('account-account-uuid-99/creatives/tpl-1/v2/custom-file.png');
  });

  it('executes full End-to-End flow: SOURCE -> TEMPLATE -> DATA -> RENDERER -> STORAGE MOCK -> DELIVERY MOCK', async () => {
    // 1. Source business data
    const businessData = {
      order: {
        code: 'PROTO-7890',
        amount: 3200,
      },
      contact: {
        name: 'carlos eduardo',
        phone: '5511988887777',
      },
    };

    // 2. Deterministic render
    const renderResult = await CreativeRenderer.render(sampleDefinition, businessData);
    expect(renderResult.pngBuffer).toBeInstanceOf(Buffer);
    expect(renderResult.pngBuffer.length).toBeGreaterThan(1000);
    expect(renderResult.svg).toContain('PROTO-7890');
    expect(renderResult.svg).toContain('Carlos Eduardo');
    expect(renderResult.svg).toContain('3.200,00');

    // 3. Mock Storage Path
    const storagePath = CreativeStorage.buildPath({
      accountId,
      templateId,
      templateVersion,
      sourceType: 'ORDER',
      sourceId: 'PROTO-7890',
    });
    const mockOutputUrl = `https://storage.supabase.co/${storagePath}`;

    // 4. Creative Job representation
    const job: CreativeJob = {
      id: 'job_test_e2e',
      account_id: accountId,
      template_id: templateId,
      template_version: templateVersion,
      source_type: 'ORDER',
      source_id: 'PROTO-7890',
      creative_type: 'default',
      idempotency_key: CreativeJobManager.computeIdempotencyKey(
        accountId,
        templateId,
        templateVersion,
        'ORDER',
        'PROTO-7890'
      ),
      input_data: businessData,
      output_url: mockOutputUrl,
      output_path: storagePath,
      status: 'GENERATED',
      attempts: 1,
      max_attempts: 3,
      created_at: new Date().toISOString(),
    };

    // 5. Delivery via MockDeliveryProvider
    const mockProvider = new MockDeliveryProvider();
    const deliveryResult = await mockProvider.deliver(job, {
      recipient: businessData.contact.phone,
      channel: 'whatsapp',
      caption: 'Seu protocolo foi gerado!',
    });

    expect(deliveryResult.success).toBe(true);
    expect(deliveryResult.providerMessageId).toBeDefined();
    expect(mockProvider.deliveredCalls).toHaveLength(1);
    expect(mockProvider.deliveredCalls[0].options.recipient).toBe('5511988887777');
  });
});
