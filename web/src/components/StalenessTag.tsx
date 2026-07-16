// "actualizado hace 2h · refrescar" — honestidad de estado (principio #6): la
// UI muestra el dato cacheado con su antigüedad en vez de fingir que es en vivo.
function ago(iso: string): string {
  const secs = Math.max(0, (Date.now() - new Date(iso.replace(' ', 'T') + 'Z').getTime()) / 1000);
  if (secs < 60) return 'hace instantes';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `hace ${hrs} h`;
  return `hace ${Math.floor(hrs / 24)} d`;
}

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
