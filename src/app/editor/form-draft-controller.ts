import type { RecoveredFormDraft } from '@/lib/pdfStorage';

/** Retains unfinished input until the corresponding transaction succeeds. */
export class FormDraftController {
  private current: RecoveredFormDraft | null = null;
  private sequence = 0;
  private committing: Promise<void> | null = null;

  get(): RecoveredFormDraft | null {
    return this.current ? { ...this.current } : null;
  }

  set(draft: RecoveredFormDraft): void {
    this.current = { ...draft };
    this.sequence++;
  }

  clear(): void {
    this.current = null;
    this.sequence++;
  }

  /** Concurrent callers share a transaction; later typing is flushed afterward. */
  async commit(write: (draft: RecoveredFormDraft) => Promise<void>): Promise<void> {
    while (this.current) {
      if (this.committing) {
        await this.committing;
        continue;
      }
      const draft = { ...this.current };
      const sequence = this.sequence;
      const operation = write(draft);
      this.committing = operation;
      try {
        await operation;
        if (this.sequence === sequence) this.current = null;
      } finally {
        if (this.committing === operation) this.committing = null;
      }
    }
  }
}

/** Resolve a saved draft without silently assigning it to a different field. */
export function resolveRecoveredFormDraft<T extends { ref: { toKey(): string }; fieldType: string }>(
  draft: RecoveredFormDraft,
  pages: Array<{ ref: { toKey(): string } }>,
  fieldsOnPage: (pageIndex: number) => T[],
): { pageIndex: number; field: T } {
  const pageIndex = pages.findIndex(page => page.ref.toKey() === draft.pageKey);
  if (pageIndex < 0) throw new Error('The recovered form draft page cannot be found. Recovery has been preserved.');
  const fields = fieldsOnPage(pageIndex).filter(field => field.ref.toKey() === draft.fieldKey);
  if (fields.length !== 1 || !['Tx', 'Ch', 'Btn'].includes(fields[0].fieldType)) {
    throw new Error('The recovered form draft field cannot be found. Recovery has been preserved.');
  }
  return { pageIndex, field: fields[0] };
}
