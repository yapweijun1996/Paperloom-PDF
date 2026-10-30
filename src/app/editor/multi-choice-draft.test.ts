import { describe, expect, it } from 'vitest';
import { decryptRecoveryOverlay, encryptRecoveryOverlay } from '@/lib/recoveryEncryption';
import { parseRecoveryOverlay } from './recovery-overlay';
import { decodeMultiChoiceDraft, encodeMultiChoiceDraft } from './multi-choice-draft';
import { FormDraftController, resolveRecoveredFormDraft } from './form-draft-controller';

it('restores multiple values inside an encrypted signed recovery without exposing them', async () => {
  const value = encodeMultiChoiceDraft(['Private rice', 'Secret tea']);
  const formDraft = { pageKey: '3_0', fieldKey: '7_0', value };
  const overlay = { drawnPathsJson: '[]', floatingTextsJson: '[]', floatingImagesJson: '[]', signaturesJson: '[]', currentPage: 0, signedSnapshot: '{"v":1}', formDraft };
  const bytes = new TextEncoder().encode('%PDF-1.7\nsynthetic');
  const encrypted = await encryptRecoveryOverlay(overlay, 'synthetic-password', bytes);
  expect(JSON.stringify(encrypted)).not.toContain('Private rice');
  expect(JSON.stringify(encrypted)).not.toContain('Secret tea');
  const reopened = parseRecoveryOverlay(await decryptRecoveryOverlay(encrypted, 'synthetic-password', bytes));
  const controller = new FormDraftController();
  controller.set(reopened.formDraft!);
  const resolved = resolveRecoveredFormDraft(controller.get()!, [{ ref: { toKey: () => '3_0' } }], () => [{ ref: { toKey: () => '7_0' }, fieldType: 'Ch' }]);
  expect(resolved.pageIndex).toBe(0);
  expect(decodeMultiChoiceDraft(controller.get()!.value)).toEqual(['Private rice', 'Secret tea']);
  await expect(controller.commit(async () => { throw new Error('write failed'); })).rejects.toThrow('write failed');
  expect(controller.get()).toEqual(formDraft);
}, 30000);

describe('multi-choice draft encoding', () => {
  it('handles Unicode, control characters and empty selections', () => {
    for (const values of [[], ['秘密', 'x\u0000y'], ['Rice']]) {
      expect(decodeMultiChoiceDraft(encodeMultiChoiceDraft(values))).toEqual(values);
    }
  });
  it.each(['unrecognized', '\u0000paperloom-multi-choice:bad', '\u0000paperloom-multi-choice:[1]', '\u0000paperloom-multi-choice:["a","a"]'])('rejects malformed drafts without guessing', value => {
    expect(() => decodeMultiChoiceDraft(value)).toThrow(/recovery has been preserved/i);
  });
});
