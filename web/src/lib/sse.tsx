import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from './auth.tsx';

// Actividad en vivo del backend (operaciones Playwright, watcher, scheduler)
// vía el SSE existente. Además de alimentar el feed de actividad, empuja los
// datos frescos al cache de TanStack Query: cuando llega un 'cart-status' del
// watcher, el carrito de toda la app se actualiza sin refetch.
export type LogLine = { id: number; time: string; text: string; kind: 'info' | 'success' | 'error' };
type EnrollResult = { classLabel: string; message: string; success: boolean };

// Lo que el watcher está haciendo AHORA. El estado persistido (/api/state) dice
// cómo quedó la última consulta; esto dice qué está pasando mientras pasa, que
// es lo único que convierte una espera de minutos en algo que se puede mirar.
//
// Los contadores son de la sesión abierta, no del histórico: responden "¿esto
// está trabajando desde que lo prendí?", que es la pregunta que se hace alguien
// mirando la pantalla a las 6:58 de la mañana.
export type WatcherActivity = {
  phase: 'idle' | 'scanning' | 'done' | 'error';
  courseCode: string | null;
  index: number;
  total: number;
  watching: string[];
  lastAt: string | null;
  lastError: string | null;
  elapsedMs: number | null;
  nextCheckAt: string | null;
  checks: number;
  scans: number;
  changes: number;
};

const IDLE_WATCHER: WatcherActivity = {
  phase: 'idle',
  courseCode: null,
  index: 0,
  total: 0,
  watching: [],
  lastAt: null,
  lastError: null,
  elapsedMs: null,
  nextCheckAt: null,
  checks: 0,
  scans: 0,
  changes: 0,
};

type SSEContext = {
  connected: boolean;
  log: LogLine[];
  lastEnroll: { reason: string; results: EnrollResult[] } | null;
  watcher: WatcherActivity;
  clearLog: () => void;
};

const Ctx = createContext<SSEContext | null>(null);

export function SSEProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { authenticated } = useAuth();
  const [connected, setConnected] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [lastEnroll, setLastEnroll] = useState<SSEContext['lastEnroll']>(null);
  const [watcher, setWatcher] = useState<WatcherActivity>(IDLE_WATCHER);
  const idRef = useRef(0);

  const push = (text: string, kind: LogLine['kind'] = 'info') =>
    setLog((prev) =>
      [{ id: idRef.current++, time: new Date().toLocaleTimeString('es-DO'), text, kind }, ...prev].slice(0, 200)
    );

  useEffect(() => {
    if (!authenticated) {
      setConnected(false);
      return;
    }
    const source = new EventSource('/api/events');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (event) => {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case 'log':
          push(data.message);
          break;
        // Un 'notice' es lo mismo que dispara la notificación de escritorio
        // (ver src/notify.js): el feed y el popup dicen lo mismo porque salen
        // del mismo evento, no de dos avisos escritos por separado.
        case 'notice':
          push(data.body ? `${data.title} — ${data.body}` : data.title, data.level ?? 'info');
          break;
        case 'cart-status':
          // El backend ya guardó estas filas en SQLite antes de emitirlas: el
          // cache del cliente refleja lo mismo que devolvería un GET.
          qc.setQueryData(['cart'], {
            generatedAt: new Date().toISOString(),
            syncedAt: data.syncedAt ?? null,
            rows: data.rows,
          });
          break;
        case 'enroll-result':
          setLastEnroll({ reason: data.reason, results: data.results });
          for (const r of data.results as EnrollResult[]) push(`${r.classLabel}: ${r.message}`, r.success ? 'success' : 'error');
          break;
        case 'schedule-set':
        case 'watcher-set':
          qc.invalidateQueries({ queryKey: ['state'] });
          break;
        // El pulso del watcher. Cada fase reemplaza lo que está en pantalla en
        // vez de acumular: lo que importa es el ahora, y el histórico ya vive
        // en el feed de actividad.
        case 'watcher-tick':
          setWatcher((prev) => {
            switch (data.phase) {
              case 'start':
                return {
                  ...prev,
                  phase: 'scanning',
                  courseCode: null,
                  index: 0,
                  total: data.total ?? 0,
                  watching: data.watching ?? prev.watching,
                  lastError: null,
                };
              case 'course':
                return { ...prev, phase: 'scanning', courseCode: data.courseCode, index: data.index ?? 0, total: data.total ?? prev.total };
              case 'course-done':
                return {
                  ...prev,
                  phase: 'scanning',
                  courseCode: data.courseCode,
                  lastAt: data.at ?? prev.lastAt,
                  scans: prev.scans + 1,
                  changes: prev.changes + (data.changed ?? 0),
                };
              case 'course-error':
                return { ...prev, phase: 'error', courseCode: data.courseCode, lastError: data.error ?? null };
              case 'done':
                return {
                  ...prev,
                  // Un fallo de materia no se borra al cerrar el ciclo: si algo
                  // salió mal, la pantalla lo sigue diciendo hasta el próximo
                  // ciclo limpio.
                  phase: prev.phase === 'error' ? 'error' : 'done',
                  courseCode: null,
                  lastAt: data.at ?? prev.lastAt,
                  elapsedMs: data.elapsedMs ?? null,
                  nextCheckAt: data.nextCheckAt ?? null,
                  checks: prev.checks + 1,
                };
              default:
                return prev;
            }
          });
          // Un ciclo que terminó pudo mover cupos: el carrito y el estado
          // persistido dejan de ser lo que la pantalla tiene cacheado.
          if (data.phase === 'done') {
            qc.invalidateQueries({ queryKey: ['state'] });
            qc.invalidateQueries({ queryKey: ['seat-trend'] });
          }
          break;
        // P1: la invalidación es por evento y la declara la fuente, no la
        // pantalla que disparó el refresh. Así una pestaña abierta en Notas se
        // entera de que el avance cambió sin que nadie recargue.
        case 'sync-source':
          for (const key of (data.invalidates ?? []) as string[]) {
            qc.invalidateQueries({ queryKey: [key] });
          }
          qc.invalidateQueries({ queryKey: ['sync'] });
          break;
      }
    };
    return () => source.close();
  }, [authenticated, qc]);

  return (
    <Ctx.Provider value={{ connected, log, lastEnroll, watcher, clearLog: () => setLog([]) }}>{children}</Ctx.Provider>
  );
}

export function useSSE() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSSE fuera de SSEProvider');
  return ctx;
}
