import { useSSE } from '../lib/sse.tsx';

const KIND_CLS = { info: 'text-muted', success: 'text-open', error: 'text-closed' } as const;

export function ActivityFeed() {
  const { log, clearLog } = useSSE();
  return (
    <section className="border-line bg-surface rounded-[var(--radius)] border">
      <header className="border-line flex items-center justify-between border-b px-3 py-2">
        <h2 className="text-sm font-medium">Actividad</h2>
        {log.length > 0 && (
          <button onClick={clearLog} className="text-muted hover:text-fg text-xs underline underline-offset-2">
            limpiar
          </button>
        )}
      </header>
      <div className="max-h-64 overflow-y-auto p-3">
        {log.length === 0 ? (
          <p className="text-muted text-sm">Sin actividad todavía.</p>
        ) : (
          <ul className="space-y-1">
            {log.map((line) => (
              <li key={line.id} className={`tabular font-mono text-xs ${KIND_CLS[line.kind]}`}>
                <span className="opacity-60">[{line.time}]</span> {line.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
