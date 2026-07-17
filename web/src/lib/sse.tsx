import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';

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
  const [connected, setConnected] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [lastEnroll, setLastEnroll] = useState<SSEContext['lastEnroll']>(null);
  const idRef = useRef(0);

  const push = (text: string, kind: LogLine['kind'] = 'info') =>
    setLog((prev) =>
      [{ id: idRef.current++, time: new Date().toLocaleTimeString('es-DO'), text, kind }, ...prev].slice(0, 200)
    );

  useEffect(() => {
    const source = new EventSource('/api/events');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (event) => {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case 'log':
          push(data.message);
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
      }
    };
    return () => source.close();
  }, [qc]);

  return (
    <Ctx.Provider value={{ connected, log, lastEnroll, clearLog: () => setLog([]) }}>{children}</Ctx.Provider>
  );
}

export function useSSE() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSSE fuera de SSEProvider');
  return ctx;
}
