import { describe, expect, it } from 'vitest';
import { derInteger, derLength, derObjectIdentifier, derOctetString, derSequence } from '../../signatures/crypto/cms-builder';
import { importPkcs12 } from '../../signatures/certificates/pkcs12';

describe('protected PKCS#12 import', () => {
  it('rejects malformed encrypted content without advising plaintext key export', async () => {
    const encryptedDataOid = derObjectIdentifier([1, 2, 840, 113549, 1, 7, 6]);
    const pfx = new Uint8Array(derSequence([...derInteger(3), ...derSequence(encryptedDataOid)]));
    await expect(importPkcs12(pfx, 'test-password')).rejects.toThrow();
    try {
      await importPkcs12(pfx, 'test-password');
    } catch (error) {
      expect(String(error)).not.toMatch(/-nodes|export.*pem/i);
    }
  });

  it('rejects a shrouded key bag lacking integrity metadata rather than returning a partial identity', async () => {
    const data = derObjectIdentifier([1, 2, 840, 113549, 1, 7, 1]);
    const shrouded = derObjectIdentifier([1, 2, 840, 113549, 1, 12, 10, 1, 2]);
    const explicit = (value: number[]) => [0xa0, ...derLength(value.length), ...value];
    const safeContents = derSequence(derSequence(shrouded));
    const inner = derSequence([...data, ...explicit(derOctetString(safeContents))]);
    const outer = derSequence([...data, ...explicit(derOctetString(derSequence(inner)))]);
    const pfx = new Uint8Array(derSequence([...derInteger(3), ...outer]));
    await expect(importPkcs12(pfx, 'test-password')).rejects.toThrow();
  });
});
