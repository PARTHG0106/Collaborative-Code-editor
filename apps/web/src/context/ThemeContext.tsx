import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react';

export type Theme = 'light' | 'dark';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
}

// Keep the editor's existing preference so returning users retain their theme.
const THEME_STORAGE_KEY = 'ide-theme';
const SYSTEM_THEME_QUERY = '(prefers-color-scheme: dark)';
const ThemeContext = createContext<ThemeContextType | null>(null);

function parseTheme(value: string | null): Theme | null {
  return value === 'light' || value === 'dark' ? value : null;
}

function savedTheme(): Theme | null {
  try {
    return parseTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  return typeof window.matchMedia === 'function' && window.matchMedia(SYSTEM_THEME_QUERY).matches ? 'dark' : 'light';
}

export function useTheme(): ThemeContextType {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within ThemeProvider');
  return context;
}

const RootThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [preference, setPreference] = useState<Theme | null>(savedTheme);
  const [system, setSystem] = useState<Theme>(systemTheme);
  const theme = preference ?? system;

  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(SYSTEM_THEME_QUERY);
    const updateSystem = () => setSystem(media.matches ? 'dark' : 'light');
    updateSystem();
    media.addEventListener('change', updateSystem);
    return () => media.removeEventListener('change', updateSystem);
  }, []);

  useEffect(() => {
    const updatePreference = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
      // Session storage can also emit storage events for embedded documents.
      if (event.storageArea) {
        try {
          if (event.storageArea !== window.localStorage) return;
        } catch {
          return;
        }
      }
      setPreference(parseTheme(event.newValue));
    };
    window.addEventListener('storage', updatePreference);
    return () => window.removeEventListener('storage', updatePreference);
  }, []);

  const setTheme = useCallback((nextTheme: Theme) => {
    setPreference(nextTheme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // A blocked/full storage area must not prevent changing this session's theme.
    }
  }, []);

  const toggleTheme = useCallback(() => setTheme(theme === 'dark' ? 'light' : 'dark'), [setTheme, theme]);
  const value = useMemo(() => ({ theme, setTheme, toggleTheme }), [theme, setTheme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const parent = useContext(ThemeContext);
  // Standalone IDE renders still work; app routes share one owner and preference.
  return parent ? <>{children}</> : <RootThemeProvider>{children}</RootThemeProvider>;
};
