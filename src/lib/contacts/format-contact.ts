/**
 * Contact Display Name Formatter
 *
 * Ensures contact names and phone numbers are displayed cleanly and authentically,
 * without raw DB identifiers or artificial "Contato..." prefixes.
 */

export function formatContactDisplayName(
  name?: string | null,
  phone?: string | null
): string {
  const cleanName = (name || '').trim();

  // If there is an actual alphabetical name, use it directly (e.g. "Larissa - Engajamento Real")
  if (
    cleanName &&
    /[a-zA-ZÀ-ÿ]/.test(cleanName) &&
    !cleanName.startsWith('Contato ') &&
    !cleanName.startsWith('Cliente ') &&
    !/^cliente\s*\d*$/i.test(cleanName)
  ) {
    return cleanName;
  }

  // Format phone number
  const rawNumber = cleanName.startsWith('Contato ')
    ? cleanName.replace(/^Contato\s+/, '')
    : cleanName.startsWith('Cliente ') || /^cliente\s*\d*$/i.test(cleanName)
    ? (phone || cleanName.replace(/^Cliente\s+/i, ''))
    : cleanName || phone || '';

  const digits = rawNumber.replace(/\D/g, '');
  if (!digits) {
    return phone || cleanName || '';
  }

  // Brazilian mobile phone: 55 + 2-digit DDD + 9 digits (e.g. 5511971121710)
  if (digits.length === 13 && digits.startsWith('55')) {
    const ddd = digits.slice(2, 4);
    const part1 = digits.slice(4, 9);
    const part2 = digits.slice(9);
    return `+55 (${ddd}) ${part1}-${part2}`;
  }

  // Brazilian landline: 55 + 2-digit DDD + 8 digits (e.g. 551145306671)
  if (digits.length === 12 && digits.startsWith('55')) {
    const ddd = digits.slice(2, 4);
    const part1 = digits.slice(4, 8);
    const part2 = digits.slice(8);
    return `+55 (${ddd}) ${part1}-${part2}`;
  }

  // Local BR mobile without country code: 2-digit DDD + 9 digits (11971121710)
  if (digits.length === 11) {
    const ddd = digits.slice(0, 2);
    const part1 = digits.slice(2, 7);
    const part2 = digits.slice(7);
    return `+55 (${ddd}) ${part1}-${part2}`;
  }


  // Local BR landline: 2-digit DDD + 8 digits (1145306671)
  if (digits.length === 10) {
    const ddd = digits.slice(0, 2);
    const part1 = digits.slice(2, 6);
    const part2 = digits.slice(6);
    return `(${ddd}) ${part1}-${part2}`;
  }

  // Default international format
  return digits.startsWith('+') ? digits : `+${digits}`;
}
