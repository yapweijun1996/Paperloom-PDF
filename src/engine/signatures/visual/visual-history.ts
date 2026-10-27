/**
 * Undo/redo stack for visual signature overlays (independent of PDF content snapshots).
 */

import type { VisualSignature } from './visual-types';

export interface SignatureSnapshot {
  signatures: VisualSignature[];
  label: string;
  timestamp: number;
}

function cloneList(list: VisualSignature[]): VisualSignature[] {
  return list.map((s) => ({ ...s }));
}

export class SignatureHistory {
  private undoStack: SignatureSnapshot[] = [];
  private redoStack: SignatureSnapshot[] = [];
  private readonly maxSize: number;

  constructor(maxSize = 50) {
    this.maxSize = maxSize;
  }

  /** Seed with the current state (call once at load / clear). */
  seed(signatures: VisualSignature[], label = 'init'): void {
    this.undoStack = [{ signatures: cloneList(signatures), label, timestamp: Date.now() }];
    this.redoStack = [];
  }

  push(signatures: VisualSignature[], label: string): void {
    this.undoStack.push({
      signatures: cloneList(signatures),
      label,
      timestamp: Date.now(),
    });
    if (this.undoStack.length > this.maxSize) this.undoStack.shift();
    this.redoStack = [];
  }

  canUndo(): boolean {
    return this.undoStack.length > 1;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): VisualSignature[] | null {
    if (this.undoStack.length < 2) return null;
    const current = this.undoStack.pop()!;
    this.redoStack.push(current);
    return cloneList(this.undoStack[this.undoStack.length - 1].signatures);
  }

  redo(): VisualSignature[] | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(next);
    return cloneList(next.signatures);
  }

  peek(): SignatureSnapshot | null {
    return this.undoStack.length > 0
      ? this.undoStack[this.undoStack.length - 1]
      : null;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
