import { describe, it, expect } from 'vitest';
import {
  replaceQuickReplyVariables,
  getDynamicGreeting,
  getFirstName,
} from './quick-reply-variables';

describe('quick-reply-variables', () => {
  it('extracts first name properly', () => {
    expect(getFirstName('Maju Brook')).toBe('Maju');
    expect(getFirstName('Carlos')).toBe('Carlos');
    expect(getFirstName('')).toBe('');
    expect(getFirstName(null)).toBe('');
  });

  it('calculates dynamic greetings', () => {
    const morning = new Date(2026, 8, 14, 9, 30);
    const afternoon = new Date(2026, 8, 14, 15, 0);
    const night = new Date(2026, 8, 14, 21, 0);
    const earlyMorning = new Date(2026, 8, 14, 3, 0);

    expect(getDynamicGreeting(morning)).toBe('Bom dia');
    expect(getDynamicGreeting(afternoon)).toBe('Boa tarde');
    expect(getDynamicGreeting(night)).toBe('Boa noite');
    expect(getDynamicGreeting(earlyMorning)).toBe('Boa noite');
  });

  it('replaces variables in template text', () => {
    const template = '{saudacao}, {primeiro_nome}! Seu telefone cadastrado é {telefone}. Obrigado pela mensagem, {nome}!';
    const res = replaceQuickReplyVariables(template, {
      name: 'Maju Brook',
      phone: '+55 11 94530-6671',
      date: new Date(2026, 8, 14, 10, 0),
    });

    expect(res).toBe('Bom dia, Maju! Seu telefone cadastrado é +55 11 94530-6671. Obrigado pela mensagem, Maju Brook!');
  });

  it('falls back gracefully when fields are missing', () => {
    const template = '{saudacao}, {primeiro_nome}!';
    const res = replaceQuickReplyVariables(template, {
      date: new Date(2026, 8, 14, 14, 0),
    });
    expect(res).toBe('Boa tarde, cliente!');
  });

  it('replaces double brace variables (ZapPlus style)', () => {
    const template = 'Olá {{primeiro_nome}}, tudo bem? Aqui é o {{atendente}} da {{empresa}}. Vi que seu número é {{telefone}}.';
    const res = replaceQuickReplyVariables(template, {
      name: 'João da Silva',
      phone: '+55 11 98888-7777',
      company: 'Empresa XPTO',
      agentName: 'Michel Atendente',
      date: new Date(2026, 8, 14, 10, 0),
    });

    expect(res).toBe('Olá João, tudo bem? Aqui é o Michel Atendente da Empresa XPTO. Vi que seu número é +55 11 98888-7777.');
  });

  it('supports custom fallback names and handles empty templates', () => {
    expect(replaceQuickReplyVariables('', {})).toBe('');
    expect(replaceQuickReplyVariables('{nome}', { name: '' })).toBe('cliente');
    expect(replaceQuickReplyVariables('{{atendente}}', {})).toBe('Atendente');
  });
});


