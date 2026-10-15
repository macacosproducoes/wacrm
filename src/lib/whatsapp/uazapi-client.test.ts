import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  normalizeBaseUrl,
  formatUazApiNumber,
  getUazApiStatus,
  connectUazApi,
  disconnectUazApi,
  sendUazApiText,
  sendUazApiMedia,
  setUazApiWebhook,
  addUazApiContact,
} from './uazapi-client';

describe('uazapi-client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('normalizeBaseUrl', () => {
    it('defaults to free.uazapi.com when null/undefined/empty', () => {
      expect(normalizeBaseUrl(null)).toBe('https://free.uazapi.com');
      expect(normalizeBaseUrl('')).toBe('https://free.uazapi.com');
      expect(normalizeBaseUrl('   ')).toBe('https://free.uazapi.com');
    });

    it('strips trailing slashes', () => {
      expect(normalizeBaseUrl('https://api.example.com///')).toBe('https://api.example.com');
      expect(normalizeBaseUrl('https://free.uazapi.com/')).toBe('https://free.uazapi.com');
    });
  });

  describe('formatUazApiNumber', () => {
    it('strips non-digits from phone numbers', () => {
      expect(formatUazApiNumber('+55 (11) 99999-8888')).toBe('5511999998888');
      expect(formatUazApiNumber('5511999998888')).toBe('5511999998888');
    });
  });

  describe('getUazApiStatus', () => {
    it('parses connected status and phone', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'connected',
          phone: '5511999998888',
          name: 'My Instance',
        }),
      } as Response);

      const res = await getUazApiStatus('https://free.uazapi.com', 'tok_123');
      expect(res.status).toBe('connected');
      expect(res.phone).toBe('5511999998888');
      expect(res.name).toBe('My Instance');
    });

    it('parses live UazAPI object status with instance.owner', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          instance: {
            status: 'connected',
            owner: '5516989233842',
            profileName: 'Larissa - Engajamento Real',
          },
          status: {
            connected: true,
            loggedIn: true,
            jid: '5516989233842:16@s.whatsapp.net',
          },
        }),
      } as Response);

      const res = await getUazApiStatus('https://free.uazapi.com', 'tok_123');
      expect(res.status).toBe('connected');
      expect(res.phone).toBe('5516989233842');
      expect(res.name).toBe('Larissa - Engajamento Real');
    });

    it('handles disconnected or error status', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: 'Unauthorized' }),
      } as Response);

      const res = await getUazApiStatus('https://free.uazapi.com', 'bad_tok');
      expect(res.status).toBe('disconnected');
    });
  });

  describe('connectUazApi', () => {
    it('returns QR code on connect', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'connecting',
          qrcode: 'data:image/png;base64,iVBORw...',
        }),
      } as Response);

      const res = await connectUazApi('https://free.uazapi.com', 'tok_123');
      expect(res.status).toBe('connecting');
      expect(res.qrcode).toBe('data:image/png;base64,iVBORw...');
    });
  });

  describe('sendUazApiText', () => {
    it('sends text message and returns messageId', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          key: { id: 'msg_987' },
          status: 'PENDING',
        }),
      } as Response);

      const res = await sendUazApiText('https://free.uazapi.com', 'tok_123', {
        number: '+55 11 99999-8888',
        text: 'Hello from CRM',
      });

      expect(res.messageId).toBe('msg_987');
      expect(res.status).toBe('sent');
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://free.uazapi.com/send/text',
        expect.objectContaining({
          method: 'POST',
          headers: {
            token: 'tok_123',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            number: '5511999998888',
            text: 'Hello from CRM',
          }),
        })
      );
    });
  });

  describe('addUazApiContact', () => {
    it('sends POST /contact/add with formatted number and name', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          message: 'Contato adicionado com sucesso',
        }),
      } as Response);

      const res = await addUazApiContact('https://free.uazapi.com', 'tok_123', {
        number: '+55 (11) 98888-7777',
        name: 'Roberto Cliente',
      });

      expect(res.success).toBe(true);
      expect(res.message).toBe('Contato adicionado com sucesso');
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://free.uazapi.com/contact/add',
        expect.objectContaining({
          method: 'POST',
          headers: {
            token: 'tok_123',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            number: '5511988887777',
            name: 'Roberto Cliente',
          }),
        })
      );
    });
  });

  describe('sendUazApiMedia', () => {
    it('omits url when media is resolved to base64 data URI', async () => {
      // First fetch is resolveMediaPayload fetching the audio buffer
      const mockAudioBuffer = Buffer.from('mock ogg opus audio data');
      const fetchSpy = vi.spyOn(global, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'audio/ogg' }),
          arrayBuffer: async () => mockAudioBuffer.buffer,
        } as Response)
        // Second fetch is the POST /send/media call
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 'uaz_audio_123',
            status: 'sent',
          }),
        } as Response);

      const res = await sendUazApiMedia('https://zap.parceirozapplus.com.br', 'tok_test', {
        number: '+55 11 99999-1234',
        url: 'https://storage.example.com/audio/2_RESTRICOES.ogg',
        type: 'audio',
      });

      expect(res.messageId).toBe('uaz_audio_123');
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      const sendCall = fetchSpy.mock.calls[1];
      expect(sendCall[0]).toBe('https://zap.parceirozapplus.com.br/send/media');
      const sentBody = JSON.parse(sendCall[1]?.body as string);

      expect(sentBody.number).toBe('5511999991234');
      expect(sentBody.type).toBe('ptt');
      expect(sentBody.ptt).toBe(true);
      expect(sentBody.file).toContain('data:audio/ogg');
      // Crucial: body.url MUST be undefined so UazAPI doesn't try to fetch remote URL!
      expect(sentBody.url).toBeUndefined();
      expect(sentBody.mediaUrl).toBeUndefined();
    });
  });
});

