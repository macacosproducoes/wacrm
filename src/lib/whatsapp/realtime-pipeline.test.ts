import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://kzhvkfunvrhjvghhhart.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

describe('WhatsApp Inbound Realtime Pipeline Latency Benchmark', () => {
  it('measures exact DB insert and query latency', async () => {
    if (!SERVICE_KEY) {
      console.log('Skipping live benchmark in unit test mode (no SERVICE_KEY)');
      return;
    }
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: conv } = await admin.from('conversations').select('id').limit(1).single();
    expect(conv?.id).toBeTruthy();

    const t0 = performance.now();
    const testMsgId = 'lat_test_' + Date.now();
    const { data: inserted, error } = await admin
      .from('messages')
      .insert({
        conversation_id: conv!.id,
        sender_type: 'customer',
        content_type: 'text',
        content_text: 'Latency benchmark test',
        message_id: testMsgId,
        status: 'delivered',
      })
      .select('id, created_at')
      .single();

    const tInsert = performance.now();
    expect(error).toBeNull();
    expect(inserted?.id).toBeTruthy();

    const insertDuration = tInsert - t0;
    console.log(`[BENCHMARK] Database Insert Duration: ${insertDuration.toFixed(2)}ms`);
    expect(insertDuration).toBeLessThan(500); // Must be under 500ms

    // Update conversation
    const tConv0 = performance.now();
    await admin
      .from('conversations')
      .update({
        last_message_text: 'Latency benchmark test',
        last_message_at: inserted!.created_at,
      })
      .eq('id', conv!.id);
    const tConvEnd = performance.now();
    const convDuration = tConvEnd - tConv0;
    console.log(`[BENCHMARK] Conversation Update Duration: ${convDuration.toFixed(2)}ms`);

    // Clean up
    await admin.from('messages').delete().eq('id', inserted!.id);
  });
});
