'use client';

import React, { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { resolveInitialTheme, STORAGE_KEY } from './initialTheme';

export type ThemeMode = 'dark' | 'light';

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

function createThemeStore() {
  let selected: ThemeMode | null = null;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot(): ThemeMode {
      if (selected) return selected;
      try {
        return resolveInitialTheme(localStorage.getItem(STORAGE_KEY));
      } catch {
        return 'light';
      }
    },
    select(mode: ThemeMode) {
      selected = mode;
      try {
        localStorage.setItem(STORAGE_KEY, mode);
      } catch {
        /* Keep the selected theme for this session. */
      }
      listeners.forEach(listener => listener());
    },
  };
}

function serverTheme(): ThemeMode { return 'light'; }

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [store] = useState(createThemeStore);
  const theme = useSyncExternalStore(store.subscribe, store.getSnapshot, serverTheme);

  useEffect(() => {
    // During hydration, use the stored value rather than the server snapshot.
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
