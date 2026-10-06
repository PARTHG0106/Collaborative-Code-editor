import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { IDEThemeProvider, useTheme as useIDETheme } from '../components/ide/IDEThemeProvider';
import { ThemeProvider, useTheme } from './ThemeContext';

let systemIsDark = false;
let systemListeners: Set<() => void>;

function changeSystemTheme(dark: boolean) {
  act(() => {
    systemIsDark = dark;
    systemListeners.forEach(listener => listener());
  });
}

function Controls({ label = 'Site' }: { label?: string }) {
  const { theme, toggleTheme } = useTheme();
  return <button onClick={toggleTheme}>{label}: {theme}</button>;
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('dark');
  document.documentElement.style.colorScheme = '';
  systemIsDark = false;
  systemListeners = new Set();
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    get matches() { return systemIsDark; },
    addEventListener: (_event: string, listener: () => void) => systemListeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => systemListeners.delete(listener),
  })));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.classList.remove('dark');
  document.documentElement.style.colorScheme = '';
});

describe('shared site and editor theme', () => {
  it.each(['light', 'dark'] as const)('restores an existing %s editor preference before rendering controls', theme => {
    systemIsDark = theme === 'light';
    localStorage.setItem('ide-theme', theme);

    render(<ThemeProvider><Controls /></ThemeProvider>);

    expect(screen.getByRole('button', { name: `Site: ${theme}` })).toBeInTheDocument();
    expect(document.documentElement.classList.contains('dark')).toBe(theme === 'dark');
    expect(document.documentElement.style.colorScheme).toBe(theme);
  });

  it('follows OS changes until the user chooses a theme, and restores that choice after a reload', () => {
    const view = render(<ThemeProvider><Controls /></ThemeProvider>);
    expect(screen.getByRole('button', { name: 'Site: light' })).toBeInTheDocument();
    expect(localStorage.getItem('ide-theme')).toBeNull();

    changeSystemTheme(true);
    fireEvent.click(screen.getByRole('button', { name: 'Site: dark' }));
    expect(localStorage.getItem('ide-theme')).toBe('light');
    changeSystemTheme(false);
    changeSystemTheme(true);
    expect(screen.getByRole('button', { name: 'Site: light' })).toBeInTheDocument();

    view.unmount();
    render(<ThemeProvider><Controls /></ThemeProvider>);
    expect(screen.getByRole('button', { name: 'Site: light' })).toBeInTheDocument();
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('shares editor changes with the site across route navigation, including when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    function EditorControls() {
      const { theme, toggleTheme } = useIDETheme();
      return <button onClick={toggleTheme}>Editor: {theme}</button>;
    }

    render(
      <React.StrictMode>
        <ThemeProvider>
          <Controls />
          <MemoryRouter>
            <Link to="/">Home</Link>
            <Link to="/editor">Workspace</Link>
            <Routes>
              <Route path="/" element={<p>Home page</p>} />
              <Route path="/editor" element={<IDEThemeProvider><EditorControls /></IDEThemeProvider>} />
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      </React.StrictMode>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Site: light' }));
    fireEvent.click(screen.getByRole('link', { name: 'Workspace' }));
    expect(screen.getByRole('button', { name: 'Editor: dark' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Editor: dark' }));
    expect(screen.getByRole('button', { name: 'Site: light' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Home' }));
    expect(document.documentElement).not.toHaveClass('dark');
    expect(screen.getByRole('button', { name: 'Site: light' })).toBeInTheDocument();
    expect(systemListeners.size).toBe(1);
  });

  it('syncs another tab’s preference and resumes OS defaults when that preference is cleared', () => {
    systemIsDark = true;
    const view = render(<ThemeProvider><Controls /></ThemeProvider>);
    act(() => window.dispatchEvent(new StorageEvent('storage', {
      key: 'ide-theme', newValue: 'light', storageArea: localStorage,
    })));
    expect(screen.getByRole('button', { name: 'Site: light' })).toBeInTheDocument();
    expect(document.documentElement).not.toHaveClass('dark');

    act(() => window.dispatchEvent(new StorageEvent('storage', {
      key: 'unrelated-setting', newValue: 'dark', storageArea: localStorage,
    })));
    act(() => window.dispatchEvent(new StorageEvent('storage', {
      key: 'ide-theme', newValue: 'dark', storageArea: sessionStorage,
    })));
    expect(screen.getByRole('button', { name: 'Site: light' })).toBeInTheDocument();

    act(() => window.dispatchEvent(new StorageEvent('storage', {
      key: null, newValue: null, storageArea: localStorage,
    })));
    expect(screen.getByRole('button', { name: 'Site: dark' })).toBeInTheDocument();
    expect(document.documentElement).toHaveClass('dark');
    view.unmount();
    expect(systemListeners.size).toBe(0);
  });

  it('uses OS defaults for invalid saved values and supports standalone editor rendering', () => {
    systemIsDark = true;
    localStorage.setItem('ide-theme', 'invalid');
    render(<IDEThemeProvider><Controls label="Editor" /></IDEThemeProvider>);
    expect(screen.getByRole('button', { name: 'Editor: dark' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Editor: dark' }));
    expect(localStorage.getItem('ide-theme')).toBe('light');
    expect(document.documentElement).not.toHaveClass('dark');
  });
});
