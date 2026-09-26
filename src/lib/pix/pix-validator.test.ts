import { describe, it, expect } from 'vitest';
import { validatePixKey, detectPixKeyType } from './pix-validator';

describe('pix-validator', () => {
  describe('EMAIL', () => {
    it('accepts valid email', () => {
      const res = validatePixKey('financeiro@empresa.com.br', 'EMAIL');
      expect(res.valid).toBe(true);
      expect(res.formattedKey).toBe('financeiro@empresa.com.br');
    });

    it('rejects invalid email', () => {
      const res = validatePixKey('invalid-email', 'EMAIL');
      expect(res.valid).toBe(false);
      expect(res.error).toContain('E-mail inválido');
    });
  });

  describe('PHONE', () => {
    it('accepts phone with DDD without DDI and normalizes', () => {
      const res = validatePixKey('16989233842', 'PHONE');
      expect(res.valid).toBe(true);
      expect(res.formattedKey).toBe('+5516989233842');
    });

    it('accepts phone with international prefix', () => {
      const res = validatePixKey('+5511987654321', 'PHONE');
      expect(res.valid).toBe(true);
      expect(res.formattedKey).toBe('+5511987654321');
    });

    it('rejects short phone number', () => {
      const res = validatePixKey('12345', 'PHONE');
      expect(res.valid).toBe(false);
      expect(res.error).toContain('Telefone inválido');
    });
  });

  describe('CPF', () => {
    it('rejects repeated digits', () => {
      const res = validatePixKey('11111111111', 'CPF');
      expect(res.valid).toBe(false);
      expect(res.error).toContain('CPF inválido');
    });

    it('validates a mathematically correct CPF', () => {
      // 52998224725 is a mathematically valid CPF test string
      const res = validatePixKey('529.982.247-25', 'CPF');
      expect(res.valid).toBe(true);
      expect(res.formattedKey).toBe('52998224725');
    });
  });

  describe('EVP', () => {
    it('accepts valid UUID v4', () => {
      const uuid = 'f9fee3da-0ba4-4a29-b343-06f5f68a9b5d';
      const res = validatePixKey(uuid, 'EVP');
      expect(res.valid).toBe(true);
      expect(res.formattedKey).toBe(uuid);
    });

    it('rejects invalid UUID format', () => {
      const res = validatePixKey('not-a-uuid', 'EVP');
      expect(res.valid).toBe(false);
      expect(res.error).toContain('Chave aleatória inválida');
    });
  });

  describe('COPIA_E_COLA', () => {
    it('accepts standard BR Code starting with 000201', () => {
      const brCode = '00020126360014BR.GOV.BCB.PIX0114+5511999999995204000053039865802BR5910EMPRESA6009SAO PAULO62070503***6304ABCD';
      const res = validatePixKey(brCode, 'COPIA_E_COLA');
      expect(res.valid).toBe(true);
      expect(res.formattedKey).toBe(brCode);
      expect(res.detectedType).toBe('COPIA_E_COLA');
    });

    it('rejects too short Copia e Cola', () => {
      const res = validatePixKey('12345', 'COPIA_E_COLA');
      expect(res.valid).toBe(false);
      expect(res.error).toContain('Código PIX Copia e Cola inválido');
    });
  });

  describe('detectPixKeyType', () => {
    it('detects Copia e Cola', () => {
      expect(detectPixKeyType('00020126360014BR.GOV.BCB.PIX0114+551199999999520400005303986...')).toBe('COPIA_E_COLA');
    });

    it('detects email', () => {
      expect(detectPixKeyType('pix@empresa.com')).toBe('EMAIL');
    });

    it('detects EVP', () => {
      expect(detectPixKeyType('9a9e33c1-01f2-4bc4-a6e5-4c07920ab3ef')).toBe('EVP');
    });

    it('detects phone', () => {
      expect(detectPixKeyType('+5516989233842')).toBe('PHONE');
    });
  });
});
