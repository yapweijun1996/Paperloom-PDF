/**
 * Offset manager — tracks PDF object byte offsets across incremental revisions.
 * Phase 6 deliverable.
 */

export type ObjectKey = string; // `${objNum}_${genNum}`

export interface OffsetRecord {
  key: ObjectKey;
  objNum: number;
  genNum: number;
  /** Absolute byte offset in the current PDF file. */
  offset: number;
  /** Revision index that last wrote this object (0 = original). */
  revisionIndex: number;
}

/** Parse "12_0" → { objNum: 12, genNum: 0 }. */
export function parseObjectKey(key: ObjectKey): { objNum: number; genNum: number } {
  const parts = key.split('_');
  return {
    objNum: parseInt(parts[0], 10) || 0,
    genNum: parseInt(parts[1] ?? '0', 10) || 0,
  };
}

export function makeObjectKey(objNum: number, genNum = 0): ObjectKey {
  return `${objNum}_${genNum}`;
}

/**
 * Tracks absolute file offsets for PDF objects.
 * Does not rewrite prior bytes — only records where objects live after appends.
 */
export class OffsetManager {
  private records = new Map<ObjectKey, OffsetRecord>();
  private fileLength = 0;

  constructor(initialFileLength = 0) {
    this.fileLength = Math.max(0, initialFileLength);
  }

  get length(): number {
    return this.fileLength;
  }

  setFileLength(len: number): void {
    this.fileLength = Math.max(0, len);
  }

  /** Seed offsets from an existing xref entry map. */
  seedFromXref(
    entries: Iterable<{ key: string; offset: number; objNum: number; genNum: number }>,
    revisionIndex = 0,
  ): void {
    for (const e of entries) {
      this.records.set(e.key, {
        key: e.key,
        objNum: e.objNum,
        genNum: e.genNum,
        offset: e.offset,
        revisionIndex,
      });
    }
  }

  record(key: ObjectKey, offset: number, revisionIndex: number): void {
    const { objNum, genNum } = parseObjectKey(key);
    this.records.set(key, { key, objNum, genNum, offset, revisionIndex });
  }

  /** Record a contiguous write of objects during an incremental append. */
  recordBatch(
    offsets: Map<ObjectKey, number>,
    revisionIndex: number,
    newFileLength: number,
  ): void {
    for (const [key, offset] of offsets) {
      this.record(key, offset, revisionIndex);
    }
    this.fileLength = newFileLength;
  }

  get(key: ObjectKey): OffsetRecord | null {
    return this.records.get(key) ?? null;
  }

  getOffset(key: ObjectKey): number | null {
    return this.records.get(key)?.offset ?? null;
  }

  /** All recorded offsets (latest wins per key). */
  all(): OffsetRecord[] {
    return Array.from(this.records.values()).sort((a, b) => a.objNum - b.objNum);
  }

  /** Snapshot for tests / debugging. */
  toMap(): Map<ObjectKey, number> {
    const m = new Map<ObjectKey, number>();
    for (const [k, r] of this.records) m.set(k, r.offset);
    return m;
  }

  clear(): void {
    this.records.clear();
    this.fileLength = 0;
  }
}
