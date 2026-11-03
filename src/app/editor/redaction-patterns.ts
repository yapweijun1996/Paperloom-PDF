/**
 * Search-and-redact presets. Each preset finds candidate text with a pattern
 * and may confirm it (`accept`) before a redaction mark is placed for review.
 */
import type { SearchPattern } from './search-index';

export type RedactionPresetId = 'email' | 'phone' | 'nric' | 'card' | 'custom';

export interface RedactionPreset {
  id: RedactionPresetId;
  label: string;
  pattern: SearchPattern;
  accept?: (text: string) => boolean;
}

const digits = (text: string) => text.replace(/\D/g, '');

/** Luhn checksum used by payment card numbers. */
export function passesLuhn(number: string): boolean {
  let sum = 0;
  for (let i = 0; i < number.length; i++) {
    let digit = Number(number[number.length - 1 - i]);
    if (i % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return number.length > 0 && sum % 10 === 0;
}

export const REDACTION_PRESETS: RedactionPreset[] = [
  { id: 'email', label: 'Email addresses', pattern: { regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, maxLength: 254 } },
  {
    id: 'phone', label: 'Phone numbers',
    pattern: { regex: /(?<![\p{L}\p{N}])\+?\(?\d[\d ().-]{5,18}\d(?![\p{L}\p{N}])/u, maxLength: 24 },
    accept: text => { const count = digits(text).length; return count >= 7 && count <= 15; },
  },
  { id: 'nric', label: 'NRIC / FIN (Singapore)', pattern: { regex: /\b[STFGM]\d{7}[A-Z]\b/, maxLength: 9 } },
  {
    id: 'card', label: 'Card numbers',
    pattern: { regex: /\b\d(?:[ -]?\d){12,18}\b/, maxLength: 23 },
    accept: text => passesLuhn(digits(text)),
  },
];

/** A user pattern, or an error message when it cannot be used. */
export function customPreset(source: string): RedactionPreset | string {
  if (!source.trim()) return 'Enter a pattern.';
  let regex: RegExp;
  try { regex = new RegExp(source, 'u'); } catch { return 'The pattern is not a valid regular expression.'; }
  if (regex.test('')) return 'The pattern must not match empty text.';
  return { id: 'custom', label: 'Custom pattern', pattern: { regex, maxLength: 200 } };
}
