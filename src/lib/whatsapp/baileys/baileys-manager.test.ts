import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  getBaileysStatus,
  hasSavedSession,
  isBaileysConnected,
  sendBaileysText,
  sendBaileysMedia,
} from './baileys-manager';

describe('baileys-manager', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('hasSavedSession', () => {
    it('returns false for non-existent session', () => {
      expect(hasSavedSession('non-existent-account-id-123')).toBe(false);
    });
  });

  describe('isBaileysConnected', () => {
    it('returns false when no active session exists', () => {
      expect(isBaileysConnected('non-existent-account-id-456')).toBe(false);
    });
  });

  describe('getBaileysStatus', () => {
    it('returns disconnected status for an inactive account', async () => {
      const status = await getBaileysStatus('test-account-id-789');
      expect(status.accountId).toBe('test-account-id-789');
      expect(status.status).toBe('disconnected');
      expect(status.qrCode).toBeNull();
    });
  });

  describe('sendBaileysText error handling', () => {
    it('throws descriptive error when attempting to send while disconnected', async () => {
      await expect(
        sendBaileysText('test-account-disconnected', '5511999999999', 'Olá mundo')
      ).rejects.toThrow('WhatsApp não está conectado via QR Code.');
    });
  });

  describe('sendBaileysMedia error handling', () => {
    it('throws descriptive error when attempting to send media while disconnected', async () => {
      await expect(
        sendBaileysMedia(
          'test-account-disconnected',
          '5511999999999',
          'https://example.com/test.png',
          'image',
          'Foto'
        )
      ).rejects.toThrow('WhatsApp não está conectado via QR Code.');
    });
  });
});
