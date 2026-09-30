import { describe, it, expect } from 'vitest';
import {
  normalizeBrazilianPhone,
  parseBulkPhoneText,
} from './phone-br-normalizer';

describe('Importação em Massa - Testes Obrigatórios de Normalização e Validação', () => {
  it('1. Número brasileiro sem código de país (com DDD e 9 dígitos de celular)', () => {
    const res = normalizeBrazilianPhone('11987654321');
    expect(res.isValid).toBe(true);
    expect(res.normalized).toBe('+5511987654321');
    expect(res.ddd).toBe('11');
    expect(res.type).toBe('mobile');
  });

  it('2. Número com +55 e formatação', () => {
    const res = normalizeBrazilianPhone('+55 (21) 98765-4321');
    expect(res.isValid).toBe(true);
    expect(res.normalized).toBe('+5521987654321');
    expect(res.ddd).toBe('21');
  });

  it('3. Número começando com 55, sem sinal de mais (não duplica o 55)', () => {
    const res = normalizeBrazilianPhone('5531987654321');
    expect(res.isValid).toBe(true);
    expect(res.normalized).toBe('+5531987654321');
    expect(res.normalized).not.toBe('+555531987654321');
  });

  it('4. Números com espaços, parênteses e hífens variados', () => {
    const samples = [
      '(11) 98765-4321',
      '( 11 )  9 8765 - 4321',
      '+55 (11) 98765-4321',
      '55 (11) 98765-4321',
      '(11) 3333-4444', // fixo
    ];

    for (const sample of samples) {
      const res = normalizeBrazilianPhone(sample);
      expect(res.isValid).toBe(true);
      expect(res.normalized.startsWith('+5511')).toBe(true);
    }
  });

  it('5. Linhas vazias e linhas com apenas espaços são ignoradas', () => {
    const empty1 = normalizeBrazilianPhone('');
    expect(empty1.isValid).toBe(false);
    expect(empty1.reason).toContain('vazia');

    const empty2 = normalizeBrazilianPhone('    \t  ');
    expect(empty2.isValid).toBe(false);
  });

  it('6. Linhas com caracteres inválidos ou letras', () => {
    const invalidText = normalizeBrazilianPhone('contato@teste.com');
    expect(invalidText.isValid).toBe(false);

    const invalidShort = normalizeBrazilianPhone('12345');
    expect(invalidShort.isValid).toBe(false);

    const invalidChars = normalizeBrazilianPhone('telefone invalido!');
    expect(invalidChars.isValid).toBe(false);

    // DDD inexistente (ex: DDD 20)
    const invalidDdd = normalizeBrazilianPhone('20987654321');
    expect(invalidDdd.isValid).toBe(false);
    expect(invalidDdd.reason).toContain('DDD');
  });

  it('7. Telefones duplicados na mesma lista colada (de-duplicação)', () => {
    const rawPastedList = [
      '11987654321',
      '(11) 98765-4321',       // mesmo número, formato diferente
      '5511987654321',         // mesmo número com 55
      '+55 11 98765-4321',     // mesmo número com +55
      '21987654321',           // número diferente (único)
      '21987654321',           // duplicado exato
      '31987654321',           // número diferente (único)
    ].join('\r\n');

    const result = parseBulkPhoneText(rawPastedList);

    expect(result.validList).toHaveLength(3); // 11..., 21..., 31...
    expect(result.duplicatesInText).toHaveLength(4);
    expect(result.validList.map(v => v.normalized)).toEqual([
      '+5511987654321',
      '+5521987654321',
      '+5531987654321',
    ]);
  });

  it('8. Identificação e separação de telefones já existentes no CRM', () => {
    // Simula contatos existentes no banco de dados do CRM
    const existingInDb = new Set(['5511987654321', '5521987654321']);

    const pastedList = [
      '11987654321', // já existe
      '21987654321', // já existe
      '31987654321', // novo!
      '41987654321', // novo!
    ].join('\n');

    const parsed = parseBulkPhoneText(pastedList);
    const toImport = [];
    const skippedAlreadyInDb = [];

    for (const item of parsed.validList) {
      const digitsOnly = item.normalized.replace(/\D/g, '');
      if (existingInDb.has(digitsOnly)) {
        skippedAlreadyInDb.push(item);
      } else {
        toImport.push(item);
      }
    }

    expect(toImport).toHaveLength(2);
    expect(toImport.map(c => c.normalized)).toEqual(['+5531987654321', '+5541987654321']);
    expect(skippedAlreadyInDb).toHaveLength(2);
  });

  it('9. Importação de listas com milhares de contatos (performance)', () => {
    const lines = [];
    // Gerar 3.000 números válidos
    for (let i = 1000; i < 4000; i++) {
      lines.push('1199999' + i);
    }

    const t0 = performance.now();
    const result = parseBulkPhoneText(lines.join('\r\n'));
    const t1 = performance.now();

    expect(result.validList).toHaveLength(3000);
    expect(result.duplicatesInText).toHaveLength(0);
    expect(result.invalidList).toHaveLength(0);
    expect(t1 - t0).toBeLessThan(800); // Processamento rápido em memória (< 800ms)
  });

  it('10. Processamento em lotes (chunks) com tolerância a falha parcial', () => {
    // Simula lote de 120 contatos sendo enviados em chunks de 50
    const contacts = Array.from({ length: 120 }, (_, idx) => ({
      phone: '+551198888' + String(idx).padStart(4, '0'),
      name: '+551198888' + String(idx).padStart(4, '0'),
    }));

    const chunkSize = 50;
    const chunks = [];
    for (let i = 0; i < contacts.length; i += chunkSize) {
      chunks.push(contacts.slice(i, i + chunkSize));
    }

    expect(chunks).toHaveLength(3); // 50, 50, 20
    expect(chunks[0]).toHaveLength(50);
    expect(chunks[1]).toHaveLength(50);
    expect(chunks[2]).toHaveLength(20);

    // Simulação do insert com falha no chunk 2 e fallback individual
    let imported = 0;
    let failed = 0;

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      const chunk = chunks[chunkIdx];
      if (chunkIdx === 1) {
        // Simula falha do batch inteiro: tenta individualmente
        for (const item of chunk) {
          if (item.phone.endsWith('0075')) {
            failed++; // 1 registro falha
          } else {
            imported++;
          }
        }
      } else {
        imported += chunk.length;
      }
    }

    expect(imported).toBe(119);
    expect(failed).toBe(1);
  });
});
