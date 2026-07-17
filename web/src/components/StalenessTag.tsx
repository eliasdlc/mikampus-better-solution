import { ago } from '../lib/time.ts';

// "actualizado hace 2h · refrescar" — honestidad de estado (principio #6): la
// UI muestra el dato cacheado con su antigüedad en vez de fingir que es en vivo.

export function StalenessTag({ at, onRefresh, refreshing }: { at: string | null; onRefresh?: () => void; refreshing?: boolean }) {
  return (
    <span className="text-muted inline-flex items-center gap-1.5 text-xs">
      {at ? `actualizado ${ago(at)}` : 'sin datos aún'}
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="hover:text-fg underline underline-offset-2 disabled:opacity-50"
        >
          {refreshing ? 'actualizando…' : 'refrescar'}
        </button>
      )}
    </span>
  );
}
