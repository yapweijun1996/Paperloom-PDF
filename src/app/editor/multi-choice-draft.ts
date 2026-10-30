/** A tagged string preserves the existing protected recovery format. */
const PREFIX = '\u0000paperloom-multi-choice:';

export function encodeMultiChoiceDraft(values: string[]): string {
  return PREFIX + JSON.stringify(values);
}

export function decodeMultiChoiceDraft(value: string): string[] {
  if (!value.startsWith(PREFIX)) throw new Error('The multiple-choice draft is invalid. Recovery has been preserved.');
  let parsed: unknown;
  try { parsed = JSON.parse(value.slice(PREFIX.length)); } catch { throw new Error('The multiple-choice draft is invalid. Recovery has been preserved.'); }
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string') || new Set(parsed).size !== parsed.length) {
    throw new Error('The multiple-choice draft is invalid. Recovery has been preserved.');
  }
  return parsed;
}
