// @vitest-environment node
// Ratchet: raw Tailwind palette classes in JSX className expressions may only
// decrease. Use the theme tokens in globals.css (bg-panel, text-app-muted,
// text-danger, ...) instead. Document/content colours (swatch hex arrays, canvas
// ctx, SVG art) are not className strings and are out of scope.
//
// Limitation: the shared walker expands string literals, templates, ternaries,
// `&&` and `+` inside className attributes. Classes stored in variables, maps or
// helper calls and passed in by identifier are not counted.
//
// To lower the baseline after a migration:
//   UPDATE_PALETTE_BASELINE=1 npx vitest run src/app/__tests__/palette-classes.guard.test.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { classBranches, openings, parseSource, sourceFiles } from '../editor/__tests__/classNames';

const APP = join(__dirname, '..');
const BASELINE = join(__dirname, 'palette-classes.baseline.json');

const PALETTE = 'zinc|slate|gray|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const OPACITY = '(?:/(?:\\d+|\\[[^\\]]+\\]))?';
const RAW_PALETTE = new RegExp(
  `^(?:(?:bg|text|border(?:-[trblxyse])?|ring|from|via|to|fill|stroke|divide|outline|placeholder|shadow)-(?:${PALETTE})-\\d{2,3}` +
  `|(?:bg|text)-(?:white|black))${OPACITY}$`,
);

/** Strip variants (`hover:`, `md:`, `dark:`…) and the important flag before matching. */
function isRawPaletteClass(token: string): boolean {
  const utility = token.slice(token.lastIndexOf(':') + 1).replace(/^!|!$/g, '');
  return RAW_PALETTE.test(utility);
}

function countFile(file: string): number {
  let count = 0;
  for (const opening of openings(parseSource(file))) {
    for (const property of opening.attributes.properties) {
      if (!ts.isJsxAttribute(property) || !/className$/i.test(property.name.getText())) continue;
      // Union across expanded branches so a shared template prefix counts once.
      const hits = new Set(classBranches(property.initializer)
        .flatMap(branch => branch.split(/\s+/))
        .filter(isRawPaletteClass));
      count += hits.size;
    }
  }
  return count;
}

function currentCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of sourceFiles(APP)) {
    if (file.includes(`${sep}__tests__${sep}`)) continue;
    const count = countFile(file);
    if (count) counts[relative(APP, file).split(sep).join('/')] = count;
  }
  return counts;
}

describe('raw Tailwind palette classes (ratchet)', () => {
  it('recognises palette utilities and ignores tokens', () => {
    for (const token of ['bg-zinc-800', 'hover:text-red-400', 'md:border-t-zinc-700/80', 'bg-black/50', 'text-white', '!bg-emerald-500', 'bg-white/[0.04]']) {
      expect(isRawPaletteClass(token), token).toBe(true);
    }
    for (const token of ['bg-panel', 'text-app-muted', 'text-danger', 'bg-bloom-500', 'border-white', 'text-[10px]', 'bg-[var(--border)]', 'z-10']) {
      expect(isRawPaletteClass(token), token).toBe(false);
    }
  });

  it('never exceeds the per-file baseline', () => {
    const counts = currentCounts();
    if (process.env.UPDATE_PALETTE_BASELINE) {
      // One-way: only lowers existing entries and drops files that reach zero.
      const previous = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, number>;
      const lowered = Object.fromEntries(Object.entries(previous)
        .map(([file, allowed]) => [file, Math.min(allowed, counts[file] ?? 0)] as const)
        .filter(([, allowed]) => allowed > 0));
      writeFileSync(BASELINE, `${JSON.stringify(lowered, null, 2)}\n`);
    }
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, number>;
    const regressions = Object.entries(counts).flatMap(([file, count]) => {
      const allowed = baseline[file] ?? 0;
      return count > allowed ? [`${file}: ${count} raw palette classes (baseline ${allowed}); use theme tokens instead`] : [];
    });
    const improved = Object.entries(baseline).filter(([file, allowed]) => (counts[file] ?? 0) < allowed);
    if (improved.length) {
      console.info(`Palette ratchet: ${improved.map(([file, allowed]) => `${file} ${allowed}→${counts[file] ?? 0}`).join(', ')}. ` +
        'Lower the baseline with UPDATE_PALETTE_BASELINE=1.');
    }
    expect(regressions).toEqual([]);
  });
});
