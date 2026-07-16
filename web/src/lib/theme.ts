// Modo oscuro por defecto según el sistema, con toggle manual persistido.
// Justificación real (del plan): la pre-matrícula se programa de madrugada.
const KEY = 'mikampus-theme';
export type Theme = 'light' | 'dark';

export function getStoredTheme(): Theme | null {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' ? v : null;
}

export function resolveTheme(): Theme {
  return getStoredTheme() ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export function setTheme(theme: Theme) {
  localStorage.setItem(KEY, theme);
  applyTheme(theme);
}
