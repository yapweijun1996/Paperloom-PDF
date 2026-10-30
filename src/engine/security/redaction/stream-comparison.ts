import type { PDFStream } from '../../types';

export interface StreamComparisonBudget {
  streams: number;
  pairs: number;
  bytes: number;
  buffers: WeakMap<PDFStream, Uint8Array[]>;
}

const MAX_COMPARISONS = 65_536;
const MAX_BYTES = 67_108_864;

export function streamComparisonBudget(): StreamComparisonBudget {
  return { streams: 0, pairs: 0, bytes: 0, buffers: new WeakMap() };
}

function equalBytes(a: Uint8Array, b: Uint8Array, budget: StreamComparisonBudget, refuse: (reason: string) => never): boolean {
  if (++budget.pairs > MAX_COMPARISONS) refuse('stream comparison exceeds the inspection pair limit');
  if (a.length !== b.length) return false;
  const remaining = MAX_BYTES - budget.bytes;
  const end = Math.min(a.length, remaining);
  let i = 0;
  while (i < end && a[i] === b[i]) i++;
  if (i < end) { budget.bytes += i + 1; return false; }
  budget.bytes += end;
  if (a.length > remaining) refuse('stream comparison exceeds the inspection byte limit');
  return true;
}

function buffers(stream: PDFStream, budget: StreamComparisonBudget, refuse: (reason: string) => never): Uint8Array[] {
  const existing = budget.buffers.get(stream);
  if (existing) return existing;
  const values = [stream.rawBytes, stream.decodedBytes].filter((bytes): bytes is Uint8Array => !!bytes && bytes.length > 0);
  // Snapshot buffers are independent; test their actual bytes before removing
  // redundant representations. Bound this preliminary comparison too.
  if (values.length === 2 && (values[0] === values[1] || equalBytes(values[0], values[1], budget, refuse))) values.pop();
  budget.buffers.set(stream, values);
  return values;
}

/** Bound both the Cartesian product of streams and their byte comparisons. */
export function matchingStreamBytes(
  removed: PDFStream,
  retained: PDFStream,
  budget: StreamComparisonBudget,
  refuse: (reason: string) => never,
): boolean {
  // Empty streams still cost one outer comparison even though they supply no
  // nonempty buffers to the inner loop.
  if (++budget.streams > MAX_COMPARISONS) refuse('stream comparison exceeds the inspection pair limit');
  const left = buffers(removed, budget, refuse), right = buffers(retained, budget, refuse);
  for (const a of left) for (const b of right) if (equalBytes(a, b, budget, refuse)) return true;
  return false;
}
