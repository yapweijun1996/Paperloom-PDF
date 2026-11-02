// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DARK_SCHEME_QUERY, resolveTheme, STORAGE_KEY, THEME_BOOT_SCRIPT, THEME_COLORS } from './initialTheme';

describe('resolveTheme', () => {
  it.each([null, '', 'invalid', 'system', 'DARK'])('follows the system scheme for %j', (stored) => {
    expect(resolveTheme(stored, false)).toBe('light');
    expect(resolveTheme(stored, true)).toBe('dark');
  });

  it.each(['dark', 'light'] as const)('lets a stored %s choice win over the system scheme', (stored) => {
    expect(resolveTheme(stored, false)).toBe(stored);
    expect(resolveTheme(stored, true)).toBe(stored);
  });
});

describe('THEME_BOOT_SCRIPT', () => {
  const descriptors = {
    localStorage: Object.getOwnPropertyDescriptor(window, 'localStorage'),
    matchMedia: Object.getOwnPropertyDescriptor(window, 'matchMedia'),
  };

  afterEach(() => {
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(window, name, descriptor);
    }
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.colorScheme = '';
  });

  function boot(stored: string | null | Error, prefersDark: boolean | Error) {
    const getItem = vi.fn((key: string) => {
      if (stored instanceof Error) throw stored;
      return key === STORAGE_KEY ? stored : null;
    });
    const matchMedia = vi.fn((query: string) => {
      if (prefersDark instanceof Error) throw prefersDark;
      return { matches: query === DARK_SCHEME_QUERY && prefersDark };
    });
    Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem } });
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: matchMedia });
    new Function(THEME_BOOT_SCRIPT)();
    const root = document.documentElement;
    return { theme: root.getAttribute('data-theme'), scheme: root.style.colorScheme };
  }

  it.each([
    [null, false, 'light'], [null, true, 'dark'],
    ['light', true, 'light'], ['dark', false, 'dark'],
    ['light', false, 'light'], ['dark', true, 'dark'],
    ['bogus', true, 'dark'],
  ] as const)('stored %j with system dark=%s paints %s', (stored, prefersDark, expected) => {
    expect(boot(stored, prefersDark)).toEqual({ theme: expected, scheme: expected });
  });

  it('falls back to the system scheme when storage throws, and to light when matchMedia throws', () => {
    expect(boot(new Error('blocked'), true).theme).toBe('dark');
    expect(boot(null, new Error('unsupported')).theme).toBe('light');
  });
});

describe('THEME_COLORS', () => {
  it('mirrors the --panel token of each theme in globals.css', () => {
    const css = readFileSync(join(__dirname, '..', 'globals.css'), 'utf8');
    const panel = (selector: string) => {
      const start = css.indexOf(selector);
      const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
      return /--panel:\s*([^;]+);/.exec(body)?.[1].trim().toUpperCase();
    };
    expect(THEME_COLORS.light.toUpperCase()).toBe(panel(':root,\n[data-theme="light"] {'));
    expect(THEME_COLORS.dark.toUpperCase()).toBe(panel('[data-theme="dark"] {'));
  });
});
