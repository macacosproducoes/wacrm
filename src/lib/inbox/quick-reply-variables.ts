/**
 * Variable substitution engine for Quick Replies (ZapPlus style).
 * Replaces placeholders like {nome}, {primeiro_nome}, {saudacao}, {telefone}
 * with context from the contact and current time.
 */

export interface VariableContext {
  name?: string | null;
  phone?: string | null;
  company?: string | null;
  agentName?: string | null;
  date?: Date;
}

/**
 * Returns dynamic greeting based on current local hour:
 * - 05:00 - 11:59: "Bom dia"
 * - 12:00 - 17:59: "Boa tarde"
 * - 18:00 - 04:59: "Boa noite"
 */
export function getDynamicGreeting(date: Date = new Date()): string {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) {
    return 'Bom dia';
  }
  if (hour >= 12 && hour < 18) {
    return 'Boa tarde';
  }
  return 'Boa noite';
}

/**
 * Extracts first name from full name or phone.
 * e.g. "Maju Brook" -> "Maju"
 * e.g. "+5511999999999" -> "+5511999999999"
 */
export function getFirstName(fullName?: string | null): string {
  if (!fullName) return '';
  const trimmed = fullName.trim();
  const parts = trimmed.split(/\s+/);
  return parts[0] || '';
}

/**
 * Interpolates variables in a template text string.
 * Supports both ZapPlus style {{var}} and standard {var}.
 */
export function replaceQuickReplyVariables(
  template: string,
  context: VariableContext
): string {
  if (!template) return '';

  const fullName = (context.name || '').trim();
  const firstName = getFirstName(fullName);
  const phone = (context.phone || '').trim();
  const company = (context.company || '').trim();
  const agent = (context.agentName || '').trim();
  const greeting = getDynamicGreeting(context.date);

  return template
    // Double braces {{...}}
    .replace(/\{\{\s*(?:nome|NOME|Nome)\s*\}\}/g, fullName || 'cliente')
    .replace(/\{\{\s*(?:primeiro_nome|PRIMEIRO_NOME|Primeiro_Nome|primeironome)\s*\}\}/g, firstName || fullName || 'cliente')
    .replace(/\{\{\s*(?:telefone|TELEFONE|Telefone|phone|PHONE)\s*\}\}/g, phone)
    .replace(/\{\{\s*(?:empresa|EMPRESA|Empresa)\s*\}\}/g, company)
    .replace(/\{\{\s*(?:atendente|ATENDENTE|Atendente|operador|agente)\s*\}\}/g, agent || 'Atendente')
    .replace(/\{\{\s*(?:saudacao|SAUDACAO|Saudacao|saudação|SAUDAÇÃO|Saudação)\s*\}\}/g, greeting)
    // Single braces {...}
    .replace(/\{\s*(?:nome|NOME|Nome)\s*\}/g, fullName || 'cliente')
    .replace(/\{\s*(?:primeiro_nome|PRIMEIRO_NOME|Primeiro_Nome|primeironome)\s*\}/g, firstName || fullName || 'cliente')
    .replace(/\{\s*(?:telefone|TELEFONE|Telefone|phone|PHONE)\s*\}/g, phone)
    .replace(/\{\s*(?:empresa|EMPRESA|Empresa)\s*\}/g, company)
    .replace(/\{\s*(?:atendente|ATENDENTE|Atendente|operador|agente)\s*\}/g, agent || 'Atendente')
    .replace(/\{\s*(?:saudacao|SAUDACAO|Saudacao|saudação|SAUDAÇÃO|Saudação)\s*\}/g, greeting);
}

