/** A classic cross-reference entry is exactly 20 bytes including CRLF. */
export function formatXrefEntry(offset: number, generation: number, state: 'n' | 'f'): string {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 9_999_999_999 ||
      !Number.isInteger(generation) || generation < 0 || generation > 65_535) {
    throw new Error('Cross-reference entry is outside the classic xref field widths.');
  }
  // The caller joins lines with LF, completing the two-byte line ending.
  return `${String(offset).padStart(10, '0')} ${String(generation).padStart(5, '0')} ${state}\r`;
}
