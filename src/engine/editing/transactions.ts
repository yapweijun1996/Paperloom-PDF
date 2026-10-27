/**
 * Edit Transactions — Phase 5
 *
 * Undo/redo stack for content-stream mutations with coalescing.
 */

export interface EditSnapshot {
  pageIndex: number;
  contentBytes: Uint8Array;
  label: string;
  timestamp: number;
}

export class TransactionStack {
  private undoStack: EditSnapshot[] = [];
  private redoStack: EditSnapshot[] = [];
  private readonly maxSize: number;

  constructor(maxSize = 50) {
    this.maxSize = maxSize;
  }

  push(snapshot: EditSnapshot): void {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.maxSize) this.undoStack.shift();
    this.redoStack = [];
  }

  canUndo(): boolean {
    return this.undoStack.length > 1;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): EditSnapshot | null {
    if (this.undoStack.length < 2) return null;
    const current = this.undoStack.pop()!;
    this.redoStack.push(current);
    return this.undoStack[this.undoStack.length - 1];
  }

  redo(): EditSnapshot | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(next);
    return next;
  }

  peek(): EditSnapshot | null {
    return this.undoStack.length > 0 ? this.undoStack[this.undoStack.length - 1] : null;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
