/**
 * Revision manager — walks and records incremental PDF update chains (/Prev).
 * Phase 6 deliverable.
 */

import { PDFDict, PDFName, PDFNumber } from '../types';
import { findStartXref, isTraditionalXref, parseXrefTable } from '../parser/xref';

export interface PDFRevision {
  /** 0-based index; 0 is the oldest (original) revision when listed oldest-first. */
  index: number;
  /** Byte offset of this revision's xref. */
  xrefOffset: number;
  /** Previous xref offset (/Prev), or null for the original. */
  prevOffset: number | null;
  /** Trailer /Size if present. */
  size: number | null;
  /** Trailer dictionary snapshot (shallow). */
  trailer: PDFDict;
}

export interface RevisionChain {
  revisions: PDFRevision[];
  /** Most recent startxref offset. */
  headXrefOffset: number;
  /** Total file length. */
  fileLength: number;
}

/**
 * List all revisions in a PDF by following /Prev from startxref.
 * Returns oldest → newest.
 */
export function listRevisions(pdfBytes: Uint8Array): RevisionChain {
  if (!pdfBytes.length) {
    return { revisions: [], headXrefOffset: 0, fileLength: 0 };
  }

  let headXrefOffset = 0;
  try {
    headXrefOffset = findStartXref(pdfBytes);
  } catch {
    return { revisions: [], headXrefOffset: 0, fileLength: pdfBytes.length };
  }

  const newestFirst: PDFRevision[] = [];
  const visited = new Set<number>();
  let current: number | null = headXrefOffset;

  while (current !== null && !visited.has(current)) {
    visited.add(current);
    let trailer = new PDFDict();
    let prev: number | null = null;
    let size: number | null = null;

    try {
      if (isTraditionalXref(pdfBytes, current)) {
        const section = parseXrefTable(pdfBytes, current);
        trailer = section.trailerDict;
        const prevVal = trailer.getNumber('Prev');
        prev = prevVal != null ? prevVal : null;
        size = trailer.getNumber('Size') ?? null;
      } else {
        // XRef stream — parse trailer-like dict from stream object header is complex;
        // record offset only and stop Prev walk if we can't parse.
        trailer = new PDFDict();
        trailer.set('Type', new PDFName('XRef'));
        prev = null;
      }
    } catch {
      break;
    }

    newestFirst.push({
      index: 0, // reassigned below
      xrefOffset: current,
      prevOffset: prev,
      size,
      trailer,
    });

    current = prev;
  }

  // Oldest first
  const revisions = newestFirst.reverse().map((r, i) => ({ ...r, index: i }));
  return {
    revisions,
    headXrefOffset,
    fileLength: pdfBytes.length,
  };
}

/**
 * Tracks revisions produced by this session's incremental appends.
 */
export class RevisionManager {
  private revisions: PDFRevision[] = [];
  private fileLength = 0;

  constructor(initialBytes?: Uint8Array) {
    if (initialBytes && initialBytes.length > 0) {
      const chain = listRevisions(initialBytes);
      this.revisions = chain.revisions;
      this.fileLength = chain.fileLength;
    }
  }

  get count(): number {
    return this.revisions.length;
  }

  get length(): number {
    return this.fileLength;
  }

  list(): PDFRevision[] {
    return this.revisions.map((r) => ({ ...r, trailer: r.trailer }));
  }

  head(): PDFRevision | null {
    return this.revisions.length > 0
      ? this.revisions[this.revisions.length - 1]
      : null;
  }

  /** Record a newly appended incremental update. */
  pushRevision(opts: {
    xrefOffset: number;
    prevOffset: number | null;
    size: number;
    fileLength: number;
    root?: import('../types').PDFRef | null;
  }): PDFRevision {
    const trailer = new PDFDict();
    trailer.set('Size', new PDFNumber(opts.size));
    trailer.set('Prev', new PDFNumber(opts.prevOffset ?? 0));
    if (opts.root) trailer.set('Root', opts.root);

    const rev: PDFRevision = {
      index: this.revisions.length,
      xrefOffset: opts.xrefOffset,
      prevOffset: opts.prevOffset,
      size: opts.size,
      trailer,
    };
    this.revisions.push(rev);
    this.fileLength = opts.fileLength;
    return rev;
  }

  /** Validate that /Prev chain is contiguous and offsets are in-range. */
  validate(fileLength = this.fileLength): { ok: boolean; errors: string[] } {
    const errors: string[] = [];
    for (const rev of this.revisions) {
      if (rev.xrefOffset < 0 || rev.xrefOffset >= fileLength) {
        errors.push(`Revision ${rev.index}: xrefOffset ${rev.xrefOffset} out of range`);
      }
      if (rev.prevOffset != null && (rev.prevOffset < 0 || rev.prevOffset >= fileLength)) {
        errors.push(`Revision ${rev.index}: prevOffset ${rev.prevOffset} out of range`);
      }
    }
    for (let i = 1; i < this.revisions.length; i++) {
      const prev = this.revisions[i - 1];
      const cur = this.revisions[i];
      if (cur.prevOffset !== prev.xrefOffset) {
        errors.push(
          `Revision ${cur.index}: /Prev ${cur.prevOffset} != prior xref ${prev.xrefOffset}`,
        );
      }
      if (cur.xrefOffset <= prev.xrefOffset) {
        errors.push(`Revision ${cur.index}: xref not after previous revision`);
      }
    }
    return { ok: errors.length === 0, errors };
  }
}
