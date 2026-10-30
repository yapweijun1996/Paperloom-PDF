import { describe, expect, it } from 'vitest';
import { coversRectangle, type Bounds } from '../security/redaction/rectangle-coverage';

describe('rectangle coverage', () => {
  it('agrees with an independent cell-by-cell integer-grid check', () => {
    const target = { minX: 1, minY: 1, maxX: 5, maxY: 5 };
    let seed = 48271;
    const random = (limit: number) => {
      seed = (seed * 16807) % 2147483647;
      return seed % limit;
    };

    for (let trial = 0; trial < 50_000; trial++) {
      const areas: Bounds[] = Array.from({ length: random(9) }, () => {
        const x = random(6), y = random(6);
        return { minX: x, minY: y, maxX: x + 1 + random(6 - x), maxY: y + 1 + random(6 - y) };
      });
      let expected = true;
      for (let x = target.minX; x < target.maxX; x++) {
        for (let y = target.minY; y < target.maxY; y++) {
          if (!areas.some(area => area.minX <= x && area.maxX >= x + 1 &&
              area.minY <= y && area.maxY >= y + 1)) expected = false;
        }
      }
      if (coversRectangle(areas, target) !== expected) {
        throw new Error(`Coverage mismatch in deterministic trial ${trial}: ${JSON.stringify(areas)}`);
      }
    }
  });

  it('rejects representable floating-point gaps and accepts exact seams', () => {
    const target = { minX: 0, minY: 0, maxX: 2, maxY: 2 };
    const left = { minX: 0, minY: 0, maxX: 1, maxY: 2 };
    const right = { minX: 1, minY: 0, maxX: 2, maxY: 2 };
    expect(coversRectangle([left, right], target)).toBe(true);
    expect(coversRectangle([left, { ...right, minX: 1 + Number.EPSILON }], target)).toBe(false);
    const lower = { minX: 0, minY: 0, maxX: 2, maxY: 1 };
    const upper = { minX: 0, minY: 1 + Number.EPSILON, maxX: 2, maxY: 2 };
    expect(coversRectangle([lower, upper], target)).toBe(false);
  });
});
