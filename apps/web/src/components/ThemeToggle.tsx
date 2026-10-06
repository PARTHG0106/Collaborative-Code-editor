import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';
  const label = `Switch to ${isDark ? 'light' : 'dark'} mode`;

  return (
    <button
      type="button"
      className="site-button site-theme-toggle"
      onClick={toggleTheme}
      aria-label={label}
      title={label}
    >
      {isDark ? <Sun size={17} aria-hidden="true" /> : <Moon size={17} aria-hidden="true" />}
      <span className="site-theme-toggle-label">{isDark ? 'Light' : 'Dark'}</span>
    </button>
  );
}
