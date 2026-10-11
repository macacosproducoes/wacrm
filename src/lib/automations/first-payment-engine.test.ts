import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
/**
 * Vitest Test Suite for First Payment Confirmation Automation
 * 
 * Validates all 8 mandatory scenarios:
 * 1. Primeiro pagamento aprovado: enviar o áudio.
 * 2. Segundo pagamento do mesmo lead: não enviar novamente.
 * 3. Webhook repetido do mesmo pagamento: não duplicar o envio.
 * 4. Pagamento pendente: não enviar.
 * 5. Pagamento cancelado ou expirado: não enviar.
 * 6. Falha temporária do ZapPlus: registrar e permitir nova tentativa segura.
 * 7. Dois pagamentos confirmados simultaneamente: garantir apenas um disparo por lead.
 * 8. Novo lead com primeiro pagamento aprovado: criar contato e enviar normalmente.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import * as uazapiClient from '@/lib/whatsapp/uazapi-client';
import { processFirstPaymentAutomation } from './first-payment-engine';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(supabaseUrl, supabaseKey);

const ACCOUNT_ID = 'ce78c02b-49e0-43bf-b384-7cdd52f61b9f';
const NOW = Date.now();

const cleanupContactIds: string[] = [];
const cleanupLogIds: string[] = [];

describe('Automação de Confirmação do Primeiro Pagamento Pix', () => {
  let dispatchedCalls: Array<{ number: string; url: string; ptt?: boolean }> = [];
  let shouldFailZapPlus = false;

  beforeEach(() => {
    dispatchedCalls = [];
    shouldFailZapPlus = false;

    vi.spyOn(uazapiClient, 'sendUazApiMedia').mockImplementation(async (_base, _token, opts) => {
      if (shouldFailZapPlus) {
        throw new Error('503 Service Unavailable: ZapPlus timeout');
      }
      dispatchedCalls.push(opts);
      return {
        success: true,
        status: 'delivered',
        messageId: `wpp_msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      };
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    // Clean up created test logs & contacts
    for (const logId of cleanupLogIds) {
      await admin.from('automation_logs').delete().eq('id', logId);
    }
    for (const cid of cleanupContactIds) {
      await admin.from('messages').delete().eq('conversation_id', cid);
      await admin.from('conversations').delete().eq('contact_id', cid);
      await admin.from('contacts').delete().eq('id', cid);
    }
  });

  it('Cenário 1: Primeiro pagamento aprovado deve disparar o áudio do ZapPlus', async () => {
    const testPhone = `551199991${String(NOW).slice(-4)}`;
    const { data: contact } = await admin
      .from('contacts')
      .insert({
        account_id: ACCOUNT_ID,
        user_id: '952cb520-d730-486b-8e00-dd63a5b4b529',
        name: 'Lead Teste Cenário 1',
        phone: testPhone,
              })
      .select('id')
      .single();

    expect(contact).toBeDefined();
    cleanupContactIds.push(contact!.id);

    const result = await processFirstPaymentAutomation({
      payment_id: `pay_c1_${NOW}`,
      external_id: `smm_${contact!.id}_${NOW}_1`,
      status: 'paid',
      amount: 25.0,
      contact_id: contact!.id,
      account_id: ACCOUNT_ID,
      buyer: { name: 'Lead Teste Cenário 1', phone: testPhone },
    });

    if (result.logId) cleanupLogIds.push(result.logId);

    expect(result.success).toBe(true);
    expect(result.dispatched).toBe(true);
    expect(result.messageId).toBeDefined();
    expect(dispatchedCalls.length).toBe(1);
    expect(dispatchedCalls[0].ptt).toBe(true);
  });

  it('Cenário 2: Segundo pagamento do mesmo lead não deve enviar novamente', async () => {
    const testPhone = `551199992${String(NOW).slice(-4)}`;
    const { data: contact } = await admin
      .from('contacts')
      .insert({
        account_id: ACCOUNT_ID,
        user_id: '952cb520-d730-486b-8e00-dd63a5b4b529',
        name: 'Lead Teste Cenário 2',
        phone: testPhone,
              })
      .select('id')
      .single();

    cleanupContactIds.push(contact!.id);

    // First payment (dispatches)
    const firstRes = await processFirstPaymentAutomation({
      payment_id: `pay_c2_first_${NOW}`,
      external_id: `smm_${contact!.id}_${NOW}_f`,
      status: 'paid',
      amount: 25.0,
      contact_id: contact!.id,
      account_id: ACCOUNT_ID,
      buyer: { name: 'Lead Teste Cenário 2', phone: testPhone },
    });
    if (firstRes.logId) cleanupLogIds.push(firstRes.logId);
    expect(firstRes.dispatched).toBe(true);
    dispatchedCalls = [];

    // Second payment (must NOT dispatch)
    const secondRes = await processFirstPaymentAutomation({
      payment_id: `pay_c2_second_${NOW}`,
      external_id: `smm_${contact!.id}_${NOW}_s`,
      status: 'paid',
      amount: 50.0,
      contact_id: contact!.id,
      account_id: ACCOUNT_ID,
      buyer: { name: 'Lead Teste Cenário 2', phone: testPhone },
    });

    expect(secondRes.success).toBe(true);
    expect(secondRes.dispatched).toBe(false);
    expect(secondRes.skipped).toBe(true);
    expect(secondRes.reason).toBe('lead_already_had_payment');
    expect(dispatchedCalls.length).toBe(0);
  });

  it('Cenário 3: Webhook repetido do mesmo pagamento não deve duplicar o envio', async () => {
    const testPhone = `551199993${String(NOW).slice(-4)}`;
    const { data: contact } = await admin
      .from('contacts')
      .insert({
        account_id: ACCOUNT_ID,
        user_id: '952cb520-d730-486b-8e00-dd63a5b4b529',
        name: 'Lead Teste Cenário 3',
        phone: testPhone,
              })
      .select('id')
      .single();

    cleanupContactIds.push(contact!.id);
    const paymentId = `pay_c3_duplicate_${NOW}`;

    const res1 = await processFirstPaymentAutomation({
      payment_id: paymentId,
      external_id: `smm_${contact!.id}_${NOW}_dup`,
      status: 'paid',
      amount: 25.0,
      contact_id: contact!.id,
      account_id: ACCOUNT_ID,
      buyer: { name: 'Lead Teste Cenário 3', phone: testPhone },
    });
    if (res1.logId) cleanupLogIds.push(res1.logId);
    expect(res1.dispatched).toBe(true);
    dispatchedCalls = [];

    // Duplicate webhook
    const res2 = await processFirstPaymentAutomation({
      payment_id: paymentId,
      external_id: `smm_${contact!.id}_${NOW}_dup`,
      status: 'paid',
      amount: 25.0,
      contact_id: contact!.id,
      account_id: ACCOUNT_ID,
      buyer: { name: 'Lead Teste Cenário 3', phone: testPhone },
    });

    expect(res2.dispatched).toBe(false);
    expect(res2.skipped).toBe(true);
    expect(['duplicate_payment_webhook', 'lead_already_had_payment']).toContain(res2.reason);
    expect(dispatchedCalls.length).toBe(0);
  });

  it('Cenário 4: Pagamento pendente não deve enviar áudio', async () => {
    const testPhone = `551199994${String(NOW).slice(-4)}`;
    const result = await processFirstPaymentAutomation({
      payment_id: `pay_c4_pending_${NOW}`,
      status: 'pending',
      amount: 25.0,
      account_id: ACCOUNT_ID,
      buyer: { name: 'Lead Teste Cenário 4', phone: testPhone },
    });

    expect(result.dispatched).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('payment_status_pending');
    expect(dispatchedCalls.length).toBe(0);
  });

  it('Cenário 5: Pagamento cancelado ou expirado não deve enviar áudio', async () => {
    const testPhone = `551199995${String(NOW).slice(-4)}`;
    const result = await processFirstPaymentAutomation({
      payment_id: `pay_c5_expired_${NOW}`,
      status: 'expired',
      amount: 25.0,
      account_id: ACCOUNT_ID,
      buyer: { name: 'Lead Teste Cenário 5', phone: testPhone },
    });

    expect(result.dispatched).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('payment_status_expired');
    expect(dispatchedCalls.length).toBe(0);
  });

  it('Cenário 6: Falha temporária do ZapPlus deve registrar o erro e permitir retry seguro', async () => {
    const testPhone = `551199996${String(NOW).slice(-4)}`;
    const { data: contact } = await admin
      .from('contacts')
      .insert({
        account_id: ACCOUNT_ID,
        user_id: '952cb520-d730-486b-8e00-dd63a5b4b529',
        name: 'Lead Teste Cenário 6',
        phone: testPhone,
              })
      .select('id')
      .single();

    cleanupContactIds.push(contact!.id);
    const paymentId = `pay_c6_fail_${NOW}`;

    shouldFailZapPlus = true;
    const failRes = await processFirstPaymentAutomation({
      payment_id: paymentId,
      external_id: `smm_${contact!.id}_${NOW}_fail`,
      status: 'paid',
      amount: 30.0,
      contact_id: contact!.id,
      account_id: ACCOUNT_ID,
      buyer: { name: 'Lead Teste Cenário 6', phone: testPhone },
    });

    if (failRes.logId) cleanupLogIds.push(failRes.logId);
    expect(failRes.success).toBe(false);
    expect(failRes.dispatched).toBe(false);
    expect(failRes.error).toContain('ZapPlus timeout');

    // ZapPlus recovered -> trigger retry
    shouldFailZapPlus = false;
    const retryRes = await processFirstPaymentAutomation({
      payment_id: paymentId,
      external_id: `smm_${contact!.id}_${NOW}_fail`,
      status: 'paid',
      amount: 30.0,
      contact_id: contact!.id,
      account_id: ACCOUNT_ID,
      buyer: { name: 'Lead Teste Cenário 6', phone: testPhone },
      force_retry: true,
    });

    if (retryRes.logId) cleanupLogIds.push(retryRes.logId);
    expect(retryRes.success).toBe(true);
    expect(retryRes.dispatched).toBe(true);
    expect(dispatchedCalls.length).toBe(1);
  });

  it('Cenário 7: Dois pagamentos confirmados simultaneamente devem garantir apenas 1 disparo por lead', async () => {
    const testPhone = `551199997${String(NOW).slice(-4)}`;
    const { data: contact } = await admin
      .from('contacts')
      .insert({
        account_id: ACCOUNT_ID,
        user_id: '952cb520-d730-486b-8e00-dd63a5b4b529',
        name: 'Lead Teste Cenário 7 Concorrente',
        phone: testPhone,
              })
      .select('id')
      .single();

    cleanupContactIds.push(contact!.id);

    const [resA, resB] = await Promise.all([
      processFirstPaymentAutomation({
        payment_id: `pay_c7_concA_${NOW}`,
        external_id: `smm_${contact!.id}_${NOW}_concA`,
        status: 'paid',
        amount: 25.0,
        contact_id: contact!.id,
        account_id: ACCOUNT_ID,
        buyer: { name: 'Lead Teste Cenário 7', phone: testPhone },
      }),
      processFirstPaymentAutomation({
        payment_id: `pay_c7_concB_${NOW}`,
        external_id: `smm_${contact!.id}_${NOW}_concB`,
        status: 'paid',
        amount: 35.0,
        contact_id: contact!.id,
        account_id: ACCOUNT_ID,
        buyer: { name: 'Lead Teste Cenário 7', phone: testPhone },
      }),
    ]);

    if (resA.logId) cleanupLogIds.push(resA.logId);
    if (resB.logId) cleanupLogIds.push(resB.logId);

    const totalDispatched = (resA.dispatched ? 1 : 0) + (resB.dispatched ? 1 : 0);
    expect(totalDispatched).toBe(1);
    expect(dispatchedCalls.length).toBe(1);
  });

  it('Cenário 8: Novo lead com primeiro pagamento aprovado deve criar contato e enviar áudio normalmente', async () => {
    const brandNewPhone = `551198888${String(NOW).slice(-4)}`;

    const res = await processFirstPaymentAutomation({
      payment_id: `pay_c8_new_lead_${NOW}`,
      external_id: `smm_order_${NOW}_new_lead`,
      status: 'paid',
      amount: 45.0,
      account_id: ACCOUNT_ID,
      buyer: {
        name: 'Cliente Inédito Cenário 8',
        phone: brandNewPhone,
        email: `lead_${NOW}@teste.com`,
      },
    });

    if (res.leadId) cleanupContactIds.push(res.leadId);
    if (res.logId) cleanupLogIds.push(res.logId);

    expect(res.success).toBe(true);
    expect(res.dispatched).toBe(true);
    expect(res.leadId).toBeDefined();
    expect(dispatchedCalls.length).toBe(1);
  });
});
