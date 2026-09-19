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
});
