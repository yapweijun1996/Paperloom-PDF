import { describe, expect, it } from 'vitest';
import { decryptRecoveryOverlay, encryptRecoveryOverlay } from './recoveryEncryption';
import type { EditorSessionOverlay } from './pdfStorage';

const overlay: EditorSessionOverlay = {
  drawnPathsJson: '[{"note":"private line"}]',
  floatingTextsJson: '[{"text":"秘密"}]',
  floatingImagesJson: '[{"dataUrl":"data:image/png;base64,AA=="}]',
  signaturesJson: '[]',
  currentPage: 3,
};
const pdfBytes = new TextEncoder().encode('%PDF-1.7\nexample document');

describe('encrypted recovery overlays', () => {
  it('round-trips an overlay without storing its plaintext or password', async () => {
    const envelope = await encryptRecoveryOverlay(overlay, 'test recovery password', pdfBytes);
    expect(JSON.stringify(envelope)).not.toContain('private line');
    expect(JSON.stringify(envelope)).not.toContain('秘密');
    expect(JSON.stringify(envelope)).not.toContain('test recovery password');
    expect(await decryptRecoveryOverlay(envelope, 'test recovery password', pdfBytes.buffer)).toEqual(overlay);
  }, 30000);

  it('protects unfinished form values in signed recovery', async () => {
    const marker = 'private unfinished form value';
    const saved = { ...overlay, formDraft: { pageKey: '3_0', fieldKey: '7_0', value: marker }, signedSnapshot: '{"version":1}' };
    const envelope = await encryptRecoveryOverlay(saved, 'password', pdfBytes);
    expect(JSON.stringify(envelope)).not.toContain(marker);
    expect(await decryptRecoveryOverlay(envelope, 'password', pdfBytes)).toEqual(saved);
  }, 30000);

  it('protects and authenticates a signed document snapshot alongside overlays', async () => {
    const marker = 'signed private document graph';
    const signedSnapshot = JSON.stringify({ graph: marker });
    const snapshotOverlay = { ...overlay, signedSnapshot };
    const envelope = await encryptRecoveryOverlay(snapshotOverlay, 'password', pdfBytes);
    const stored = JSON.stringify(envelope);
    expect(stored).not.toContain(marker);
    expect(stored).not.toContain(signedSnapshot);
    expect(await decryptRecoveryOverlay(envelope, 'password', pdfBytes)).toEqual(snapshotOverlay);
    await expect(decryptRecoveryOverlay(envelope, 'wrong password', pdfBytes)).rejects.toThrow('Recovery data could not be decrypted');
    await expect(decryptRecoveryOverlay(envelope, 'password', new Uint8Array([1, 2, 3]))).rejects.toThrow('Recovery data could not be decrypted');
  }, 30000);

  it.each(['', 123, null])(
    'rejects an invalid signed snapshot before encryption: %s',
    async (signedSnapshot) => {
      await expect(encryptRecoveryOverlay({ ...overlay, signedSnapshot } as EditorSessionOverlay, 'password', pdfBytes))
        .rejects.toThrow('Invalid recovery overlay');
    },
  );

  it('rejects wrong passwords and modified authenticated data', async () => {
    const envelope = await encryptRecoveryOverlay(overlay, 'correct password', pdfBytes);
    await expect(decryptRecoveryOverlay(envelope, 'wrong password', pdfBytes)).rejects.toThrow('Recovery data could not be decrypted');
    await expect(decryptRecoveryOverlay(envelope, 'correct password', new TextEncoder().encode('%PDF-1.7\nother document'))).rejects.toThrow('Recovery data could not be decrypted');
    const bytes = Uint8Array.from(atob(envelope.ciphertext), (character) => character.charCodeAt(0));
    bytes[0] ^= 1;
    const ciphertext = btoa(String.fromCharCode(...bytes));
    await expect(decryptRecoveryOverlay({ ...envelope, ciphertext }, 'correct password', pdfBytes)).rejects.toThrow('Recovery data could not be decrypted');
    await expect(decryptRecoveryOverlay({ ...envelope, iv: envelope.iv.replace(/^./, envelope.iv[0] === 'A' ? 'B' : 'A') }, 'correct password', pdfBytes)).rejects.toThrow('Recovery data could not be decrypted');
  }, 30000);

  it('uses a fresh salt and nonce and rejects empty passwords and invalid envelopes', async () => {
    const first = await encryptRecoveryOverlay(overlay, 'password', pdfBytes);
    const second = await encryptRecoveryOverlay(overlay, 'password', pdfBytes);
    expect(first.salt).not.toBe(second.salt);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    await expect(encryptRecoveryOverlay(overlay, '', pdfBytes)).rejects.toThrow('non-empty password');
    await expect(decryptRecoveryOverlay(first, '', pdfBytes)).rejects.toThrow('non-empty password');
    await expect(encryptRecoveryOverlay(overlay, 'password', new Uint8Array())).rejects.toThrow('Recovery PDF bytes are missing');
    await expect(decryptRecoveryOverlay({ ...first, version: 2 } as never, 'password', pdfBytes)).rejects.toThrow('Recovery data could not be decrypted');
    await expect(decryptRecoveryOverlay({ ...first, salt: 'not base64!' }, 'password', pdfBytes)).rejects.toThrow('Recovery data could not be decrypted');
  }, 30000);
});
