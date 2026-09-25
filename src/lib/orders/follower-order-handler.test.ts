import { describe, it, expect } from 'vitest';
import { parseFollowerOrder } from './follower-order-handler';

describe('Follower Order Parser', () => {
  it('parses primary user test message without @: "Sou o cristiano quero 5.000 seguidores"', () => {
    const result = parseFollowerOrder('Sou o cristiano quero 5.000 seguidores');
    expect(result.isFollowerOrder).toBe(true);
    expect(result.username).toBe('cristiano');
    expect(result.quantity).toBe(5000);
    expect(result.quantityFormatted).toBe('5.000');
  });

  it('parses user message with @: "Sou @cristiano quero 5.000 seguidores"', () => {
    const result = parseFollowerOrder('Sou @cristiano quero 5.000 seguidores');
    expect(result.isFollowerOrder).toBe(true);
    expect(result.username).toBe('cristiano');
    expect(result.quantity).toBe(5000);
    expect(result.quantityFormatted).toBe('5.000');
  });

  it('parses "Meu nome é cristiano, quero 5000 seguidores"', () => {
    const result = parseFollowerOrder('Meu nome é cristiano, quero 5000 seguidores');
    expect(result.isFollowerOrder).toBe(true);
    expect(result.username).toBe('cristiano');
    expect(result.quantity).toBe(5000);
    expect(result.quantityFormatted).toBe('5.000');
  });

  it('parses "Quero 5 mil seguidores para o @cristiano"', () => {
    const result = parseFollowerOrder('Quero 5 mil seguidores para o @cristiano');
    expect(result.isFollowerOrder).toBe(true);
    expect(result.username).toBe('cristiano');
    expect(result.quantity).toBe(5000);
    expect(result.quantityFormatted).toBe('5.000');
  });

  it('parses "Quero 5.000 seguidores para o cristiano" (without @)', () => {
    const result = parseFollowerOrder('Quero 5.000 seguidores para o cristiano');
    expect(result.isFollowerOrder).toBe(true);
    expect(result.username).toBe('cristiano');
    expect(result.quantity).toBe(5000);
    expect(result.quantityFormatted).toBe('5.000');
  });

  it('parses "manda 5k seguidores pro cristiano"', () => {
    const result = parseFollowerOrder('manda 5k seguidores pro cristiano');
    expect(result.isFollowerOrder).toBe(true);
    expect(result.username).toBe('cristiano');
    expect(result.quantity).toBe(5000);
  });

  it('parses "manda 5MIL seguidores pro cristiano"', () => {
    const result = parseFollowerOrder('manda 5MIL seguidores pro cristiano');
    expect(result.isFollowerOrder).toBe(true);
    expect(result.username).toBe('cristiano');
    expect(result.quantity).toBe(5000);
  });

  it('parses "Quero 5 k seguidores para o cristiano"', () => {
    const result = parseFollowerOrder('Quero 5 k seguidores para o cristiano');
    expect(result.isFollowerOrder).toBe(true);
    expect(result.username).toBe('cristiano');
    expect(result.quantity).toBe(5000);
  });

  it('prioritizes explicit @mention over conversational intro', () => {
    const result = parseFollowerOrder('Sou o joao quero 5.000 seguidores para @cristiano');
    expect(result.isFollowerOrder).toBe(true);
    expect(result.username).toBe('cristiano');
    expect(result.quantity).toBe(5000);
  });

  it('parses query with payment mention: "Meu nome é @cristiano meu instagram e eu quero 5000 seguidores no pix"', () => {
    const result = parseFollowerOrder('Meu nome é @cristiano meu instagram e eu quero 5000 seguidores no pix');
    expect(result.isFollowerOrder).toBe(true);
    expect(result.username).toBe('cristiano');
    expect(result.quantity).toBe(5000);
    expect(result.quantityFormatted).toBe('5.000');
  });

  it('strictly rejects stopwords as instagram handles (pix, cartao, boleto, contato, whatsapp)', () => {
    expect(parseFollowerOrder('quero 5000 seguidores no pix').isFollowerOrder).toBe(false);
    expect(parseFollowerOrder('quero 5000 seguidores no cartao').isFollowerOrder).toBe(false);
    expect(parseFollowerOrder('quero 5000 seguidores no boleto').isFollowerOrder).toBe(false);
    expect(parseFollowerOrder('quero 5000 seguidores no whatsapp').isFollowerOrder).toBe(false);
    expect(parseFollowerOrder('quero 5000 seguidores pelo contato').isFollowerOrder).toBe(false);
  });

  it('ignores messages without follower intent', () => {
    const result = parseFollowerOrder('Olá, meu insta é @cristiano');
    expect(result.isFollowerOrder).toBe(false);
  });

  it('ignores messages without handle', () => {
    const result = parseFollowerOrder('quero 5000 seguidores');
    expect(result.isFollowerOrder).toBe(false);
  });

  it('parses high-quantity requests: 30.000, 50.000, and 100.000 followers', () => {
    const res30k = parseFollowerOrder('Quero 30.000 seguidores para o @cristiano');
    expect(res30k.isFollowerOrder).toBe(true);
    expect(res30k.quantity).toBe(30000);
    expect(res30k.quantityFormatted).toBe('30.000');

    const res50k = parseFollowerOrder('Quero 50 mil seguidores pro @cristiano');
    expect(res50k.isFollowerOrder).toBe(true);
    expect(res50k.quantity).toBe(50000);

    const res100k = parseFollowerOrder('manda 100k seguidores para @cristiano');
    expect(res100k.isFollowerOrder).toBe(true);
    expect(res100k.quantity).toBe(100000);
  });

  it('parses verified badge requests (selo verificado / verificado)', () => {
    const resVerif1 = parseFollowerOrder('Quero o verificado no @cristiano');
    expect(resVerif1.isFollowerOrder).toBe(true);
    expect(resVerif1.username).toBe('cristiano');
    expect(resVerif1.isVerified).toBe(true);
    expect(resVerif1.quantityFormatted).toBe('Selo Verificado');

    const resVerif2 = parseFollowerOrder('Quero selo verificado para o @cristiano');
    expect(resVerif2.isFollowerOrder).toBe(true);
    expect(resVerif2.isVerified).toBe(true);

    const resVerif3 = parseFollowerOrder('selo azul no @cristiano');
    expect(resVerif3.isFollowerOrder).toBe(true);
    expect(resVerif3.isVerified).toBe(true);
  });
});

