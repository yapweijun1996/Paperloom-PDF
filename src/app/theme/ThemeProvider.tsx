'use client';

import React, { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { DARK_SCHEME_QUERY, resolveTheme, STORAGE_KEY, type ThemeMode } from './initialTheme';

export type { ThemeMode };

interface ThemeContextValue {
  theme: ThemeMode;
  setTheme: (mode: ThemeMode) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'light',
  setTheme: () => {},
  toggleTheme: () => {},
});

function applyTheme(mode: ThemeMode) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', mode);
  document.documentElement.style.colorScheme = mode;
}

function darkSchemeQuery(): MediaQueryList | null {
  try {
    return typeof window.matchMedia === 'function' ? window.matchMedia(DARK_SCHEME_QUERY) : null;
  } catch {
    return null;
  }
}

/** An explicit choice (this session or stored) wins; with none, the OS scheme is followed live. */
function createThemeStore() {
  let selected: ThemeMode | null = null;
  let query: MediaQueryList | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(listener => listener());
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        query = darkSchemeQuery();
        query?.addEventListener('change', notify);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          query?.removeEventListener('change', notify);
          query = null;
        }
      };
    },
    getSnapshot(): ThemeMode {
      if (selected) return selected;
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(STORAGE_KEY);
      } catch {
        /* Storage unavailable: follow the system scheme. */
      }
      return resolveTheme(stored, darkSchemeQuery()?.matches ?? false);
    },
    select(mode: ThemeMode) {
      selected = mode;
      try {
        localStorage.setItem(STORAGE_KEY, mode);
      } catch {
        /* Keep the selected theme for this session. */
      }
      notify();
    },
  };
}

function serverTheme(): ThemeMode { return 'light'; }

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [store] = useState(createThemeStore);
  const theme = useSyncExternalStore(store.subscribe, store.getSnapshot, serverTheme);

  useEffect(() => {
    // During hydration, use the resolved value rather than the server snapshot.
    applyTheme(store.getSnapshot());
  }, [store, theme]);

  const setTheme = useCallback((mode: ThemeMode) => {
    store.select(mode);
    applyTheme(mode);
  }, [store]);

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
