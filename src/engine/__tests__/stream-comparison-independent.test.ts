import { describe, expect, it } from 'vitest';
import { PDFDict, PDFStream } from '../types';
import { matchingStreamBytes, streamComparisonBudget } from '../security/redaction/stream-comparison';

const MAX_PAIRS = 65_536;
const MAX_BYTES = 67_108_864;
const refuse = (reason: string): never => { throw new Error(reason); };
const stream = (raw: Uint8Array, decoded: Uint8Array | null = null) => new PDFStream(new PDFDict(), raw, decoded);
const budget = streamComparisonBudget;
const bytes = (...values: number[]) => new Uint8Array(values);

// This independent oracle expresses the previous duplicate policy, including
// empty buffers not counting as duplicate streams.
function duplicate(left: PDFStream, right: PDFStream): boolean {
  return [left.rawBytes, left.decodedBytes].some(a => a && a.length > 0 &&
    [right.rawBytes, right.decodedBytes].some(b => b && b.length === a.length && a.every((value, index) => value === b[index])));
}

describe('independent redaction stream comparison audit', () => {
  it('preserves duplicate semantics across mixed raw and decoded buffers, including aliasing', () => {
    const shared = bytes(1, 2, 3);
    const values: Array<Uint8Array | null> = [null, bytes(), bytes(1), bytes(1, 2), shared, bytes(1, 2, 4)];
    for (const a of values) for (const b of values) for (const c of values) for (const d of values) {
      const left = stream(a ?? bytes(), b), right = stream(c ?? bytes(), d);
      expect(matchingStreamBytes(left, right, budget(), refuse)).toBe(duplicate(left, right));
    }
  });

  it('charges empty-stream comparisons and stops before examining the next stream pair', () => {
    const input = stream(bytes());
    const state = { ...budget(), streams: MAX_PAIRS - 1 };
    expect(matchingStreamBytes(input, input, state, refuse)).toBe(false);
    expect(state).toMatchObject({ streams: MAX_PAIRS, pairs: 0, bytes: 0 });
    expect(() => matchingStreamBytes(input, input, state, refuse)).toThrow(/pair limit/);
  });

  it('charges unequal-length buffer pairs and bounds them independently of stream pairs', () => {
    const left = stream(bytes(1)), right = stream(bytes(1, 2));
    const state = { ...budget(), pairs: MAX_PAIRS - 1 };
    expect(matchingStreamBytes(left, right, state, refuse)).toBe(false);
    expect(state).toMatchObject({ streams: 1, pairs: MAX_PAIRS, bytes: 0 });
    expect(() => matchingStreamBytes(left, right, state, refuse)).toThrow(/pair limit/);
  });

  it('counts the mismatch byte and refuses only when its byte budget cannot establish a result', () => {
    const left = stream(bytes(10, 20, 30)), mismatch = stream(bytes(10, 21, 30)), same = stream(bytes(10, 20, 30));
    const mismatchState = { ...budget(), bytes: MAX_BYTES - 2 };
    expect(matchingStreamBytes(left, mismatch, mismatchState, refuse)).toBe(false);
    expect(mismatchState.bytes).toBe(MAX_BYTES);
    expect(() => matchingStreamBytes(left, same, mismatchState, refuse)).toThrow(/byte limit/);
    const exactState = { ...budget(), bytes: MAX_BYTES - 3 };
    expect(matchingStreamBytes(left, same, exactState, refuse)).toBe(true);
    expect(exactState.bytes).toBe(MAX_BYTES);
    const tooSmall = { ...budget(), bytes: MAX_BYTES - 2 };
    expect(() => matchingStreamBytes(left, same, tooSmall, refuse)).toThrow(/byte limit/);
  });

  it('bounds representation deduplication and reuses a verified result across stream pairs', () => {
    const left = stream(bytes(1, 2, 3), bytes(1, 2, 3));
    const right = stream(bytes(1, 2, 4), bytes(1, 2, 4));
    const state = budget();
    expect(matchingStreamBytes(left, right, state, refuse)).toBe(false);
    expect(state).toMatchObject({ streams: 1, pairs: 3, bytes: 9 });
    expect(matchingStreamBytes(left, right, state, refuse)).toBe(false);
    expect(state).toMatchObject({ streams: 2, pairs: 4, bytes: 12 });
    const nearLimit = { ...budget(), bytes: MAX_BYTES - 2 };
    expect(() => matchingStreamBytes(left, right, nearLimit, refuse)).toThrow(/byte limit/);
  });

  it('does not mutate or detach source bytes when comparison is rejected', () => {
    const buffer = bytes(5, 6, 7, 8);
    const left = stream(buffer.subarray(0, 3), buffer.subarray(1));
    const right = stream(bytes(5, 6, 7));
    const before = buffer.slice();
    expect(() => matchingStreamBytes(left, right, { ...budget(), bytes: MAX_BYTES - 1 }, refuse)).toThrow(/byte limit/);
    expect(buffer).toEqual(before);
    expect(left.rawBytes.buffer).toBe(buffer.buffer);
  });
});
