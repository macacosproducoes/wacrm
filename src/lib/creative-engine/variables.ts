/**
 * Creative Engine - Variable Resolution & Formatters
 *
 * Securely resolves dot-notation variables and applies deterministic formatters
 * without mutating source business data or allowing prototype pollution.
 */

export type FormatterFn = (value: unknown, arg?: string) => string;

/**
 * Built-in deterministic formatters
 */
export const BUILT_IN_FORMATTERS: Record<string, FormatterFn> = {
  number: (val) => {
    if (val === null || val === undefined || val === '') return '';
    const num = Number(val);
    if (isNaN(num)) return String(val);
    return new Intl.NumberFormat('pt-BR').format(num);
  },

  quantity: (val) => {
    if (val === null || val === undefined || val === '') return '0';
    const num = Math.round(Number(val));
    if (isNaN(num)) return String(val);
    return new Intl.NumberFormat('pt-BR').format(num);
  },

  currency: (val, arg) => {
    if (val === null || val === undefined || val === '') return '';
    const num = Number(val);
    if (isNaN(num)) return String(val);
    const currencyCode = arg || 'BRL';
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: currencyCode,
    }).format(num);
  },

  date: (val) => {
    if (!val) return '';
    const d = new Date(String(val));
    if (isNaN(d.getTime())) return String(val);
    return d.toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: 'America/Sao_Paulo',
    });
  },

  time: (val) => {
    if (!val) return '';
    const d = new Date(String(val));
    if (isNaN(d.getTime())) return String(val);
    return d.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Sao_Paulo',
    });
  },

  datetime: (val) => {
    if (!val) return '';
    const d = new Date(String(val));
    if (isNaN(d.getTime())) return String(val);
    const dateStr = d.toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: 'America/Sao_Paulo',
    });
    const timeStr = d.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Sao_Paulo',
    });
    return `${dateStr} ${timeStr}`;
  },

  uppercase: (val) => {
    if (val === null || val === undefined) return '';
    return String(val).toUpperCase();
  },

  lowercase: (val) => {
    if (val === null || val === undefined) return '';
    return String(val).toLowerCase();
  },

  capitalize: (val) => {
    if (val === null || val === undefined) return '';
    return String(val)
      .toLowerCase()
      .replace(/(?:^|\s|\/|-)\S/g, (char) => char.toUpperCase());
  },

  trim: (val) => {
    if (val === null || val === undefined) return '';
    return String(val).trim();
  },

  default: (val, fallback = '') => {
    if (val === null || val === undefined || val === '') {
      return fallback;
    }
    return String(val);
  },
};

/**
 * Safely extracts a value from a nested object using dot-notation.
 * Prevents prototype poisoning by rejecting sensitive keys.
 */
export function getNestedValue(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== 'object' || !path) return undefined;

  const parts = path.trim().split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }

    // Security check: block prototype pollution
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') {
      return undefined;
    }

    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Parses variable expression like "customer.name | capitalize | default('N/A')"
 */
export interface ParsedVariableExpr {
  path: string;
  filters: Array<{ name: string; arg?: string }>;
}

export function parseVariableExpr(rawExpr: string): ParsedVariableExpr {
  const parts = rawExpr.split('|').map((p) => p.trim());
  const path = parts[0] || '';
  const filters: Array<{ name: string; arg?: string }> = [];

  for (let i = 1; i < parts.length; i++) {
    const filterToken = parts[i];
    const match = filterToken.match(/^([a-zA-Z0-9_-]+)(?:\((.*)\))?$/);
    if (match) {
      const name = match[1].toLowerCase();
      let arg = match[2] ? match[2].trim() : undefined;
      // Strip outer quotes if present
      if (arg && ((arg.startsWith("'") && arg.endsWith("'")) || (arg.startsWith('"') && arg.endsWith('"')))) {
        arg = arg.slice(1, -1);
      }
      filters.push({ name, arg });
    }
  }

  return { path, filters };
}

/**
 * Evaluates a parsed variable against context and formatters.
 */
export function evaluateVariable(
  rawExpr: string,
  context: Record<string, unknown>,
  customFormatters?: Record<string, FormatterFn>
): unknown {
  const { path, filters } = parseVariableExpr(rawExpr);
  let value = getNestedValue(context, path);

  // If path is not found directly as nested, check top-level flat key
  if (value === undefined && rawExpr in context) {
    value = context[rawExpr];
  }

  if (filters.length === 0) {
    return value;
  }

  const formatters = { ...BUILT_IN_FORMATTERS, ...customFormatters };
  let currentStr: unknown = value;

  for (const filter of filters) {
    const fn = formatters[filter.name];
    if (fn) {
      currentStr = fn(currentStr, filter.arg);
    }
  }

  return currentStr;
}

/**
 * Resolves all {{variable | filter}} occurrences in a text template.
 *
 * Example:
 * resolveTextTemplate("Olá {{customer.name | capitalize}}! Seu pedido é {{order.id}}.", { customer: { name: "joão" }, order: { id: "123" } })
 * -> "Olá João! Seu pedido é 123."
 */
export function resolveTextTemplate(
  template: string,
  context: Record<string, unknown>,
  customFormatters?: Record<string, FormatterFn>
): string {
  if (!template || typeof template !== 'string') return '';

  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, expr) => {
    const evaluated = evaluateVariable(expr, context, customFormatters);
    if (evaluated === null || evaluated === undefined) return '';
    return String(evaluated);
  });
}
