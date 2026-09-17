import { describe, it, expect } from 'vitest';
import { parseFollowerOrder } from './follower-order-handler';

describe('Follower Order Parser', () => {
  it('parses real user test message: "Sou @cristiano, quero 5.000 seguidores"', () => {
    const result = parseFollowerOrder('Sou @cristiano, quero 5.000 seguidores');
    expect(result.isFollowerOrder).toBe(true);
    expect(result.username).toBe('cristiano');
    expect(result.quantity).toBe(5000);
    expect(result.quantityFormatted).toBe('5.000');
  });

  it('parses without dot: "Sou @cristiano, quero 5000 seguidores"', () => {
    const result = parseFollowerOrder('Sou @cristiano, quero 5000 seguidores');
    expect(result.isFollowerOrder).toBe(true);
    expect(result.username).toBe('cristiano');
    expect(result.quantity).toBe(5000);
    expect(result.quantityFormatted).toBe('5.000');
  });

  it('parses with "k": "quero 10k seguidores para @nike"', () => {
    const result = parseFollowerOrder('quero 10k seguidores para @nike');
    expect(result.isFollowerOrder).toBe(true);
    expect(result.username).toBe('nike');
    expect(result.quantity).toBe(10000);
  });

  it('parses with "mil": "manda 5 mil seguidores pro @cristiano"', () => {
    const result = parseFollowerOrder('manda 5 mil seguidores pro @cristiano');
    expect(result.isFollowerOrder).toBe(true);
    expect(result.username).toBe('cristiano');
    expect(result.quantity).toBe(5000);
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
