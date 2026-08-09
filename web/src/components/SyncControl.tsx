import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { fetchSyncState, runSync, setSyncInterval, type SyncResult, type SyncState } from '../lib/api.ts';
import { ago } from '../lib/time.ts';

// El control global de sincronización (P1). Antes "actualizar" era un botón que
// no decía qué hacía: no se sabía qué estaba viejo, qué se había omitido ni por
// qué. Acá hay dos acciones con significados distintos y una lista que responde
// esas preguntas sin abrir la consola.
//
//   Actualizar lo necesario — solo las fuentes vencidas. Es el gesto barato.
//   Actualizar todo ahora   — fuerza también lo vigente. No evade el
//                             consentimiento ni la prioridad de una inscripción.

const STATUS_LABEL: Record<SyncResult['status'], string> = {
  updated: 'actualizado',
  fresh: 'ya estaba al día',
  skipped: 'omitido',
  paused: 'en pausa',
  error: 'falló',
};

// Los colores de alarma se reservan para lo que de verdad exige una acción: un
// dato viejo o una fuente que no aplica hoy no son un problema.
function dotClass(status: string | null, expired: boolean, relevant: boolean) {
  if (status === 'error') return 'bg-closed';
  if (!relevant) return 'bg-line';
  if (status === 'paused') return 'bg-waitlist';
  if (expired) return 'bg-waitlist';
  return 'bg-open';
}

// El techo de frescura. Una hora es el default porque es el ritmo al que la
// información de PeopleSoft deja de servir para decidir algo sin dejar de ser
// razonable con el portal. "Natural" no es apagar la sincronización: es dejar
// que cada fuente use su propia frescura (el carrito diez minutos, el avance una
// semana) en vez de imponerles un techo común.
const INTERVAL_OPTIONS: { ms: number; label: string }[] = [
  { ms: 900_000, label: '15 min' },
  { ms: 1_800_000, label: '30 min' },
  { ms: 3_600_000, label: '1 h' },
  { ms: 21_600_000, label: '6 h' },
  { ms: 86_400_000, label: '24 h' },
  { ms: 0, label: 'natural' },
];

function sourceNote(source: SyncState['sources'][number]) {
  if (source.error) return source.error;
  if (!source.relevant) return 'no aplica en este momento del ciclo';
  if (source.syncedAt) return `actualizado ${ago(source.syncedAt)}`;
  return 'sin datos aún';
}

export function SyncControl() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['sync'],
    queryFn: fetchSyncState,
    // El mismo minuto que el tick del backend: la UI no adivina el estado, lo
    // relee. Es una query a SQLite, no una consulta al portal.
    refetchInterval: 60_000,
  });

  const sync = useMutation({
    mutationFn: (force: boolean) => runSync({ force }),
    onSuccess: ({ state }) => {
      queryClient.setQueryData(['sync'], state);
      // Las invalidaciones finas ya llegaron por SSE (`sync-source`); esto cubre
      // el caso de una respuesta que llega antes que su evento.
      queryClient.invalidateQueries({ queryKey: ['account-overview'] });
    },
  });

  const interval = useMutation({
    mutationFn: setSyncInterval,
    onSuccess: (state) => queryClient.setQueryData(['sync'], state),
  });

  const sources = data?.sources ?? [];
  const pending = sources.filter((source) => source.expired && source.relevant);
  const failing = sources.filter((source) => source.lastStatus === 'error');
  const busy = sync.isPending || Boolean(data?.running);

  const summary = data?.hold
    ? data.hold
    : failing.length
      ? `${failing.length} fuente(s) con error`
      : pending.length
        ? `${pending.length} por actualizar`
        : 'todo al día';

  return (
    <details className="group order-5 w-full md:order-none">
      <summary className="text-muted hover:text-fg flex cursor-pointer list-none items-center gap-1.5 text-xs marker:content-none">
        <RefreshCw className={`size-3 shrink-0 ${busy ? 'animate-spin' : ''}`} aria-hidden />
        <span className="truncate">{busy ? 'actualizando…' : summary}</span>
      </summary>

      <div className="border-line mt-2 space-y-3 rounded-[var(--radius)] border p-2.5">
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => sync.mutate(false)}
            disabled={busy}
            className="border-line hover:bg-surface-2 rounded-[var(--radius)] border px-2 py-1 text-xs disabled:opacity-50"
          >
            Actualizar lo necesario
          </button>
          <button
            type="button"
            onClick={() => sync.mutate(true)}
            disabled={busy}
            className="border-line hover:bg-surface-2 rounded-[var(--radius)] border px-2 py-1 text-xs disabled:opacity-50"
          >
            Actualizar todo ahora
          </button>
        </div>

        {/* Cada cuánto se releen los datos de PeopleSoft. No dispara nada: mueve
            la línea a partir de la cual el tick del agente sí lo hará. */}
        <div>
          <p className="text-muted mb-1 text-xs">Refrescar lo scrapeado cada</p>
          <div className="flex flex-wrap gap-1">
            {INTERVAL_OPTIONS.map((option) => (
              <button
                key={option.ms}
                type="button"
                aria-pressed={(data?.interval.ms ?? 3_600_000) === option.ms}
                disabled={interval.isPending}
                onClick={() => interval.mutate(option.ms)}
                title={
                  option.ms === 0
                    ? 'Cada fuente conserva su propia frescura: el carrito 10 min, el avance una semana.'
                    : `Nada scrapeado se queda más viejo que ${option.label}.`
                }
                className={`tabular min-h-7 rounded-full px-2 py-0.5 font-mono text-[11px] transition-colors duration-100 disabled:opacity-50 ${
                  (data?.interval.ms ?? 3_600_000) === option.ms
                    ? 'bg-accent text-accent-fg font-medium'
                    : 'border-line text-muted hover:text-fg border'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          {interval.error && <p className="text-closed mt-1 text-xs">{(interval.error as Error).message}</p>}
        </div>

        {/* Una pausa no es un fallo: el dato cacheado sigue sirviendo y acá se
            dice exactamente qué falta para volver a consultar. */}
        {data?.hold && <p className="text-waitlist text-xs">{data.hold}</p>}

        <ul className="space-y-1.5">
          {sources.map((source) => (
            <li key={source.key} className="flex items-start gap-2 text-xs">
              <span
                className={`mt-1 size-1.5 shrink-0 rounded-full ${dotClass(source.lastStatus, source.expired, source.relevant)}`}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className="text-fg">{source.label}</span>
                <span className="text-muted block truncate">{sourceNote(source)}</span>
              </span>
            </li>
          ))}
        </ul>

        {/* Qué hizo la última corrida, fuente por fuente: qué actualizó, qué
            omitió y por qué. Es la respuesta al "¿y eso qué hizo?". */}
        {sync.data && (
          <ul className="border-line space-y-1 border-t pt-2">
            {sync.data.results.map((result) => (
              <li key={result.key} className="text-muted text-xs">
                <span className="text-fg">{result.label}</span>: {STATUS_LABEL[result.status]}
                {result.reason ? ` — ${result.reason}` : ''}
                {result.error ? ` — ${result.error}` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
