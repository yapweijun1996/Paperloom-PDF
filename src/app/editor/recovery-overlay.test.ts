import { describe, expect, it } from 'vitest';
import type { EditorSessionOverlay } from '@/lib/pdfStorage';
import { parseRecoveryOverlay } from './recovery-overlay';

function overlay(): EditorSessionOverlay {
  return {
    drawnPathsJson: '[{"id":"path"}]',
    floatingTextsJson: '[{"text":"draft"}]',
    floatingImagesJson: '[]',
    signaturesJson: '[{"id":"signature"}]',
    currentPage: 2,
  };
}

describe('recovery overlay parsing', () => {
  it('returns each persisted array and page without changing their contents', () => {
    expect(parseRecoveryOverlay(overlay())).toEqual({
      drawnPaths: [{ id: 'path' }],
      floatingTexts: [{ text: 'draft' }],
      floatingImages: [],
      signatures: [{ id: 'signature' }],
      currentPage: 2,
    });
  });

  it.each(['drawnPathsJson', 'floatingTextsJson', 'floatingImagesJson', 'signaturesJson'] as const)(
    'rejects malformed, missing and non-array %s instead of dropping recovery data',
    (key) => {
      for (const value of ['{', 'null', '{}', '"text"', '1', undefined]) {
        const data = { ...overlay(), [key]: value } as unknown as EditorSessionOverlay;
        expect(() => parseRecoveryOverlay(data)).toThrow(key);
      }
    },
  );

  it.each([-1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '0'])(
    'rejects invalid page index %s',
    (currentPage) => {
      const data = { ...overlay(), currentPage } as unknown as EditorSessionOverlay;
      expect(() => parseRecoveryOverlay(data)).toThrow('currentPage');
    },
  );

  it('accepts a safe page index without clamping it to a document', () => {
    expect(parseRecoveryOverlay({ ...overlay(), currentPage: Number.MAX_SAFE_INTEGER }).currentPage)
      .toBe(Number.MAX_SAFE_INTEGER);
  });

  it('preserves signed draft snapshots and rejects invalid snapshot fields', () => {
    expect(parseRecoveryOverlay({ ...overlay(), signedSnapshot: '{"version":1}' }).signedSnapshot)
      .toBe('{"version":1}');
    for (const signedSnapshot of ['', null, 1, {}]) {
      expect(() => parseRecoveryOverlay({ ...overlay(), signedSnapshot } as unknown as EditorSessionOverlay))
        .toThrow('signedSnapshot');
    }
  });

  it('preserves optional form drafts and rejects malformed records without dropping work', () => {
    const formDraft = { pageKey: '3_0', fieldKey: '7_0', value: 'unfinished' };
    expect(parseRecoveryOverlay({ ...overlay(), formDraft }).formDraft).toEqual(formDraft);
    expect(parseRecoveryOverlay(overlay()).formDraft).toBeUndefined();
    for (const invalid of [null, {}, { ...formDraft, pageKey: '' }, { ...formDraft, fieldKey: '' }, { ...formDraft, value: null }]) {
      expect(() => parseRecoveryOverlay({ ...overlay(), formDraft: invalid } as unknown as EditorSessionOverlay)).toThrow('formDraft');
    }
  });

  it('rejects a missing recovery overlay', () => {
    expect(() => parseRecoveryOverlay(null as unknown as EditorSessionOverlay)).toThrow('Invalid recovery overlay');
  });
});
