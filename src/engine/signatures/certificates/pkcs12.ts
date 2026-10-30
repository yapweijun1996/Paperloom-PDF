/** PKCS#12 import and certificate-file detection. */
import type { ImportedCertificateBundle } from './certificate-parser';
import { importAuthenticatedPkcs12 } from './pkcs12-protected';

/** Import a password-authenticated PKCS#12 identity into session memory. */
export async function importPkcs12(
  p12Bytes: Uint8Array,
  password = '',
  label = 'P12 import',
): Promise<ImportedCertificateBundle> {
  return importAuthenticatedPkcs12(p12Bytes, password, label);
}

/** Detect format from filename / magic. */
export function detectCertificateFileFormat(
  fileName: string,
  bytes?: Uint8Array,
): 'pem' | 'der' | 'p12' {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pem') || lower.endsWith('.crt') || lower.endsWith('.cer')) return 'pem';
  if (lower.endsWith('.p12') || lower.endsWith('.pfx')) return 'p12';
  if (bytes?.length) {
    if (bytes[0] === 0x2d) return 'pem';
    if (bytes[0] === 0x30) return lower.endsWith('.der') ? 'der' : 'p12';
  }
  return 'der';
}
