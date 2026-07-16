import { useState } from 'react';
import { resolveTheme, setTheme, type Theme } from '../lib/theme.ts';

export function ThemeToggle() {
  const [theme, set] = useState<Theme>(resolveTheme());
  const next = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      onClick={() => {
        setTheme(next);
        set(next);
      }}
      className="border-line hover:bg-surface-2 rounded-[var(--radius)] border px-2 py-1 text-xs transition-colors duration-100"
      title={`Cambiar a modo ${next === 'dark' ? 'oscuro' : 'claro'}`}
    >
      {theme === 'dark' ? '🌙' : '☀️'}
    </button>
  );
}
