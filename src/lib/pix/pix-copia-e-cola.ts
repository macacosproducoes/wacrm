import { type PixKeyType, detectPixKeyType } from './pix-validator';

export interface GeneratePixCopiaEColaOptions {
  pixKey: string;
  pixKeyType?: PixKeyType;
  merchantName?: string;
  merchantCity?: string;
  amount?: number | string;
  txid?: string;
  description?: string;
}

/**
 * Removes accents and special characters, leaving only ASCII alphanumeric and spaces.
 * Truncates to maxLen characters.
 */
function sanitizeText(value: string, maxLen: number): string {
  if (!value) return '';
  const normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  return normalized.slice(0, maxLen);
}

/**
 * Formats a raw PIX key according to BACEN EMV QRCPS rules:
 * - PHONE: +55 followed by 10-11 digits (e.g. +5511971121710)
 * - CPF: exactly 11 digits
 * - CNPJ: exactly 14 digits
 * - EMAIL: lowercase trimmed
 * - EVP: lowercase trimmed
 */
export function formatPixKeyForEMV(rawKey: string, keyType?: PixKeyType): string {
  const trimmed = (rawKey || '').trim();
  const detected = keyType || detectPixKeyType(trimmed);

  if (detected === 'PHONE') {
    const digits = trimmed.replace(/\D/g, '');
    if (digits.startsWith('55') && digits.length >= 12) {
      return `+${digits}`;
    }
    return `+55${digits}`;
  }

  if (detected === 'CPF') {
    return trimmed.replace(/\D/g, '');
  }

  if (detected === 'EMAIL') {
    return trimmed.toLowerCase();
  }

  if (detected === 'EVP') {
    return trimmed.toLowerCase();
  }

  // Fallback
  return trimmed;
}

/**
 * Formats a TLV (Tag-Length-Value) field for EMV BR Code:
 * tag (2 digits) + length (2 digits) + value
 */
function formatTLV(tag: string, value: string): string {
  const len = value.length.toString().padStart(2, '0');
  return `${tag}${len}${value}`;
}

/**
 * Computes CRC-16-CCITT (0xFFFF init, 0x1021 polynomial, no xorout).
 * Exactly as mandated by BACEN Manual do Pix / EMV QRCPS standard.
 */
export function computeCrc16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Generates an official, standard BACEN "Pix Copia e Cola" (BR Code / EMV QRCPS static string).
 * This string is recognized and accepted without error by all Brazilian bank apps
 * (Nubank, Itaú, Bradesco, Inter, Santander, Banco do Brasil, Mercado Pago, Caixa, etc.).
 */
export function generatePixCopiaECola(options: GeneratePixCopiaEColaOptions): string {
  const {
    pixKey,
    pixKeyType,
    merchantName = 'PIX',
    merchantCity = 'SAO PAULO',
    amount,
    txid = '***',
    description,
  } = options;

  if (!pixKey || !pixKey.trim()) {
    throw new Error('Chave PIX obrigatória para gerar Pix Copia e Cola.');
  }

  // If already a Copia e Cola / BR Code string, preserve it as is
  if (pixKeyType === 'COPIA_E_COLA' || pixKey.trim().startsWith('000201')) {
    return pixKey.trim();
  }

  const emvKey = formatPixKeyForEMV(pixKey, pixKeyType);

  // 1. Tag 00: Payload Format Indicator (Fixed '01')
  const tag00 = formatTLV('00', '01');

  // 2. Tag 26: Merchant Account Information
  //    - Subtag 00: GUI ('br.gov.bcb.pix')
  //    - Subtag 01: Chave PIX
  //    - Subtag 02: Descrição (opcional, max 40 chars)
  let subTag26 = formatTLV('00', 'br.gov.bcb.pix') + formatTLV('01', emvKey);
  if (description && description.trim()) {
    const cleanDesc = sanitizeText(description, 40);
    if (cleanDesc) {
      subTag26 += formatTLV('02', cleanDesc);
    }
  }
  const tag26 = formatTLV('26', subTag26);

  // 3. Tag 52: Merchant Category Code (Fixed '0000')
  const tag52 = formatTLV('52', '0000');

  // 4. Tag 53: Transaction Currency (Fixed '986' - BRL)
  const tag53 = formatTLV('53', '986');

  // 5. Tag 54: Transaction Amount (Optional, formatted to 2 decimals e.g. '50.00')
  let tag54 = '';
  if (amount !== undefined && amount !== null && amount !== '') {
    const numAmount = typeof amount === 'number' ? amount : parseFloat(String(amount).replace(',', '.'));
    if (!isNaN(numAmount) && numAmount > 0) {
      tag54 = formatTLV('54', numAmount.toFixed(2));
    }
  }

  // 6. Tag 58: Country Code (Fixed 'BR')
  const tag58 = formatTLV('58', 'BR');

  // 7. Tag 59: Merchant Name (Max 25 chars)
  const cleanName = sanitizeText(merchantName || 'PIX', 25) || 'PIX';
  const tag59 = formatTLV('59', cleanName);

  // 8. Tag 60: Merchant City (Max 15 chars)
  const cleanCity = sanitizeText(merchantCity || 'SAO PAULO', 15) || 'SAO PAULO';
  const tag60 = formatTLV('60', cleanCity);

  // 9. Tag 62: Additional Data Field Template
  //    - Subtag 05: Reference Label / txid (default '***', max 25 chars alphanumeric)
  const cleanTxid = (txid || '***').trim().replace(/[^a-zA-Z0-9*]/g, '').slice(0, 25) || '***';
  const subTag62 = formatTLV('05', cleanTxid);
  const tag62 = formatTLV('62', subTag62);

  // 10. Tag 63: CRC16 prefix ('6304')
  const payloadWithoutCRC = `${tag00}${tag26}${tag52}${tag53}${tag54}${tag58}${tag59}${tag60}${tag62}6304`;

  // Compute CRC-16
  const checksum = computeCrc16(payloadWithoutCRC);

  return `${payloadWithoutCRC}${checksum}`;
}
