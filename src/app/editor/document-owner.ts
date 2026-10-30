import type { PDFDocumentData } from '@/engine/types';

export interface DocumentLease {
  isCurrent(): boolean;
}

/** Owns document identity and serializes operations tied to one loaded document. */
export class EditorDocumentOwner {
  private current: PDFDocumentData | null = null;
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();
  private pendingOperations = 0;

  replace(document: PDFDocumentData | null): void {
    this.current = document;
    this.generation++;
  }

  lease(document: PDFDocumentData): DocumentLease {
    const generation = this.generation;
    return {
      isCurrent: () => this.current === document && this.generation === generation,
    };
  }

  /** Includes queued operations and the currently running operation. */
  getPendingCount(): number {
    return this.pendingOperations;
  }

  async whenIdle(): Promise<void> {
    // Work may have been added while an earlier operation was pending.
    for (;;) {
      const pending = this.pending;
      await pending;
      if (pending === this.pending) return;
    }
  }

  enqueue(
    document: PDFDocumentData,
    waitForAnnotations: () => Promise<void> | null,
    apply: (isCurrent: () => boolean) => Promise<void>,
  ): Promise<void> {
    const lease = this.lease(document);
    this.pendingOperations++;
    const result = this.pending.then(async () => {
      await waitForAnnotations();
      if (!lease.isCurrent()) throw new Error('The document was replaced before the edit.');
      await apply(lease.isCurrent);
    }).finally(() => {
      this.pendingOperations--;
    });
    // A failed operation must not poison the queue or idle waiters.
    this.pending = result.catch(() => {});
    return result;
  }
}
