import type { EditorSessionOverlay } from './pdfStorage';

/** Versioned envelope. It contains no password or derived key. */
export interface EncryptedRecoveryOverlay {
  version: 1;
  salt: string;
  iv: string;
  ciphertext: string;
}

const ITERATIONS = 310_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const ASSOCIATED_DATA = new TextEncoder().encode('paperloom:editor-recovery-overlay:v1');

function requirePassword(password: string): void {
  // An empty PDF user password is publicly guessable and provides no protection
  // for an IndexedDB recovery record. Do not persist such a record as encrypted.
  if (password.length === 0) throw new Error('A non-empty password is required to protect recovery data.');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid encrypted recovery data');
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

async function associatedData(pdfBytes: ArrayBuffer | Uint8Array): Promise<ArrayBuffer> {
  const bytes = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
  if (bytes.byteLength === 0) throw new Error('Recovery PDF bytes are missing.');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', arrayBuffer(bytes)));
  const binding = new Uint8Array(ASSOCIATED_DATA.length + digest.length);
  binding.set(ASSOCIATED_DATA);
  binding.set(digest, ASSOCIATED_DATA.length);
  return binding.buffer;
}

async function recoveryKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw', arrayBuffer(new TextEncoder().encode(password)), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: arrayBuffer(salt), iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function isEditorSessionOverlay(value: unknown): value is EditorSessionOverlay {
  if (!value || typeof value !== 'object') return false;
  const overlay = value as Partial<EditorSessionOverlay>;
  return typeof overlay.drawnPathsJson === 'string' &&
    typeof overlay.floatingTextsJson === 'string' &&
    typeof overlay.floatingImagesJson === 'string' &&
    typeof overlay.signaturesJson === 'string' &&
    typeof overlay.currentPage === 'number' &&
    Number.isSafeInteger(overlay.currentPage) && overlay.currentPage >= 0 &&
    (overlay.signedSnapshot === undefined ||
      (typeof overlay.signedSnapshot === 'string' && overlay.signedSnapshot.length > 0)) &&
    (overlay.formDraft === undefined ||
      (!!overlay.formDraft && typeof overlay.formDraft === 'object' &&
       typeof overlay.formDraft.pageKey === 'string' && overlay.formDraft.pageKey.length > 0 &&
       typeof overlay.formDraft.fieldKey === 'string' && overlay.formDraft.fieldKey.length > 0 &&
       typeof overlay.formDraft.value === 'string'));
}

/** Encrypt recovery overlays; callers must never store the password or key. */
export async function encryptRecoveryOverlay(
  overlay: EditorSessionOverlay,
  password: string,
  pdfBytes: ArrayBuffer | Uint8Array,
): Promise<EncryptedRecoveryOverlay> {
  requirePassword(password);
  if (!isEditorSessionOverlay(overlay)) throw new Error('Invalid recovery overlay');
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const binding = await associatedData(pdfBytes);
  const key = await recoveryKey(password, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(overlay));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: arrayBuffer(iv), additionalData: binding },
    key,
    arrayBuffer(plaintext),
  );
  return { version: 1, salt: bytesToBase64(salt), iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(encrypted)) };
}

/** Reject malformed or tampered payloads and wrong passwords without returning partial data. */
export async function decryptRecoveryOverlay(
  envelope: EncryptedRecoveryOverlay,
  password: string,
  pdfBytes: ArrayBuffer | Uint8Array,
): Promise<EditorSessionOverlay> {
  requirePassword(password);
  try {
    if (!envelope || envelope.version !== 1 || typeof envelope.salt !== 'string' ||
        typeof envelope.iv !== 'string' || typeof envelope.ciphertext !== 'string') {
      throw new Error('Invalid encrypted recovery data');
    }
    const salt = base64ToBytes(envelope.salt);
    const iv = base64ToBytes(envelope.iv);
    const ciphertext = base64ToBytes(envelope.ciphertext);
    if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || ciphertext.length < 16) {
      throw new Error('Invalid encrypted recovery data');
    }
    const binding = await associatedData(pdfBytes);
    const key = await recoveryKey(password, salt);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: arrayBuffer(iv), additionalData: binding },
      key,
      arrayBuffer(ciphertext),
    );
    const overlay: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decrypted));
    if (!isEditorSessionOverlay(overlay)) throw new Error('Invalid recovery overlay');
    return overlay;
  } catch {
    throw new Error('Recovery data could not be decrypted.');
  }
}
