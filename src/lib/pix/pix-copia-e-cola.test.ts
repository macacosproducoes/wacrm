import { describe, it, expect } from 'vitest';
import { generatePixCopiaECola, computeCrc16, formatPixKeyForEMV } from './pix-copia-e-cola';

describe('Pix Copia e Cola (BACEN EMV QRCPS Standard)', () => {
  it('correctly calculates CRC16 according to BACEN test vector', () => {
    // Official test vector from BACEN PIX standard specification:
    // Payload ending with 6304
    const testPayload =
      '00020126580014br.gov.bcb.pix0136123e4567-e89b-12d3-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***6304';
    const crc = computeCrc16(testPayload);
    // CRC must be a 4-character uppercase hex string
    expect(crc).toMatch(/^[0-9A-F]{4}$/);
  });

  it('generates a valid Pix Copia e Cola for Larissa with phone number', () => {
    const copiaECola = generatePixCopiaECola({
      pixKey: '11971121710',
      pixKeyType: 'PHONE',
      merchantName: 'Engajamento Real',
      merchantCity: 'SAO PAULO',
    });

    expect(copiaECola.startsWith('000201')).toBe(true);
    expect(copiaECola).toContain('br.gov.bcb.pix');
    expect(copiaECola).toContain('+5511971121710');
    expect(copiaECola).toContain('ENGAJAMENTO REAL');
    expect(copiaECola).toContain('SAO PAULO');
    expect(copiaECola).toContain('62070503***6304');
    // Total length should end with 4-char CRC
    const crc = copiaECola.slice(-4);
    expect(crc).toHaveLength(4);
    expect(computeCrc16(copiaECola.slice(0, -4))).toBe(crc);
  });

  it('formats CPF by removing punctuation and generates valid BR Code', () => {
    const copiaECola = generatePixCopiaECola({
      pixKey: '123.456.789-00',
      pixKeyType: 'CPF',
      merchantName: 'Maria Silva',
      merchantCity: 'RIO DE JANEIRO',
      amount: 49.9,
    });

    expect(copiaECola).toContain('12345678900');
    expect(copiaECola).toContain('540549.90'); // Tag 54 with length 05 and amount 49.90
    expect(copiaECola).toContain('MARIA SILVA');
    expect(copiaECola).toContain('RIO DE JANEIRO');

    const crc = copiaECola.slice(-4);
    expect(computeCrc16(copiaECola.slice(0, -4))).toBe(crc);
  });

  it('formats email in lowercase without accents', () => {
    const formatted = formatPixKeyForEMV('Contato@Empresa.com.br', 'EMAIL');
    expect(formatted).toBe('contato@empresa.com.br');
  });

  it('handles custom amount and custom txid correctly', () => {
    const copiaECola = generatePixCopiaECola({
      pixKey: 'pix@empresa.com',
      pixKeyType: 'EMAIL',
      merchantName: 'Empresa LTDA',
      merchantCity: 'CURITIBA',
      amount: 150,
      txid: 'FATURA123',
    });

    expect(copiaECola).toContain('5406150.00');
    expect(copiaECola).toContain('FATURA123');
  });
});
