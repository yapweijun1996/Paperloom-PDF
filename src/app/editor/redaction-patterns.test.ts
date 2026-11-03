import { describe, expect, it } from 'vitest';
import { REDACTION_PRESETS, customPreset, passesLuhn } from './redaction-patterns';

const preset = (id: string) => REDACTION_PRESETS.find(item => item.id === id)!;
const find = (id: string, text: string) => {
  const { pattern, accept } = preset(id);
  return [...text.matchAll(new RegExp(pattern.regex.source, 'gu'))].map(match => match[0]).filter(value => !accept || accept(value));
};

describe('redaction presets', () => {
  it('finds email addresses', () => {
    expect(find('email', 'Mail jane.doe+hr@example.com.sg or bob@x.io today')).toEqual(['jane.doe+hr@example.com.sg', 'bob@x.io']);
  });

  it('finds phone numbers with 7 to 15 digits and ignores short numbers', () => {
    expect(find('phone', 'Call +65 6123 4567 or (02) 9876-5432; room 12-34')).toEqual(['+65 6123 4567', '(02) 9876-5432']);
    expect(find('phone', 'NRIC S1234567D, order A12345678')).toEqual([]);
  });

  it('finds Singapore NRIC and FIN numbers', () => {
    expect(find('nric', 'IDs S1234567D, G7654321X and A1234567B')).toEqual(['S1234567D', 'G7654321X']);
  });

  it('keeps only card numbers that pass the Luhn check', () => {
    expect(passesLuhn('4111111111111111')).toBe(true);
    expect(find('card', 'Visa 4111 1111 1111 1111, ref 4111 1111 1111 1112')).toEqual(['4111 1111 1111 1111']);
  });

  it('validates custom patterns', () => {
    expect(customPreset('')).toBe('Enter a pattern.');
    expect(customPreset('(')).toMatch(/not a valid/);
    expect(customPreset('x*')).toMatch(/empty text/);
    const custom = customPreset('INV-\\d+');
    expect(typeof custom).toBe('object');
  });
});
