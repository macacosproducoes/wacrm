import { describe, it, expect, vi } from 'vitest';
import {
  resolveBroadcastContacts,
  fetchAudienceQuickCounts,
  AudienceConfig,
} from './audience-resolver';

describe('Audience Resolver for WhatsApp Broadcasts', () => {
  it('correctly resolves unpaid contacts and omits paid contacts', async () => {
    const contacts = [
      { id: 'c1', name: 'Lead 1 (Unpaid)', phone: '5511999990001', created_at: new Date().toISOString() },
      { id: 'c2', name: 'Lead 2 (Paid)', phone: '5511999990002', created_at: new Date().toISOString() },
      { id: 'c3', name: 'Lead 3 (Unpaid)', phone: '5511999990003', created_at: new Date().toISOString() },
    ];

    const mockSupabase: any = {
      from: vi.fn((table: string) => {
        if (table === 'contacts') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => Promise.resolve({ data: contacts, error: null })),
              then: vi.fn((resolve) => resolve({ data: contacts, error: null })),
            })),
          };
        }
        if (table === 'automation_logs') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn().mockReturnThis(),
              then: vi.fn((resolve) => resolve({ data: [{ contact_id: 'c2' }], error: null })),
            })),
          };
        }
        if (table === 'webhook_events') {
          return {
            select: vi.fn(() => ({
              in: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              limit: vi.fn(() => Promise.resolve({ data: [], error: null })),
            })),
          };
        }
        return {
          select: vi.fn(() => Promise.resolve({ data: [], error: null })),
        };
      }),
    };

    const audience: AudienceConfig = {
      type: 'unpaid',
    };

    const resolved = await resolveBroadcastContacts(mockSupabase, audience, 'acc_test');
    expect(resolved.map((c) => c.id)).toEqual(['c1', 'c3']);
  });

  it('correctly resolves new_24h contacts', async () => {
    const now = Date.now();
    const contacts = [
      { id: 'c1', name: 'Recent Lead', phone: '5511999990001', created_at: new Date(now - 2 * 3600 * 1000).toISOString() },
      { id: 'c2', name: 'Old Lead', phone: '5511999990002', created_at: new Date(now - 48 * 3600 * 1000).toISOString() },
    ];

    const mockSupabase: any = {
      from: vi.fn((table: string) => {
        if (table === 'contacts') {
          return {
            select: vi.fn(() => ({
              gte: vi.fn(() => ({
                eq: vi.fn(() => Promise.resolve({ data: [contacts[0]], error: null })),
              })),
            })),
          };
        }
        return {
          select: vi.fn(() => Promise.resolve({ data: [], error: null })),
        };
      }),
    };

    const audience: AudienceConfig = {
      type: 'new_24h',
    };

    const resolved = await resolveBroadcastContacts(mockSupabase, audience, 'acc_test');
    expect(resolved.map((c) => c.id)).toEqual(['c1']);
  });

  it('correctly filters out excludeTagIds from smart segments', async () => {
    const contacts = [
      { id: 'c1', name: 'Lead 1 (Normal)', phone: '5511999990001', created_at: new Date().toISOString() },
      { id: 'c2', name: 'Lead 2 (Blacklist)', phone: '5511999990002', created_at: new Date().toISOString() },
    ];

    const mockSupabase: any = {
      from: vi.fn((table: string) => {
        if (table === 'contacts') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => Promise.resolve({ data: contacts, error: null })),
            })),
          };
        }
        if (table === 'automation_logs') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn().mockReturnThis(),
              then: vi.fn((resolve) => resolve({ data: [], error: null })),
            })),
          };
        }
        if (table === 'webhook_events') {
          return {
            select: vi.fn(() => ({
              in: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              limit: vi.fn(() => Promise.resolve({ data: [], error: null })),
            })),
          };
        }
        if (table === 'contact_tags') {
          return {
            select: vi.fn(() => ({
              in: vi.fn(() => Promise.resolve({ data: [{ contact_id: 'c2' }], error: null })),
            })),
          };
        }
        return {
          select: vi.fn(() => Promise.resolve({ data: [], error: null })),
        };
      }),
    };

    const audience: AudienceConfig = {
      type: 'unpaid',
      excludeTagIds: ['tag_blacklist'],
    };

    const resolved = await resolveBroadcastContacts(mockSupabase, audience, 'acc_test');
    expect(resolved.map((c) => c.id)).toEqual(['c1']);
  });
});
