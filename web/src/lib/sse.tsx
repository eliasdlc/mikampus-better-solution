import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from './auth.tsx';

// Actividad en vivo del backend (operaciones Playwright, watcher, scheduler)
// vía el SSE existente. Además de alimentar el feed de actividad, empuja los
// datos frescos al cache de TanStack Query: cuando llega un 'cart-status' del
// watcher, el carrito de toda la app se actualiza sin refetch.
export type LogLine = { id: number; time: string; text: string; kind: 'info' | 'success' | 'error' };
type EnrollResult = { classLabel: string; message: string; success: boolean };

type SSEContext = {
  connected: boolean;
  log: LogLine[];
  lastEnroll: { reason: string; results: EnrollResult[] } | null;
  clearLog: () => void;
};

const Ctx = createContext<SSEContext | null>(null);

export function SSEProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { authenticated } = useAuth();
  const [connected, setConnected] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [lastEnroll, setLastEnroll] = useState<SSEContext['lastEnroll']>(null);
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
    <Ctx.Provider value={{ connected, log, lastEnroll, clearLog: () => setLog([]) }}>{children}</Ctx.Provider>
  );
}

export function useSSE() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSSE fuera de SSEProvider');
  return ctx;
}
