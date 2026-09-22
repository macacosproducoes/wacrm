import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(() =>
    Promise.resolve({
      auth: {
        getUser: mocks.getUser,
      },
    })
  ),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: mocks.from,
  }),
}));

import { GET, POST } from './route';

describe('/api/whatsapp/uazapi/capture-leads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
    });
  });

  it('GET returns 401 when unauthorized', async () => {
    mocks.getUser.mockResolvedValueOnce({ data: { user: null } });
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('GET returns enabled status for account', async () => {
    mocks.from.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { account_id: 'account-1' } }),
            }),
          }),
        };
      }
      if (table === 'whatsapp_connections') {
        const builder: any = {
          eq: () => builder,
          order: () => builder,
          maybeSingle: () =>
            Promise.resolve({
              data: { provider_config: { auto_lead_capture: true } },
            }),
          then: (resolve: any) =>
            Promise.resolve({
              data: [{ provider_config: { auto_lead_capture: true } }],
            }).then(resolve),
        };
        return {
          select: () => builder,
        };
      }
      return {};
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.enabled).toBe(true);
  });

  it('POST toggles auto lead capture', async () => {
    let updatedConfig: unknown = null;
    mocks.from.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { account_id: 'account-1' } }),
            }),
          }),
        };
      }
      if (table === 'whatsapp_connections') {
        const builder: any = {
          eq: () => builder,
          order: () => builder,
          maybeSingle: () =>
            Promise.resolve({
              data: {
                id: 'conn-1',
                provider_config: { base_url: 'https://free.uazapi.com', auto_lead_capture: true },
              },
            }),
          then: (resolve: any) =>
            Promise.resolve({
              data: [
                {
                  id: 'conn-1',
                  provider_config: { base_url: 'https://free.uazapi.com', auto_lead_capture: true },
                },
              ],
            }).then(resolve),
        };
        return {
          select: () => builder,
          update: (payload: { provider_config: unknown }) => {
            updatedConfig = payload.provider_config;
            return {
              eq: () => Promise.resolve({ error: null }),
            };
          },
        };
      }
      return {};
    });

    const req = new Request('http://localhost/api/whatsapp/uazapi/capture-leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'toggle', enabled: false }),
    });

    const res = await POST(req as any);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.enabled).toBe(false);
    expect(updatedConfig).toEqual({
      base_url: 'https://free.uazapi.com',
      auto_lead_capture: false,
    });
  });
});
