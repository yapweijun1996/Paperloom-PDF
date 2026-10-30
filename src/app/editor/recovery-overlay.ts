import type { EditorSessionOverlay, RecoveredFormDraft } from '@/lib/pdfStorage';

export interface ParsedRecoveryOverlay {
  drawnPaths: unknown[];
  floatingTexts: unknown[];
  floatingImages: unknown[];
  signatures: unknown[];
  currentPage: number;
  signedSnapshot?: string;
  formDraft?: RecoveredFormDraft;
}

/** Parse persisted recovery data without treating malformed content as empty. */
export function parseRecoveryOverlay(overlay: EditorSessionOverlay): ParsedRecoveryOverlay {
  if (!overlay || typeof overlay !== 'object') throw new Error('Invalid recovery overlay');

  const parseArray = (value: unknown, name: string): unknown[] => {
    if (typeof value !== 'string') throw new Error(`Invalid recovery overlay: ${name}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`Invalid recovery overlay: ${name}`);
    }
    if (!Array.isArray(parsed)) throw new Error(`Invalid recovery overlay: ${name}`);
    return parsed;
  };

  if (!Number.isSafeInteger(overlay.currentPage) || overlay.currentPage < 0) {
    throw new Error('Invalid recovery overlay: currentPage');
  }
  if (overlay.signedSnapshot !== undefined &&
      (typeof overlay.signedSnapshot !== 'string' || overlay.signedSnapshot.length === 0)) {
    throw new Error('Invalid recovery overlay: signedSnapshot');
  }

  if (overlay.formDraft !== undefined) {
    const draft = overlay.formDraft;
    if (!draft || typeof draft !== 'object' || typeof draft.pageKey !== 'string' || !draft.pageKey ||
        typeof draft.fieldKey !== 'string' || !draft.fieldKey || typeof draft.value !== 'string') {
      throw new Error('Invalid recovery overlay: formDraft');
    }
  }

  return {
    ...(overlay.formDraft === undefined ? {} : { formDraft: { ...overlay.formDraft } }),
    drawnPaths: parseArray(overlay.drawnPathsJson, 'drawnPathsJson'),
    floatingTexts: parseArray(overlay.floatingTextsJson, 'floatingTextsJson'),
    floatingImages: parseArray(overlay.floatingImagesJson, 'floatingImagesJson'),
    signatures: parseArray(overlay.signaturesJson, 'signaturesJson'),
    currentPage: overlay.currentPage,
    ...(overlay.signedSnapshot === undefined ? {} : { signedSnapshot: overlay.signedSnapshot }),
  };
}
