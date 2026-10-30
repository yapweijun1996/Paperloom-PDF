import type { VisualSignature } from '@/engine/browser-core';

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
    if (previous.length === next.length && previous.every((signature, index) => signature === next[index])) return;
    await change.apply(previous, next, isCurrent);
    applied = true;
  });
  return applied;
}
