import { describe, it, expect } from 'vitest';
import {
  parseInstagramUsername,
  buildInstagramProfileUrl,
  extractInstagramIdentifier,
} from './parser';

describe('Instagram Parser & Normalizer', () => {
  it('parses plain username', () => {
    expect(parseInstagramUsername('joaosilva')).toBe('joaosilva');
    expect(parseInstagramUsername('  JoaoSilva  ')).toBe('joaosilva');
  });

  it('parses @username', () => {
    expect(parseInstagramUsername('@joaosilva')).toBe('joaosilva');
    expect(parseInstagramUsername(' @Joao_Silva.123 ')).toBe('joao_silva.123');
  });

  it('parses URLs with or without https/www', () => {
    expect(parseInstagramUsername('instagram.com/joaosilva')).toBe('joaosilva');
    expect(parseInstagramUsername('www.instagram.com/joaosilva')).toBe('joaosilva');
    expect(parseInstagramUsername('https://instagram.com/joaosilva')).toBe('joaosilva');
    expect(parseInstagramUsername('https://www.instagram.com/joaosilva/')).toBe('joaosilva');
  });

  it('strips query parameters, tracking and fragments', () => {
    expect(
      parseInstagramUsername('https://www.instagram.com/joaosilva/?igsh=MWQ1ZGUxMzBkMA==')
    ).toBe('joaosilva');
    expect(
      parseInstagramUsername('https://instagram.com/joaosilva?utm_source=ig_web_copy_link#header')
    ).toBe('joaosilva');
  });

  it('rejects invalid or reserved paths', () => {
    expect(parseInstagramUsername('')).toBeNull();
    expect(parseInstagramUsername('https://facebook.com/joaosilva')).toBeNull();
    expect(parseInstagramUsername('https://instagram.com/p/C123456/')).toBeNull();
    expect(parseInstagramUsername('https://instagram.com/reel/C123456/')).toBeNull();
    expect(parseInstagramUsername('https://instagram.com/explore/tags/marketing/')).toBeNull();
    expect(parseInstagramUsername('https://instagram.com/accounts/login')).toBeNull();
    expect(parseInstagramUsername('user..name')).toBeNull(); // consecutive periods not allowed
    expect(parseInstagramUsername('.username')).toBeNull(); // starting with period not allowed
    expect(parseInstagramUsername('a'.repeat(31))).toBeNull(); // max 30 chars
  });

  it('builds canonical profile URL', () => {
    expect(buildInstagramProfileUrl('joaosilva')).toBe('https://www.instagram.com/joaosilva/');
    expect(buildInstagramProfileUrl('@joaosilva')).toBe('https://www.instagram.com/joaosilva/');
  });
});

describe('Conversational Instagram Identifier Detection', () => {
  it('extracts from "meu insta é @joaosilva"', () => {
    const res = extractInstagramIdentifier('meu insta é @joaosilva');
    expect(res.detected).toBe(true);
    expect(res.username).toBe('joaosilva');
    expect(res.profileUrl).toBe('https://www.instagram.com/joaosilva/');
  });

  it('extracts from standalone handle "@joaosilva"', () => {
    const res = extractInstagramIdentifier('@joaosilva');
    expect(res.detected).toBe(true);
    expect(res.username).toBe('joaosilva');
  });

  it('extracts from full link in message', () => {
    const res = extractInstagramIdentifier(
      'esse é meu perfil: https://instagram.com/joaosilva/?igsh=123 me segue lá'
    );
    expect(res.detected).toBe(true);
    expect(res.username).toBe('joaosilva');
  });

  it('detects multiple profiles and flags ambiguity', () => {
    const res = extractInstagramIdentifier('pode ser no @perfil1 ou no @perfil2');
    expect(res.detected).toBe(true);
    expect(res.multipleDetected).toBe(true);
    expect(res.candidates).toEqual(['perfil1', 'perfil2']);
  });

  it('returns detected=false for message without instagram', () => {
    const res = extractInstagramIdentifier('olá, tudo bem? quero saber o valor do produto');
    expect(res.detected).toBe(false);
    expect(res.username).toBeNull();
  });
});
