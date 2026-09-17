import { describe, expect, it } from 'vitest';
import {
  evaluateVariable,
  resolveTextTemplate,
  getNestedValue,
  parseVariableExpr,
  BUILT_IN_FORMATTERS,
} from './variables';

describe('Creative Engine - Variables & Formatters', () => {
  describe('getNestedValue & Prototype Safety', () => {
    it('safely extracts deeply nested fields', () => {
      const data = {
        order: {
          customer: {
            profile: {
              fullName: 'Maria Silva',
            },
          },
        },
      };
      expect(getNestedValue(data, 'order.customer.profile.fullName')).toBe('Maria Silva');
      expect(getNestedValue(data, 'order.customer.missing')).toBeUndefined();
    });

    it('blocks prototype pollution attempts', () => {
      const data = { safe: 'value' };
      expect(getNestedValue(data, '__proto__.polluted')).toBeUndefined();
      expect(getNestedValue(data, 'constructor.prototype')).toBeUndefined();
      expect(getNestedValue(data, 'prototype.polluted')).toBeUndefined();
    });
  });

  describe('parseVariableExpr', () => {
    it('parses expressions without filters', () => {
      expect(parseVariableExpr('customer.name')).toEqual({
        path: 'customer.name',
        filters: [],
      });
    });

    it('parses expressions with single and multiple filters', () => {
      expect(parseVariableExpr('amount | currency("USD") | trim')).toEqual({
        path: 'amount',
        filters: [
          { name: 'currency', arg: 'USD' },
          { name: 'trim', arg: undefined },
        ],
      });

      const evaluated = evaluateVariable('amount | currency("USD")', { amount: 100 });
      expect(evaluated).toContain('100');
    });
  });

  describe('Formatters', () => {
    it('formats numbers and quantities correctly', () => {
      expect(BUILT_IN_FORMATTERS.number(5000)).toBe('5.000');
      expect(BUILT_IN_FORMATTERS.quantity('12500')).toBe('12.500');
      expect(BUILT_IN_FORMATTERS.quantity(null)).toBe('0');
    });

    it('formats currencies with custom currency codes', () => {
      const brl = BUILT_IN_FORMATTERS.currency(150.5);
      expect(brl).toContain('150,50');
      const usd = BUILT_IN_FORMATTERS.currency(100, 'USD');
      expect(usd).toContain('100');
    });

    it('formats uppercase, lowercase, capitalize, and trim', () => {
      expect(BUILT_IN_FORMATTERS.uppercase('crm multi')).toBe('CRM MULTI');
      expect(BUILT_IN_FORMATTERS.lowercase('CRM MULTI')).toBe('crm multi');
      expect(BUILT_IN_FORMATTERS.capitalize('joão da silva')).toBe('João Da Silva');
      expect(BUILT_IN_FORMATTERS.trim('  hello world  ')).toBe('hello world');
    });

    it('applies default fallback when value is empty', () => {
      expect(BUILT_IN_FORMATTERS.default('', 'Fallback Value')).toBe('Fallback Value');
      expect(BUILT_IN_FORMATTERS.default(null, 'N/A')).toBe('N/A');
      expect(BUILT_IN_FORMATTERS.default('Active', 'N/A')).toBe('Active');
    });
  });

  describe('resolveTextTemplate', () => {
    it('interpolates multiple variables into string templates', () => {
      const context = {
        order: { id: '9876', total: 450 },
        customer: { name: 'ana souza' },
      };
      const tpl = 'Pedido #{{order.id}} para {{customer.name | capitalize}} no valor de {{order.total | currency}}';
      const resolved = resolveTextTemplate(tpl, context);

      expect(resolved).toContain('Pedido #9876 para Ana Souza no valor de');
      expect(resolved).toContain('450,00');
    });

    it('handles missing values gracefully without throwing', () => {
      const context = { existing: 'OK' };
      const tpl = 'Status: {{missing | default("Pendente")}} - {{existing}}';
      expect(resolveTextTemplate(tpl, context)).toBe('Status: Pendente - OK');
    });
  });
});
