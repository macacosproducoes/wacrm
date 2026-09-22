/**
 * Sanitize phone number for Meta WhatsApp API.
 * Meta requires digits only — no + prefix, no spaces, no dashes.
 * e.g. "+370 63949836" → "37063949836"
 */
export function sanitizePhoneForMeta(phone: string): string {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

/**
 * Normalize phone number by removing all non-digit characters.
 * Used for comparing phone numbers in different formats.
 */
export function normalizePhone(phone: string): string {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

/**
 * Compare two phone numbers accounting for trunk prefix differences.
 * e.g. "370063949836" (with trunk 0) matches "37063949836" (without trunk 0)
 * by comparing the last 8 digits.
 */
export function phonesMatch(phone1: string, phone2: string): boolean {
  const n1 = normalizePhone(phone1)
  const n2 = normalizePhone(phone2)
  if (n1 === n2) return true
  if (n1.length >= 8 && n2.length >= 8) {
    return n1.slice(-8) === n2.slice(-8)
  }
  return false
}

/**
 * Validate phone number is E.164-like format (7-15 digits starting with non-zero).
 * Accepts with or without + prefix.
 */
export function isValidE164(phone: string): boolean {
  return /^\+?[1-9]\d{6,14}$/.test(phone)
}

/**
 * Generate plausible phone number variants for retry when Meta's
 * sandbox rejects a number with error #131030 ("not in allowed list").
 *
 * Many countries use a "trunk prefix" 0 for domestic dialing that is
 * meant to be dropped in international format (e.g. Lithuanian
 * "+370 063 949 836" domestically → "+370 63 949 836" international).
 * But some sandboxes register the number with the trunk 0 included,
 * causing sends to the correct international format to fail.
 *
 * This helper yields up to 3 variants:
 *   1. The original sanitized number (first attempt)
 *   2. With a trunk 0 inserted after the country code
 *   3. With a trunk 0 removed after the country code
 *
 * Country-code lengths of 1, 2, and 3 digits are tried because we
 * don't know the user's country ahead of time.
 *
 * @param sanitized - digits-only phone number (from sanitizePhoneForMeta)
 * @returns deduplicated list of variants, original first
 */
export function phoneVariants(sanitized: string): string[] {
  if (!sanitized) return []
  const seen = new Set<string>()
  const push = (v: string) => {
    if (v && !seen.has(v)) seen.add(v)
  }

  // 1. Original
  push(sanitized)

  // 2. Insert a 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen) continue
    const cc = sanitized.slice(0, ccLen)
    const rest = sanitized.slice(ccLen)
    if (!rest.startsWith('0')) {
      push(cc + '0' + rest)
    }
  }

  // 3. Remove a leading 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen + 1) continue
    const cc = sanitized.slice(0, ccLen)
    const rest = sanitized.slice(ccLen)
    if (rest.startsWith('0')) {
      push(cc + rest.slice(1))
    }
  }

  return [...seen]
}

/**
 * Returns true when the Meta API error indicates the recipient
 * phone number isn't in the allowed list (sandbox restriction).
 * Detected via error code 131030 or the standard error text.
 */
export function isRecipientNotAllowedError(message: string): boolean {
  return /131030|not in allowed list|not in the allowed list/i.test(message)
}

const VALID_ITU_COUNTRY_CODES = [
  '1', '7', '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47', '48', '49',
  '51', '52', '53', '54', '55', '56', '57', '58', '60', '61', '62', '63', '64', '65', '66', '81', '82', '84', '86', '90', '91', '92', '93', '94', '95', '98',
  '351', '352', '353', '354', '355', '356', '357', '358', '359', '370', '371', '372', '373', '374', '375', '376', '377', '378', '380', '381', '382', '385', '386', '387', '389',
  '591', '592', '593', '594', '595', '596', '597', '598'
];

/**
 * Strict validator for real WhatsApp 1-to-1 contacts.
 * Rejects WhatsApp groups (@g.us), status broadcasts (@broadcast),
 * newsletters/channels (@newsletter), and device LIDs (@lid).
 * Validates real Brazilian phone numbers (55 + DDD + 8/9 digits) and
 * genuine international E.164 ITU-T country codes.
 * Rejects synthetic 64-bit integer device hashes (LIDs).
 */
export function isRealWhatsAppContact(jidOrPhone: string): boolean {
  if (!jidOrPhone) return false;
  const str = String(jidOrPhone).toLowerCase().trim();
  if (
    str.includes('@g.us') ||
    str.includes('@lid') ||
    str.includes('@broadcast') ||
    str.includes('@newsletter') ||
    str.includes('status@broadcast')
  ) {
    return false;
  }
  if (str.includes('@')) {
    const domain = str.split('@')[1];
    if (domain && domain !== 's.whatsapp.net') return false;
  }

  let clean = str.replace(/\D/g, '');
  if (clean.length < 9 || clean.length > 15) return false;
  if (clean.startsWith('120363')) return false;

  // Normalize Brazilian phone numbers without 55 prefix (e.g. 11988887777 or 21977776666)
  if ((clean.length === 10 || clean.length === 11) && !clean.startsWith('55')) {
    const localDdd = parseInt(clean.slice(0, 2), 10);
    if (!isNaN(localDdd) && localDdd >= 11 && localDdd <= 99) {
      clean = `55${clean}`;
    }
  }

  // Brazilian phone number validation
  if (clean.startsWith('55')) {
    if (clean.length < 12 || clean.length > 13) return false;
    const ddd = parseInt(clean.slice(2, 4), 10);
    if (isNaN(ddd) || ddd < 11 || ddd > 99) return false;
    const invalidDdds = [20, 23, 25, 26, 29, 30, 36, 39, 50, 52, 56, 57, 58, 59, 70, 72, 76, 78, 80, 90];
    if (invalidDdds.includes(ddd)) return false;
    return true;
  }

  // Genuine international ITU-T phone validation
  const hasValidCountry = VALID_ITU_COUNTRY_CODES.some((cc) => {
    if (clean.startsWith(cc)) {
      const restLen = clean.length - cc.length;
      return restLen >= 7 && restLen <= 11;
    }
    return false;
  });

  return hasValidCountry;
}
