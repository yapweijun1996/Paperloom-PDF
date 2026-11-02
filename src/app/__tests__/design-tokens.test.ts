// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '..', 'globals.css'), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`Missing token block: ${selector}`);
  const open = css.indexOf('{', start);
  return css.slice(open + 1, css.indexOf('}', open));
}

function declarations(body: string): Map<string, string> {
  return new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]));
}

const light = declarations(block(':root,\n[data-theme="light"] {'));
const darkOverrides = declarations(block('[data-theme="dark"] {'));
const theme = declarations(block('@theme inline {'));
const dark = new Map([...light, ...darkOverrides]);

/** Same value in both themes, so the dark block intentionally omits them. */
const THEME_INVARIANT = new Set([
  '--bloom-50', '--bloom-200', '--bloom-300', '--bloom-400', '--bloom-500',
  '--bloom-600', '--bloom-700', '--bloom-800', '--bloom-900', '--on-accent',
]);

const SEMANTIC = [
  '--danger', '--danger-soft', '--warning', '--warning-soft', '--success', '--success-soft',
  '--info', '--info-soft', '--on-accent', '--focus-ring',
];

function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`Expected an opaque #RRGGBB colour, got ${hex}`);
  const [r, g, b] = [0, 2, 4].map(offset => parseInt(match[1].slice(offset, offset + 2), 16) / 255)
    .map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const max = Math.max(r, g, b), delta = max - Math.min(r, g, b);
  if (!delta) return 0;
  const sector = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return (sector * 60 + 360) % 360;
}

const hueDistance = (a: string, b: string) => {
  const distance = Math.abs(hue(a) - hue(b));
  return Math.min(distance, 360 - distance);
};

// [foreground, background, minimum ratio]: 4.5 for text (WCAG 1.4.3), 3 for UI indicators (1.4.11).
const PAIRS: [string, string, number][] = [
  ['--text', '--panel', 4.5], ['--text', '--surface', 4.5], ['--text', '--panel-elevated', 4.5],
  ['--text-muted', '--panel', 4.5],
  ['--accent', '--panel', 4.5], ['--accent', '--bloom-100', 4.5],
  ['--on-accent', '--bloom-500', 4.5], ['--on-accent', '--bloom-600', 4.5], ['--on-accent', '--bloom-700', 4.5],
  ['--focus-ring', '--panel', 3], ['--focus-ring', '--surface', 3], ['--focus-ring', '--panel-elevated', 3],
  ...(['danger', 'warning', 'success', 'info'] as const).flatMap(tone => [
    [`--${tone}`, '--panel', 4.5], [`--${tone}`, '--surface', 4.5],
    [`--${tone}`, '--panel-elevated', 4.5], [`--${tone}`, `--${tone}-soft`, 4.5],
  ] as [string, string, number][]),
];

describe('design tokens in globals.css', () => {
  it('defines every theme-dependent token in both light and dark blocks', () => {
    const missingInDark = [...light.keys()].filter(name => !THEME_INVARIANT.has(name) && !darkOverrides.has(name));
    const missingInLight = [...darkOverrides.keys()].filter(name => !light.has(name));
    const staleInvariants = [...THEME_INVARIANT].filter(name => !light.has(name) || darkOverrides.has(name));
    expect({ missingInDark, missingInLight, staleInvariants }).toEqual({ missingInDark: [], missingInLight: [], staleInvariants: [] });
  });

  it('exposes every semantic token through an @theme alias', () => {
    for (const name of SEMANTIC) {
      expect(light.has(name), `${name} defined`).toBe(true);
      expect(theme.get(`--color-${name.slice(2)}`), `${name} alias`).toBe(`var(${name})`);
    }
  });

  it('maps every @theme alias to a defined token', () => {
    for (const [alias, value] of theme) {
      const target = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
      expect(target && light.has(target), `${alias}: ${value}`).toBe(true);
    }
  });

  for (const [name, values] of [['light', light], ['dark', dark]] as const) {
    it(`meets contrast minimums in the ${name} theme`, () => {
      const failures = PAIRS.flatMap(([fg, bg, minimum]) => {
        const ratio = contrast(values.get(fg)!, values.get(bg)!);
        return ratio >= minimum ? [] : [`${fg} on ${bg}: ${ratio.toFixed(2)} < ${minimum}`];
      });
      expect(failures).toEqual([]);
    });

    it(`keeps success distinguishable from the jade brand in the ${name} theme`, () => {
      for (const brand of ['--accent', '--bloom-500']) {
        expect(hueDistance(values.get('--success')!, values.get(brand)!), brand).toBeGreaterThanOrEqual(25);
      }
    });
  }
});
