import { useCallback, useState } from 'react';

export type Theme = 'light' | 'dark';

export function useTheme(): { theme: Theme; toggle(): void } {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  );

  const toggle = useCallback(() => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('claimlens-theme', next);
    } catch {
      // Storage can be unavailable (private mode); the toggle still works for this visit.
    }
    setTheme(next);
  }, [theme]);

  return { theme, toggle };
}
