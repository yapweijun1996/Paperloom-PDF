/**
 * Phase 12 — Multi-signature manager & revision viewer data.
 */

import type { PDFDocumentData } from '../../types';
import { listRevisions, type PDFRevision, type RevisionChain } from '../../writer/revision-manager';
import { listSignatureFields, type SignatureField } from '../fields/signature-field';
import {
  extractPdfSignatureDict,
  validateSignatureField,
} from '../validation/validation-engine';
import type { SignatureValidationDetail, ValidationOptions } from '../validation/validation-types';

export interface ManagedSignature {
  field: SignatureField;
  /** Index among signed fields (0 = oldest discovered). */
  index: number;
  signerName: string | null;
  reason: string | null;
  signingTime: string | null;
  hasCms: boolean;
  validation?: SignatureValidationDetail;
}

export interface RevisionViewEntry {
  revision: PDFRevision;
  /** Signatures whose /ByteRange end roughly matches this revision length. */
  signatureFieldIds: string[];
}

export interface MultiSignatureSnapshot {
  signatures: ManagedSignature[];
  revisions: RevisionViewEntry[];
  revisionChain: RevisionChain | null;
  /** True when multiple signed fields exist. */
  multiSigned: boolean;
}

/**
 * List every signature field with metadata extracted from /V dictionaries.
 * Does not invalidate prior signatures — read-only inspection.
 */
export function listManagedSignatures(doc: PDFDocumentData): ManagedSignature[] {
  const fields = listSignatureFields(doc);
  const signed = fields.filter((f) => f.signed);
  return signed.map((field, index) => {
    const dict = extractPdfSignatureDict(doc, field);
    return {
      field,
      index,
      signerName: dict?.name ?? null,
      reason: dict?.reason ?? null,
      signingTime: dict?.signingTime ?? null,
      hasCms: !!(dict && dict.contents.length > 0),
    };
  });
}

/**
 * Build revision viewer entries from PDF bytes + signature ByteRanges.
 */
export function buildRevisionViewer(doc: PDFDocumentData): {
  revisions: RevisionViewEntry[];
  chain: RevisionChain | null;
} {
  const bytes = doc.rawBytes;
  if (!bytes || bytes.length === 0) {
    return { revisions: [], chain: null };
  }

  let chain: RevisionChain | null = null;
  try {
    chain = listRevisions(bytes);
  } catch {
    chain = null;
  }

  const managed = listManagedSignatures(doc);
  const revisions: RevisionViewEntry[] = (chain?.revisions ?? []).map((revision) => {
    const signatureFieldIds: string[] = [];
    const revSize = revision.size ?? bytes.length;
    for (const m of managed) {
      const dict = extractPdfSignatureDict(doc, m.field);
      if (!dict) continue;
      const covered = dict.byteRange[2] + dict.byteRange[3];
      if (Math.abs(covered - revSize) < 64 || covered === bytes.length) {
        if (revSize >= covered - 32) {
          signatureFieldIds.push(m.field.id);
        }
      }
    }
    return { revision, signatureFieldIds };
  });

  // Deduplicate: each signature assigned to earliest matching revision
  const seen = new Set<string>();
  for (const entry of revisions) {
    entry.signatureFieldIds = entry.signatureFieldIds.filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  return { revisions, chain };
}

/**
 * Full multi-signature snapshot with optional validation of each signature.
 */
export async function inspectMultiSignatures(
  doc: PDFDocumentData,
  options: ValidationOptions & { validate?: boolean } = {},
): Promise<MultiSignatureSnapshot> {
  const signatures = listManagedSignatures(doc);
  const { revisions, chain } = buildRevisionViewer(doc);

  if (options.validate !== false && doc.rawBytes) {
    for (const m of signatures) {
      m.validation = await validateSignatureField(
        doc,
        m.field,
        doc.rawBytes,
        options,
      );
    }
  }

  return {
    signatures,
    revisions,
    revisionChain: chain,
    multiSigned: signatures.length > 1,
  };
}

/**
 * Ensure a new signature only appends via incremental update semantics.
 * Returns true when doc.rawBytes is present (required for non-destructive multi-sign).
 */
export function canAddSignatureWithoutInvalidating(doc: PDFDocumentData): {
  ok: boolean;
  reason?: string;
} {
  if (!doc.rawBytes || doc.rawBytes.length === 0) {
    return {
      ok: false,
      reason: 'Document bytes required — load or serialize before adding another signature',
    };
  }
  return { ok: true };
}
