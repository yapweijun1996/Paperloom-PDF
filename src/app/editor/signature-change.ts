import type { VisualSignature } from '@/engine/browser-core';
import type { PDFRef } from '@/engine/types';

interface SignatureChange {
  enqueue: (apply: (isCurrent: () => boolean) => Promise<void>) => Promise<void>;
  current: () => VisualSignature[];
  update: (current: VisualSignature[]) => VisualSignature[];
  apply: (previous: VisualSignature[], next: VisualSignature[], isCurrent: () => boolean) => Promise<void>;
}

/** Compare the latest snapshot only after earlier queued edits have completed. */
export async function runSignatureChange(change: SignatureChange): Promise<boolean> {
  let applied = false;
  await change.enqueue(async isCurrent => {
    const previous = change.current();
    const next = change.update(previous);
    for (const signature of previous) {
      if (!signature.locked) continue;
      const matches = next.filter(item => item.id === signature.id);
      if (matches.length !== 1 || matches[0] !== signature) {
        throw new Error('Unlock the signature before editing or deleting it.');
      }
    }
    if (previous.length === next.length && previous.every((signature, index) => signature === next[index])) return;
    await change.apply(previous, next, isCurrent);
    applied = true;
  });
  return applied;
}


/** Lock changes share the edit queue but do not rewrite the native appearance. */
export async function runSignatureLockChange(change: {
  enqueue: SignatureChange['enqueue'];
  current: SignatureChange['current'];
  id: string;
  apply: (next: VisualSignature[], isCurrent: () => boolean) => Promise<void>;
}): Promise<boolean> {
  let applied = false;
  await change.enqueue(async isCurrent => {
    const previous = change.current();
    const target = previous.find(signature => signature.id === change.id);
    if (!target) return;
    const next = previous.map(signature => signature === target ? { ...signature, locked: !signature.locked } : signature);
    await change.apply(next, isCurrent);
    applied = true;
  });
  return applied;
}

/** A locked field is identified by its native Widget even when recovery geometry is stale. */
export function assertSignatureFieldIdentityAllowed(
  signatures: VisualSignature[], fieldRef: PDFRef, refs: ReadonlyMap<string, PDFRef>,
): void {
  for (const signature of signatures) {
    if (!signature.locked) continue;
    const ref = refs.get(signature.id);
    if (ref?.toKey() === fieldRef.toKey() || (signature.requiresCompositeAppearance && !ref)) {
      throw new Error('Unlock the signature before replacing its field.');
    }
  }
}

/** Visual placement also removes overlapping signatures, so protect those separately. */
export function assertSignatureFieldPlacementAllowed(
  signatures: VisualSignature[], pageIndex: number, x: number, y: number,
  fieldRef: PDFRef, refs: ReadonlyMap<string, PDFRef>,
): void {
  assertSignatureFieldIdentityAllowed(signatures, fieldRef, refs);
  if (signatures.some(signature => signature.locked && signature.pageIndex === pageIndex &&
      Math.abs(signature.x - x) < 2 && Math.abs(signature.y - y) < 2)) {
    throw new Error('Unlock the signature before replacing its field.');
  }
}

/** A page operation cannot discard an existing locked signature. */
export function assertLockedSignaturePagesPreserved(signatures: VisualSignature[], previousPages: string[], nextPages: string[]): void {
  const remaining = new Set(nextPages);
  for (const signature of signatures) {
    if (signature.locked && (!previousPages[signature.pageIndex] || !remaining.has(previousPages[signature.pageIndex]))) {
      throw new Error('Unlock signatures before deleting their page.');
    }
  }
}
