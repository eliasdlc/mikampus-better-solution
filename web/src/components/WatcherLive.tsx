import { useEffect, useState } from 'react';
import { Radar } from 'lucide-react';
import { useSSE } from '../lib/sse.tsx';
import type { AppState } from '../../../src/shared/schemas.ts';
import { WATCHER_LABEL } from './AgentStatus.tsx';
import { ago } from '../lib/time.ts';

// El watcher en vivo.
//
// Vigilar cupos es la función que corre más tiempo y la que menos se veía: una
// línea de texto que decía "ciclo efectivo: cada 45s" y nada más. Alguien
// esperando un cupo a las siete de la mañana no tiene forma de saber si esto
// está trabajando o si se colgó calladito hace veinte minutos — y esa duda, en
// ese momento, es exactamente lo que la app existe para quitar.
//
// Acá se ve: cuánto falta para la próxima consulta (contando en vivo), qué
// materia se está consultando ahora mismo, cuántas van del ciclo, y qué lleva
// hecho desde que se prendió. El anillo no es adorno: es la misma cuenta
// regresiva en forma de posición, que se lee de reojo sin leer un número.

function humanMs(ms: number) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

/**
 * El anillo de progreso hacia la próxima consulta. `nextAt` es el instante en
 * que toca; `spanMs` cuánto dura el ciclo completo, para saber qué fracción ya
 * pasó. Sin `nextAt` no se dibuja progreso: inventar una posición sería peor
 * que no mostrar ninguna.
 */
function ProgressRing({
  nextAt,
  spanMs,
  scanning,
}: {
  nextAt: string | null;
  spanMs: number;
  scanning: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const remaining = nextAt ? Math.max(0, new Date(nextAt).getTime() - now) : null;
  const progress = remaining != null && spanMs > 0 ? Math.min(1, Math.max(0, 1 - remaining / spanMs)) : 0;

  // r = 20 sobre un viewBox de 48: deja 4px de margen para el grosor del trazo.
  const r = 20;
  const circumference = 2 * Math.PI * r;

  return (
    <div className="relative size-14 shrink-0">
      <svg viewBox="0 0 48 48" className="size-full -rotate-90" aria-hidden>
        <circle cx="24" cy="24" r={r} fill="none" strokeWidth="3" className="stroke-line" />
        <circle
          cx="24"
          cy="24"
          r={r}
          fill="none"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
          className={`transition-[stroke-dashoffset] duration-1000 ease-linear ${scanning ? 'stroke-accent' : 'stroke-open'}`}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center">
        <Radar
          className="text-accent size-5"
          aria-hidden
        />
      </span>
    </div>
  );
}

export function WatcherLive({ state }: { state: AppState }) {
  const { watcher: live } = useSSE();
  const persisted = state.watcher;
  if (!persisted) return null;

  const scanning = live.phase === 'scanning';
  const spanMs = persisted.intervalMs || 45_000;

  // Estar encendido no es estar vigilando: un watcher al que se le venció la
  // credencial figura activo y no consulta nada. Mientras no esté sano no se
  // muestra cuenta regresiva ni progreso — un contador corriendo sobre algo que
  // no va a pasar es la peor mentira que puede decir esta tarjeta.
  const healthy = persisted.status === 'running';

  // Mientras escanea, el reloj no cuenta hacia la próxima: cuenta la materia en
  // curso. Mostrar "faltan 0s" durante los diez segundos que tarda un scan es
  // exactamente el momento en que la pantalla parecía trabada.
  const status = scanning
    ? live.courseCode
      ? `consultando ${live.courseCode}`
      : 'abriendo el portal'
    : healthy
      ? 'vigilando'
      : (WATCHER_LABEL[persisted.status] ?? persisted.status);

  if (!healthy && !scanning) {
    return (
      <div className="border-waitlist/40 bg-waitlist/10 space-y-1 rounded-[var(--radius)] border p-2.5">
        <p className="text-waitlist text-xs font-medium">Encendido, pero no está consultando: {status}</p>
        {persisted.pauseReason && <p className="text-muted text-xs">{persisted.pauseReason}</p>}
        <p className="text-muted text-xs">
          {persisted.lastCheckAt ? `Última consulta ${ago(persisted.lastCheckAt)}.` : 'Nunca llegó a consultar.'}{' '}
          {persisted.consecutiveFailures > 0 ? `${persisted.consecutiveFailures} fallo(s) seguidos.` : ''}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <ProgressRing nextAt={persisted.nextCheckAt} spanMs={spanMs} scanning={scanning} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className={`size-2 shrink-0 rounded-full ${
                live.phase === 'error' || persisted.status === 'backing-off'
                  ? 'bg-closed'
                  : scanning
                    ? 'bg-accent'
                    : 'bg-open'
              }`}
              aria-hidden
            />
            <span className="truncate text-sm font-medium">{status}</span>
          </div>

          {/* La cuenta regresiva es el dato que la gente mira. Cuando hay un
              scan en curso se reemplaza por el avance del ciclo, que es lo que
              de verdad está pasando en ese segundo. */}
          {scanning ? (
            <p className="text-muted tabular mt-0.5 text-xs">
              materia {Math.min(live.index + 1, live.total || 1)} de {live.total || 1}
              {live.watching.length > (live.total || 0) ? ` · ${live.watching.length} en rotación` : ''}
            </p>
          ) : (
            <NextCheck nextAt={persisted.nextCheckAt} />
          )}
        </div>
      </div>

      {/* Lo que lleva hecho desde que se abrió la pantalla. Son tres números
          chicos y responden la única pregunta que importa mientras esperás:
          ¿esto está trabajando de verdad? */}
      {(live.checks > 0 || live.scans > 0) && (
        <dl className="border-line grid grid-cols-3 gap-2 rounded-[var(--radius)] border p-2 text-center">
          <Stat label="ciclos" value={live.checks} />
          <Stat label="consultas" value={live.scans} />
          <Stat label="cambios" value={live.changes} tone={live.changes > 0 ? 'text-accent' : undefined} />
        </dl>
      )}

      {live.lastError && <p className="text-closed text-xs">Último fallo: {live.lastError}</p>}

      <p className="text-muted text-xs">
        {persisted.lastCheckAt ? `Última consulta ${ago(persisted.lastCheckAt)}` : 'Todavía sin consultar'}
        {live.elapsedMs != null ? ` · el último ciclo tardó ${humanMs(live.elapsedMs)}` : ''}
      </p>
    </div>
  );
}

function NextCheck({ nextAt }: { nextAt: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (!nextAt) return <p className="text-muted mt-0.5 text-xs">esperando el primer ciclo…</p>;

  const remaining = Math.max(0, Math.floor((new Date(nextAt).getTime() - now) / 1000));
  // Cero no es "ya": es "le toca en el próximo latido del agente". Decir 00:00
  // fijo durante varios segundos se lee como colgado.
  if (remaining === 0) return <p className="text-muted mt-0.5 text-xs">consultando en breve…</p>;

  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    <p className="text-muted tabular mt-0.5 font-mono text-xs">
      próxima consulta en {remaining >= 3600 ? `${Math.floor(remaining / 3600)}:` : ''}
      {pad(Math.floor((remaining % 3600) / 60))}:{pad(remaining % 60)}
    </p>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div>
      <dd className={`font-display tabular text-lg font-semibold tracking-tight ${tone ?? ''}`}>{value}</dd>
      <dt className="text-muted text-[10px] tracking-wide uppercase">{label}</dt>
    </div>
  );
}
