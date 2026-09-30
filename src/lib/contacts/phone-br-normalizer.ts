/**
 * Normalizador centralizado de telefones brasileiros para o formato internacional E.164 (+55...).
 * Suporta formatos:
 * - 11987654321        -> +5511987654321
 * - (11) 98765-4321    -> +5511987654321
 * - 5511987654321      -> +5511987654321
 * - +55 11 98765-4321  -> +5511987654321
 * - 1133334444         -> +551133334444 (fixo)
 * - +551133334444      -> +551133334444
 */

export interface PhoneNormalizationResult {
  raw: string;
  normalized: string;
  isValid: boolean;
  error?: string;
  reason?: string;
  ddd?: string;
  type?: 'mobile' | 'landline';
  lineNumber?: number;
}

export type NormalizedPhoneResult = PhoneNormalizationResult & {
  isValid: true;
  type: 'mobile' | 'landline';
};

export type InvalidPhoneResult = PhoneNormalizationResult & {
  isValid: false;
  reason: string;
};

export interface BulkPhoneParseResult {
  totalLines: number;
  emptyLines: number;
  validList: NormalizedPhoneResult[];
  duplicatesInText: NormalizedPhoneResult[];
  invalidList: InvalidPhoneResult[];
}

/** DDDs oficiais da Anatel no Brasil */
export const VALID_BRAZILIAN_DDDS = new Set([
  '11', '12', '13', '14', '15', '16', '17', '18', '19',
  '21', '22', '24', '27', '28',
  '31', '32', '33', '34', '35', '37', '38',
  '41', '42', '43', '44', '45', '46', '47', '48', '49',
  '51', '53', '54', '55',
  '61', '62', '63', '64', '65', '66', '67', '68', '69',
  '71', '73', '74', '75', '77', '79',
  '81', '82', '83', '84', '85', '86', '87', '88', '89',
  '91', '92', '93', '94', '95', '96', '97', '98', '99',
]);

/**
 * Normaliza um número individual brasileiro para +55...
 */
export function normalizeBrazilianPhone(
  rawInput: string,
  lineNumber?: number
): PhoneNormalizationResult {
  if (!rawInput || typeof rawInput !== 'string') {
    const msg = 'Linha vazia';
    return { raw: '', normalized: '', isValid: false, error: msg, reason: msg, lineNumber };
  }

  const trimmed = rawInput.trim();
  if (!trimmed) {
    const msg = 'Linha vazia';
    return { raw: rawInput, normalized: '', isValid: false, error: msg, reason: msg, lineNumber };
  }

  // Remove caracteres comuns de formatação e texto
  let digits = trimmed.replace(/\D/g, '');

  if (!digits) {
    const msg = 'Nenhum dígito numérico encontrado';
    return { raw: trimmed, normalized: '', isValid: false, error: msg, reason: msg, lineNumber };
  }

  // Se o usuário digitou zero antes do DDD (ex: 011 98765-4321 onde 0 é prefixo de discagem)
  if (digits.startsWith('0') && (digits.length === 11 || digits.length === 12)) {
    digits = digits.slice(1);
  }

  let finalNumber = '';
  let ddd = '';
  let phoneType: 'mobile' | 'landline' = 'mobile';

  if (digits.length === 10) {
    // DDD (2) + Fixo (8 dígitos) -> 10 dígitos totais
    ddd = digits.slice(0, 2);
    finalNumber = '+55' + digits;
    phoneType = 'landline';
  } else if (digits.length === 11) {
    // DDD (2) + Celular (9 dígitos) -> 11 dígitos totais
    ddd = digits.slice(0, 2);
    finalNumber = '+55' + digits;
    phoneType = 'mobile';
  } else if (digits.length === 12 && digits.startsWith('55')) {
    // 55 (2) + DDD (2) + Fixo (8 dígitos) -> 12 dígitos totais
    ddd = digits.slice(2, 4);
    finalNumber = '+' + digits;
    phoneType = 'landline';
  } else if (digits.length === 13 && digits.startsWith('55')) {
    // 55 (2) + DDD (2) + Celular (9 dígitos) -> 13 dígitos totais
    ddd = digits.slice(2, 4);
    finalNumber = '+' + digits;
    phoneType = 'mobile';
  } else {
    let errorDetail = 'Formato inválido';
    if (digits.length < 10) {
      errorDetail = 'Poucos dígitos (' + digits.length + ' encontrados, mínimo 10 com DDD)';
    } else if (digits.length > 13) {
      errorDetail = 'Muitos dígitos (' + digits.length + ' encontrados)';
    } else if (!digits.startsWith('55')) {
      errorDetail = 'Número de ' + digits.length + ' dígitos que não inicia com 55';
    }

    return {
      raw: trimmed,
      normalized: '+' + digits,
      isValid: false,
      error: errorDetail,
      reason: errorDetail,
      lineNumber,
    };
  }

  // Validação do DDD oficial da Anatel
  if (!VALID_BRAZILIAN_DDDS.has(ddd)) {
    const errorDetail = 'DDD brasileiro inválido ou inexistente (' + ddd + ')';
    return {
      raw: trimmed,
      normalized: finalNumber,
      isValid: false,
      error: errorDetail,
      reason: errorDetail,
      ddd,
      lineNumber,
    };
  }

  return {
    raw: trimmed,
    normalized: finalNumber,
    isValid: true,
    type: phoneType,
    ddd,
    lineNumber,
  };
}

/**
 * Processa texto colado em massa contendo um número por linha
 */
export function parseBulkPhoneText(text: string): BulkPhoneParseResult {
  if (!text) {
    return {
      totalLines: 0,
      emptyLines: 0,
      validList: [],
      duplicatesInText: [],
      invalidList: [],
    };
  }

  const lines = text.split(/\r?\n/);
  const seenNormalized = new Set<string>();

  const validList: NormalizedPhoneResult[] = [];
  const duplicatesInText: NormalizedPhoneResult[] = [];
  const invalidList: InvalidPhoneResult[] = [];
  let emptyLines = 0;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const lineNumber = idx + 1;
    const trimmed = line.trim();
    if (!trimmed) {
      emptyLines++;
      continue;
    }

    const res = normalizeBrazilianPhone(trimmed, lineNumber);

    if (!res.isValid) {
      invalidList.push({
        raw: trimmed,
        normalized: res.normalized,
        isValid: false,
        error: res.error || 'Número inválido',
        reason: res.reason || res.error || 'Número inválido',
        lineNumber,
      });
    } else {
      const validItem: NormalizedPhoneResult = {
        raw: trimmed,
        normalized: res.normalized,
        isValid: true,
        type: res.type ?? 'mobile',
        ddd: res.ddd,
        lineNumber,
      };

      if (seenNormalized.has(res.normalized)) {
        duplicatesInText.push(validItem);
      } else {
        seenNormalized.add(res.normalized);
        validList.push(validItem);
      }
    }
  }

  return {
    totalLines: lines.length,
    emptyLines,
    validList,
    duplicatesInText,
    invalidList,
  };
}
