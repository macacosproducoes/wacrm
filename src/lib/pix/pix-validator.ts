/**
 * PIX Key Validator & Formatter
 * Supports: EMAIL, PHONE, CPF (and CNPJ), EVP (Random UUID)
 */

export type PixKeyType = 'EMAIL' | 'PHONE' | 'CPF' | 'EVP';

export interface PixValidationResult {
  valid: boolean;
  error?: string;
  formattedKey: string;
  detectedType?: PixKeyType;
}

/**
 * Validates CPF with standard two check-digits algorithm.
 */
function isValidCpf(cpf: string): boolean {
  const clean = cpf.replace(/\D/g, '');
  if (clean.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(clean)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(clean.charAt(i), 10) * (10 - i);
  }
  let rev = 11 - (sum % 11);
  if (rev === 10 || rev === 11) rev = 0;
  if (rev !== parseInt(clean.charAt(9), 10)) return false;

  sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += parseInt(clean.charAt(i), 10) * (11 - i);
  }
  rev = 11 - (sum % 11);
  if (rev === 10 || rev === 11) rev = 0;
  if (rev !== parseInt(clean.charAt(10), 10)) return false;

  return true;
}

/**
 * Validates CNPJ with standard two check-digits algorithm.
 */
function isValidCnpj(cnpj: string): boolean {
  const clean = cnpj.replace(/\D/g, '');
  if (clean.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(clean)) return false;

  let size = clean.length - 2;
  let numbers = clean.substring(0, size);
  const digits = clean.substring(size);
  let sum = 0;
  let pos = size - 7;

  for (let i = size; i >= 1; i--) {
    sum += parseInt(numbers.charAt(size - i), 10) * pos--;
    if (pos < 2) pos = 9;
  }

  let result = sum % 11 < 2 ? 0 : 11 - (sum % 11);
  if (result !== parseInt(digits.charAt(0), 10)) return false;

  size = size + 1;
  numbers = clean.substring(0, size);
  sum = 0;
  pos = size - 7;

  for (let i = size; i >= 1; i--) {
    sum += parseInt(numbers.charAt(size - i), 10) * pos--;
    if (pos < 2) pos = 9;
  }

  result = sum % 11 < 2 ? 0 : 11 - (sum % 11);
  if (result !== parseInt(digits.charAt(1), 10)) return false;

  return true;
}

/**
 * Validates Brazilian or International phone number.
 */
function isValidPhone(phone: string): { valid: boolean; formatted: string } {
  let clean = phone.replace(/[^\d+]/g, '');
  if (clean.startsWith('+')) {
    clean = clean.substring(1);
  }

  // If Brazilian national format without DDI: 10 or 11 digits
  if ((clean.length === 10 || clean.length === 11) && !clean.startsWith('55')) {
    clean = `55${clean}`;
  }

  // Must have between 11 and 14 digits (e.g. 5511999999999)
  if (clean.length < 11 || clean.length > 14) {
    return { valid: false, formatted: phone };
  }

  // Return standard format: +55... or numeric string
  return { valid: true, formatted: `+${clean}` };
}

/**
 * Validates EVP (Random Key UUID v4: 36 characters with hyphens).
 */
function isValidEvp(evp: string): boolean {
  const clean = evp.trim();
  const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  return uuidRegex.test(clean);
}

/**
 * Validates Email address.
 */
function isValidEmail(email: string): boolean {
  const clean = email.trim();
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return emailRegex.test(clean) && clean.length <= 100;
}

/**
 * Auto-detects the PIX key type based on its format.
 */
export function detectPixKeyType(key: string): PixKeyType | null {
  const trimmed = key.trim();
  if (isValidEmail(trimmed)) return 'EMAIL';
  if (isValidEvp(trimmed)) return 'EVP';

  const digitsOnly = trimmed.replace(/\D/g, '');
  if (digitsOnly.length === 11 && isValidCpf(digitsOnly)) return 'CPF';
  if (digitsOnly.length === 14 && isValidCnpj(digitsOnly)) return 'CPF';

  const phoneCheck = isValidPhone(trimmed);
  if (phoneCheck.valid) return 'PHONE';

  return null;
}

/**
 * Validates a PIX key against its declared type.
 */
export function validatePixKey(key: string, type: PixKeyType): PixValidationResult {
  const raw = (key || '').trim();
  if (!raw) {
    return { valid: false, error: 'A chave PIX não pode ficar vazia.', formattedKey: '' };
  }

  switch (type) {
    case 'EMAIL': {
      if (!isValidEmail(raw)) {
        return {
          valid: false,
          error: 'E-mail inválido. Verifique o formato informado (ex: financeiro@empresa.com).',
          formattedKey: raw.toLowerCase(),
          detectedType: 'EMAIL',
        };
      }
      return { valid: true, formattedKey: raw.toLowerCase(), detectedType: 'EMAIL' };
    }

    case 'PHONE': {
      const check = isValidPhone(raw);
      if (!check.valid) {
        return {
          valid: false,
          error: 'Telefone inválido. Informe com DDD (ex: 11987654321 ou +5511987654321).',
          formattedKey: raw,
          detectedType: 'PHONE',
        };
      }
      return { valid: true, formattedKey: check.formatted, detectedType: 'PHONE' };
    }

    case 'CPF': {
      const cleanDigits = raw.replace(/\D/g, '');
      if (cleanDigits.length === 11) {
        if (!isValidCpf(cleanDigits)) {
          return {
            valid: false,
            error: 'CPF inválido. Verifique os dígitos verificadores informados.',
            formattedKey: cleanDigits,
            detectedType: 'CPF',
          };
        }
        return { valid: true, formattedKey: cleanDigits, detectedType: 'CPF' };
      }

      if (cleanDigits.length === 14) {
        if (!isValidCnpj(cleanDigits)) {
          return {
            valid: false,
            error: 'CNPJ inválido. Verifique os dígitos verificadores informados.',
            formattedKey: cleanDigits,
            detectedType: 'CPF',
          };
        }
        return { valid: true, formattedKey: cleanDigits, detectedType: 'CPF' };
      }

      return {
        valid: false,
        error: 'CPF deve conter 11 dígitos ou CNPJ com 14 dígitos.',
        formattedKey: cleanDigits,
        detectedType: 'CPF',
      };
    }

    case 'EVP': {
      if (!isValidEvp(raw)) {
        return {
          valid: false,
          error: 'Chave aleatória inválida. Deve seguir o padrão UUID (ex: 123e4567-e89b-12d3-a456-426614174000).',
          formattedKey: raw.toLowerCase(),
          detectedType: 'EVP',
        };
      }
      return { valid: true, formattedKey: raw.toLowerCase(), detectedType: 'EVP' };
    }

    default:
      return {
        valid: false,
        error: `Tipo de chave não suportado: ${type}. Utilize EMAIL, PHONE, CPF ou EVP.`,
        formattedKey: raw,
      };
  }
}
