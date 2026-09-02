import { useEffect, useState } from 'react';

// Honestidad de estado (principio #6): las operaciones vivas contra PeopleSoft
// tardan segundos (Playwright detrás). En vez de un spinner genérico, este
// banner muestra el paso actual y el tiempo transcurrido.
export function LiveOpBanner({ active, message }: { active: boolean; message: string }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!active) return;
    setElapsed(0);
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250);
    return () => clearInterval(t);
  }, [active]);

  if (!active) return null;
  return (
    <div className="border-accent/40 bg-accent/10 flex items-center gap-3 rounded-[var(--radius)] border px-3 py-2 text-sm">
      <span className="bg-accent size-2 shrink-0 rounded-full" aria-hidden />
      <span className="flex-1">{message}</span>
      <span className="tabular text-muted font-mono text-xs">{elapsed}s</span>
    </div>
  );
}
