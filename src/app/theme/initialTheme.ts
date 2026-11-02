export const STORAGE_KEY = 'pdf-editor-theme';
export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

export type ThemeMode = 'light' | 'dark';

/** Browser chrome colours; they mirror `--panel` in globals.css (initialTheme.test.ts checks parity). */
export const THEME_COLORS: Readonly<Record<ThemeMode, string>> = { light: '#FFFFFF', dark: '#0A0B0E' };

/**
 * The single theme resolver. An explicit stored choice wins; otherwise follow
 * the operating system. It must stay self-contained (no outer references):
 * THEME_BOOT_SCRIPT embeds its source text.
 */
// Serialised into THEME_BOOT_SCRIPT, so it must not carry coverage counters.
/* istanbul ignore next -- @preserve */
export function resolveTheme(stored: string | null, prefersDark: boolean): ThemeMode {
  if (stored === 'light' || stored === 'dark') return stored;
  return prefersDark ? 'dark' : 'light';
}

/** Inline <head> script that applies the theme before first paint. Storage or matchMedia failures fall back safely. */
export const THEME_BOOT_SCRIPT = '(function(){' +
  `var resolve=${resolveTheme.toString()};` +
  `var stored=null;try{stored=localStorage.getItem(${JSON.stringify(STORAGE_KEY)})}catch(e){}` +
  `var dark=false;try{dark=!!(window.matchMedia&&window.matchMedia(${JSON.stringify(DARK_SCHEME_QUERY)}).matches)}catch(e){}` +
  'var theme=resolve(stored,dark);var root=document.documentElement;' +
  'root.setAttribute("data-theme",theme);root.style.colorScheme=theme})()';
