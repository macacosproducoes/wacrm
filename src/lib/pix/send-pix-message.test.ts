import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendPixMessage } from './send-pix-message';
import * as uazapiClient from '@/lib/whatsapp/uazapi-client';
import * as pixConfig from './pix-config';
import * as encryption from '@/lib/whatsapp/encryption';
import * as convHelpers from '@/lib/whatsapp/conversation-helpers';
import { whatsappBus } from '@/lib/whatsapp/whatsapp-bus';

// Mock dependencies
vi.mock('@/lib/flows/admin-client', () => {
  const insertMock = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({
        data: { id: 'db-msg-uuid-123' },
        error: null,
      }),
    }),
  });

  const singleConversationMock = vi.fn().mockResolvedValue({
    data: {
      id: 'conv-123',
      contact_id: 'contact-456',
      contacts: {
        id: 'contact-456',
        phone: '5511999998888',
        name: 'Cliente Teste',
      },
    },
    error: null,
  });

  const selectConnectionsMock = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        order: vi.fn().mockResolvedValue({
          data: [
            {
              id: 'conn-1',
              account_id: 'acc-1',
              provider: 'uazapi',
              is_active: true,
              provider_config: {
                base_url: 'https://test.uazapi.com',
                token: 'encrypted-token-xyz',
              },
            },
          ],
          error: null,
        }),
      }),
    }),
  });

  const fromMock = vi.fn((table: string) => {
    if (table === 'conversations') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: singleConversationMock,
            }),
          }),
        }),
      };
    }
    if (table === 'whatsapp_connections') {
      return {
        select: selectConnectionsMock,
      };
    }
    if (table === 'messages') {
      return {
        insert: insertMock,
      };
    }
    return {};
  });

  return {
    supabaseAdmin: () => ({
      from: fromMock,
    }),
  };
});

describe('sendPixMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(encryption, 'decrypt').mockReturnValue('decrypted-token-abc');
    vi.spyOn(convHelpers, 'updateConversationWithMessage').mockResolvedValue(undefined as any);
    vi.spyOn(whatsappBus, 'emitInboxEvent').mockImplementation(() => {});
  });

  it('sends native PIX button via UAZAPI and records in database with interactive payload', async () => {
    const sendSpy = vi.spyOn(uazapiClient, 'sendUazApiPixButton').mockResolvedValue({
      messageId: 'uazapi-msg-999',
      status: 'PENDING',
      raw: { id: 'uazapi-msg-999', status: 'PENDING' },
    });

    const result = await sendPixMessage({
      accountId: 'acc-1',
      conversationId: 'conv-123',
      pixKey: 'teste@empresa.com.br',
      pixKeyType: 'EMAIL',
      merchantName: 'Minha Empresa LTDA',
      text: 'Chave para pagar o pedido:',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('uazapi-msg-999');
    expect(result.dbMessageId).toBe('db-msg-uuid-123');
    expect(result.pixKey).toBe('teste@empresa.com.br');
    expect(result.pixKeyType).toBe('EMAIL');
    expect(result.merchantName).toBe('Minha Empresa LTDA');

    expect(sendSpy).toHaveBeenCalledWith(
      'https://test.uazapi.com',
      'decrypted-token-abc',
      expect.objectContaining({
        number: '5511999998888',
        pixKey: 'teste@empresa.com.br',
        pixType: 'EMAIL',
        pixName: 'Minha Empresa LTDA',
        text: 'Chave para pagar o pedido:',
      })
    );

    expect(whatsappBus.emitInboxEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc-1',
        conversationId: 'conv-123',
        eventType: 'INSERT',
        message: expect.objectContaining({
          content_type: 'interactive',
          interactive_payload: expect.objectContaining({
            type: 'pix',
            pix_key: 'teste@empresa.com.br',
            pix_key_type: 'EMAIL',
            pix_merchant_name: 'Minha Empresa LTDA',
            provider: 'uazapi',
          }),
        }),
      })
    );
  });

  it('rejects invalid PIX key before calling UAZAPI', async () => {
    const sendSpy = vi.spyOn(uazapiClient, 'sendUazApiPixButton');

    await expect(
      sendPixMessage({
        accountId: 'acc-1',
        conversationId: 'conv-123',
        pixKey: 'not-an-email',
        pixKeyType: 'EMAIL',
      })
    ).rejects.toThrow(/e-mail/i);

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('falls back to company PIX config when parameters are omitted', async () => {
    vi.spyOn(pixConfig, 'getPixConfig').mockResolvedValue({
      pix_key: '11987654321',
      pix_key_type: 'PHONE',
      pix_merchant_name: 'Loja Padrão',
    });

    const sendSpy = vi.spyOn(uazapiClient, 'sendUazApiPixButton').mockResolvedValue({
      messageId: 'uazapi-msg-888',
      status: 'PENDING',
      raw: {},
    });

    const result = await sendPixMessage({
      accountId: 'acc-1',
      conversationId: 'conv-123',
    });

    expect(result.success).toBe(true);
    expect(result.pixKey).toBe('+5511987654321');
    expect(result.pixKeyType).toBe('PHONE');
    expect(result.merchantName).toBe('Loja Padrão');
    expect(sendSpy).toHaveBeenCalled();
  });

  it('sends standard Pix Copia e Cola message via UAZAPI when sendMode is copia_e_cola', async () => {
    const textSpy = vi.spyOn(uazapiClient, 'sendUazApiText').mockResolvedValue({
      messageId: 'uazapi-text-111',
      status: 'sent',
      raw: {},
    });
    const buttonSpy = vi.spyOn(uazapiClient, 'sendUazApiPixButton');

    const result = await sendPixMessage({
      accountId: 'acc-1',
      conversationId: 'conv-123',
      pixKey: '11971121710',
      pixKeyType: 'PHONE',
      merchantName: 'Engajamento Real',
      sendMode: 'copia_e_cola',
    });

    expect(result.success).toBe(true);
    expect(result.sendMode).toBe('copia_e_cola');
    expect(result.pixCopiaECola).toBeDefined();
    expect(result.pixCopiaECola?.startsWith('000201')).toBe(true);
    expect(buttonSpy).not.toHaveBeenCalled();
    expect(textSpy).toHaveBeenCalledWith(
      'https://test.uazapi.com',
      'decrypted-token-abc',
      expect.objectContaining({
        text: result.pixCopiaECola,
      })
    );
  });

  it('sends native button and preserves exact Copia e Cola payload when pixKeyType is COPIA_E_COLA', async () => {
    const rawCopiaECola = '00020126360014BR.GOV.BCB.PIX0114+5511999999995204000053039865802BR5910TESTE6009SAO PAULO62070503***6304ABCD';
    const buttonSpy = vi.spyOn(uazapiClient, 'sendUazApiPixButton').mockResolvedValue({
      messageId: 'uazapi-btn-999',
      status: 'sent',
      raw: {},
    });

    const result = await sendPixMessage({
      accountId: 'acc-1',
      conversationId: 'conv-123',
      pixKey: rawCopiaECola,
      pixKeyType: 'COPIA_E_COLA',
      merchantName: 'Minha Empresa',
      sendMode: 'button',
    });

    expect(result.success).toBe(true);
    expect(result.pixKey).toBe(rawCopiaECola);
    expect(result.pixKeyType).toBe('COPIA_E_COLA');
    expect(buttonSpy).toHaveBeenCalledWith(
      'https://test.uazapi.com',
      'decrypted-token-abc',
      expect.objectContaining({
        pixKey: rawCopiaECola,
        pixType: 'COPIA_E_COLA',
      })
    );
  });
});
