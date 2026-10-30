import { PDFDict, PDFRef, type PDFDocumentData } from '../types';
import { getReencryptSaveContext } from '../security/encryption/encrypt-objects';
import { dehydrateDocument, hydrateDocument, type WireDocument } from '../worker/codec';
import { hasDocumentSignature, hasFinalizedSignature } from '../writer/save-pipeline';
import { parsePDF } from '../parser/parser';

// A draft is an internal object graph, not a signed PDF or a download format.
// Callers must encrypt the *whole* returned string before persisting a draft of
// a protected document. The authenticated file key is never included here.
interface SignedRecoveryEnvelope {
  version: 1;
  originalDigest: string;
  payloadDigest: string;
  payload: string;
}

function base64(bytes: Uint8Array): string {
  let value = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    value += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(value);
}

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid signed recovery bytes.');
  }
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

async function digest(bytes: Uint8Array): Promise<string> {
  return base64(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)));
}

async function requireOriginal(original: PDFDocumentData): Promise<void> {
  if (hasFinalizedSignature(original.rawBytes)) return;
  // A draft's live graph may differ from its original bytes. Inspect the
  // original separately instead of accepting a signature only in the draft.
  try {
    const parsed = await parsePDF(original.rawBytes.slice());
    if (hasDocumentSignature(parsed)) return;
  } catch {
    // An unreadable original cannot establish signed provenance.
  }
  throw new Error('Signed recovery requires the original signed PDF.');
}

/** Capture a draft without changing or exporting the finalized signed bytes. */
export async function createSignedRecoverySnapshot(doc: PDFDocumentData): Promise<string> {
  await requireOriginal(doc);
  if (doc.decryptedFromEncrypted && !doc.encryptionFileKey?.length) {
    throw new Error('Signed recovery requires an unlocked protected PDF.');
  }
  const wire = dehydrateDocument(doc, { includeRawBytes: false });
  delete wire.encryptionFileKey;
  delete wire.encryptionAlgorithm;
  delete wire.decryptedFromEncrypted;
  const payload = JSON.stringify(wire, (_key, value: unknown) =>
    value instanceof Uint8Array ? { __paperloomBytes: base64(value) } : value);
  const envelope: SignedRecoveryEnvelope = {
    version: 1,
    originalDigest: await digest(doc.rawBytes),
    payloadDigest: await digest(new TextEncoder().encode(payload)),
    payload,
  };
  return JSON.stringify(envelope);
}

/** Restore a draft against exactly the signed source used to create it. */
export async function restoreSignedRecoverySnapshot(original: PDFDocumentData, snapshot: string): Promise<PDFDocumentData> {
  await requireOriginal(original);
  if ((original.xref.trailerDict.getRef('Encrypt') || original.decryptedFromEncrypted) &&
      (!original.encryptionFileKey?.length || !getReencryptSaveContext(original))) {
    throw new Error('Signed recovery requires an unlocked protected PDF.');
  }
  try {
    const envelope = JSON.parse(snapshot) as Partial<SignedRecoveryEnvelope>;
    if (!envelope || envelope.version !== 1 || typeof envelope.originalDigest !== 'string' ||
        typeof envelope.payloadDigest !== 'string' || typeof envelope.payload !== 'string' ||
        envelope.originalDigest !== await digest(original.rawBytes) ||
        envelope.payloadDigest !== await digest(new TextEncoder().encode(envelope.payload))) {
      throw new Error('Signed recovery integrity check failed.');
    }
    const wire = JSON.parse(envelope.payload, (_key, value: unknown) => {
      if (value && typeof value === 'object' && '__paperloomBytes' in value) {
        const marker = value as { __paperloomBytes?: unknown };
        if (Object.keys(value).length !== 1 || typeof marker.__paperloomBytes !== 'string') {
          throw new Error('Invalid signed recovery bytes.');
        }
        return decodeBase64(marker.__paperloomBytes);
      }
      return value;
    }) as WireDocument;
    if (!wire || wire.rawBytes !== null || wire.encryptionFileKey !== undefined ||
        wire.encryptionAlgorithm !== undefined || wire.decryptedFromEncrypted !== undefined ||
        !Array.isArray(wire.nodes) || !Array.isArray(wire.objects) || !Array.isArray(wire.pages) ||
        !wire.xref || !Array.isArray(wire.xref.entries)) {
      throw new Error('Invalid signed recovery graph.');
    }
    const restored = hydrateDocument(wire, original.rawBytes.slice());
    if (!(restored.catalog instanceof PDFDict) || !(restored.xref.trailerDict instanceof PDFDict) ||
        restored.pages.some(page => !(page.dict instanceof PDFDict) || !(page.ref instanceof PDFRef) ||
          !(page.resources instanceof PDFDict) || page.contentRefs.some(ref => !(ref instanceof PDFRef)))) {
      throw new Error('Invalid signed recovery graph.');
    }
    restored.decryptedFromEncrypted = original.decryptedFromEncrypted;
    restored.encryptionFileKey = original.encryptionFileKey?.slice();
    restored.encryptionAlgorithm = original.encryptionAlgorithm;
    return restored;
  } catch {
    throw new Error('Signed recovery data is corrupt or belongs to a different document.');
  }
}
