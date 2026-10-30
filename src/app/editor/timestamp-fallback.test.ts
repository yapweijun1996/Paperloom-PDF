import { describe, expect, it } from 'vitest';
import { timestampFallbackMessage } from './timestamp-fallback';

describe('timestamp failure after signing', () => {
  it('explains the committed signature and absent timestamp without exposing the underlying error', () => {
    const result = timestampFallbackMessage(new Error('private diagnostic'));
    expect(result).toMatch(/document was signed/i);
    expect(result).toMatch(/no timestamp was embedded/i);
    expect(result).not.toContain('private diagnostic');
  });

  it('does not show a fallback warning when timestamping succeeded or was not requested', () => {
    expect(timestampFallbackMessage(undefined)).toBeNull();
    expect(timestampFallbackMessage(null)).toBeNull();
  });
});
