import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchCart,
  fetchState,
  scheduleAt,
  cancelSchedule,
  setWatcher,
  enrollNow,
} from '../lib/api.ts';
import { SeatBadge } from '../components/SeatBadge.tsx';
import { LiveOpBanner } from '../components/LiveOpBanner.tsx';
import { ActivityFeed } from '../components/ActivityFeed.tsx';

export function Inscripcion() {
  const qc = useQueryClient();
  const cart = useQuery({ queryKey: ['cart'], queryFn: fetchCart });
  const state = useQuery({ queryKey: ['state'], queryFn: fetchState });

  const [at, setAt] = useState('');
  const [intervalSecs, setIntervalSecs] = useState(45);

  const enroll = useMutation({ mutationFn: enrollNow });
  const schedule = useMutation({
    mutationFn: () => scheduleAt(new Date(at).toISOString()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['state'] }),
  });
  const unschedule = useMutation({
    mutationFn: cancelSchedule,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['state'] }),
  });
  const watch = useMutation({
    mutationFn: (enabled: boolean) => setWatcher(enabled, intervalSecs * 1000),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['state'] }),
  });

  const watcherOn = !!state.data?.watcher;
  const scheduledAt = state.data?.schedule?.atISO;

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between">
        <h1 className="font-display text-2xl font-semibold tracking-tight">Inscripción</h1>
        <button
          onClick={() => cart.refetch()}
          className="border-line hover:bg-surface-2 rounded-[var(--radius)] border px-2.5 py-1 text-xs"
        >
          {cart.isFetching ? 'leyendo…' : 'refrescar carrito'}
        </button>
      </header>

      <LiveOpBanner active={enroll.isPending} message="Ejecutando inscripción del carrito en PeopleSoft…" />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <section className="border-line bg-surface rounded-[var(--radius)] border">
          <header className="border-line border-b px-4 py-2.5">
            <h2 className="text-sm font-medium">Carrito</h2>
          </header>
          {cart.isLoading ? (
            <p className="text-muted p-4 text-sm">Leyendo el carrito…</p>
          ) : cart.error ? (
            <p className="text-closed p-4 text-sm">{(cart.error as Error).message}</p>
          ) : (cart.data ?? []).length === 0 ? (
            <p className="text-muted p-4 text-sm">El carrito está vacío. Agregá materias desde Buscar.</p>
          ) : (
            <ul className="divide-line divide-y">
              {cart.data!.map((row) => (
                <li key={row.index} className="flex items-center justify-between gap-3 px-4 py-3">
                  <span className="text-sm">{row.classLabel}</span>
                  {row.status && <SeatBadge status={row.status} />}
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="space-y-4">
          <div className="border-line bg-surface space-y-3 rounded-[var(--radius)] border p-4">
            <h2 className="text-sm font-medium">Hora de inscripción</h2>
            {scheduledAt ? (
              <div className="text-sm">
                Programada para{' '}
                <span className="font-medium">{new Date(scheduledAt).toLocaleString('es-DO')}</span>
                <button
                  onClick={() => unschedule.mutate()}
                  className="text-closed ml-2 text-xs underline underline-offset-2"
                >
                  cancelar
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <input
                  type="datetime-local"
                  value={at}
                  onChange={(e) => setAt(e.target.value)}
                  className="border-line bg-bg rounded-[var(--radius)] border px-2 py-1.5 text-sm"
                />
                <button
                  disabled={!at || schedule.isPending}
                  onClick={() => schedule.mutate()}
                  className="bg-accent text-accent-fg rounded-[var(--radius)] px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                >
                  Programar disparo
                </button>
              </div>
            )}
          </div>

          <div className="border-line bg-surface space-y-3 rounded-[var(--radius)] border p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">Watcher de cupos</h2>
              <button
                role="switch"
                aria-checked={watcherOn}
                onClick={() => watch.mutate(!watcherOn)}
                className={`h-6 w-10 rounded-full p-0.5 transition-colors duration-100 ${watcherOn ? 'bg-accent' : 'bg-surface-2 border-line border'}`}
              >
                <span className={`block size-5 rounded-full bg-white transition-transform duration-100 ${watcherOn ? 'translate-x-4' : ''}`} />
              </button>
            </div>
            <label className="text-muted flex items-center gap-2 text-xs">
              cada
              <input
                type="number"
                min={30}
                value={intervalSecs}
                onChange={(e) => setIntervalSecs(Number(e.target.value))}
                className="border-line bg-bg tabular w-16 rounded-[var(--radius)] border px-2 py-1 font-mono"
              />
              s
            </label>
            <p className="text-muted text-xs">No bajés de ~30–45s durante el pico de demanda.</p>
          </div>

          <button
            disabled={enroll.isPending}
            onClick={() => enroll.mutate()}
            className="border-line hover:bg-surface-2 w-full rounded-[var(--radius)] border px-3 py-2 text-sm font-medium disabled:opacity-50"
          >
            Inscribir ahora (manual)
          </button>
        </aside>
      </div>

      <ActivityFeed />
    </div>
  );
}
