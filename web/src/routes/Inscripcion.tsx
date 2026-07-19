import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchCart,
  syncCart,
  fetchState,
  scheduleAt,
  cancelSchedule,
  setWatcher,
  enrollNow,
  validateCart,
  fetchEnrollmentWindows,
  syncEnrollmentWindows,
  fetchTermContext,
} from '../lib/api.ts';
import type { CartRow } from '../../../src/shared/schemas.ts';
import { sectionToBlocks, type Block } from '../lib/grid.ts';
import { WeeklyGrid } from '../components/WeeklyGrid.tsx';
import { CourseChip } from '../components/CourseChip.tsx';
import { SeatBadge } from '../components/SeatBadge.tsx';
import { LiveOpBanner } from '../components/LiveOpBanner.tsx';
import { Countdown } from '../components/Countdown.tsx';
import { StalenessTag } from '../components/StalenessTag.tsx';
import { ActivityFeed } from '../components/ActivityFeed.tsx';

// El carrito enriquecido trae horario por fila: se proyecta en el WeeklyGrid
// para ver el horario que estás a punto de inscribir — imposible en micampus.
function cartBlocks(rows: CartRow[]): Block[] {
  return rows.flatMap((row) =>
    sectionToBlocks(
      { code: row.courseCode ?? row.classLabel, title: row.title },
      {
        classNbr: row.classNbr ?? `fila-${row.index}`,
        section: row.section,
        component: null,
        instructor: row.instructor,
        meetings: row.meetings,
      }
    )
  );
}

export function Inscripcion() {
  const qc = useQueryClient();
  const cart = useQuery({ queryKey: ['cart'], queryFn: fetchCart });
  const state = useQuery({ queryKey: ['state'], queryFn: fetchState });
  const terms = useQuery({ queryKey: ['term-context'], queryFn: fetchTermContext });
  const nextTerm = terms.data?.next?.code ?? undefined;
  const windows = useQuery({
    queryKey: ['enrollment-windows', nextTerm],
    queryFn: () => fetchEnrollmentWindows(nextTerm),
    enabled: terms.isSuccess,
  });

  const [at, setAt] = useState('');

  const enroll = useMutation({ mutationFn: enrollNow });
  const validation = useMutation({ mutationFn: validateCart });
  const refreshWindow = useMutation({
    mutationFn: () => syncEnrollmentWindows(nextTerm),
    onSuccess: (fresh) => qc.setQueryData(['enrollment-windows', nextTerm], fresh),
  });
  // El carrito se muestra desde cache; traerlo del portal es explícito y tarda.
  const refresh = useMutation({
    mutationFn: syncCart,
    onSuccess: (fresh) => qc.setQueryData(['cart'], fresh),
  });
  const schedule = useMutation({
    mutationFn: () => scheduleAt(new Date(at).toISOString()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['state'] }),
  });
  const unschedule = useMutation({
    mutationFn: cancelSchedule,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['state'] }),
  });
  const watch = useMutation({
    mutationFn: (enabled: boolean) => setWatcher(enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['state'] }),
  });

  const watcherOn = !!state.data?.watcher;
  const scheduledAt = state.data?.schedule?.atISO;
  const rows = cart.data?.rows ?? [];
  const blocks = useMemo(() => cartBlocks(rows), [rows]);
  const enrollmentWindow = windows.data?.windows[0] ?? null;
  const liveMessage = enroll.isPending
    ? 'Ejecutando inscripción del carrito en PeopleSoft…'
    : validation.isPending
      ? 'Buscando Validate en el wizard de PeopleSoft…'
      : 'Leyendo la ventana de inscripción publicada…';

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between">
        <h1 className="font-display text-2xl font-semibold tracking-tight">Inscripción</h1>
        <StalenessTag at={cart.data?.syncedAt ?? null} onRefresh={() => refresh.mutate()} refreshing={refresh.isPending} />
      </header>

      {refresh.error && (
        <p className="text-closed text-sm">
          PeopleSoft no respondió al leer el carrito ({(refresh.error as Error).message}).
        </p>
      )}

      <LiveOpBanner
        active={enroll.isPending || validation.isPending || refreshWindow.isPending}
        message={liveMessage}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          <section className="border-line bg-surface rounded-[var(--radius)] border">
            <header className="border-line border-b px-4 py-2.5">
              <h2 className="text-sm font-medium">Carrito</h2>
            </header>
            {cart.isPending ? (
              <p className="text-muted p-4 text-sm">Leyendo el carrito…</p>
            ) : cart.error ? (
              <p className="text-closed p-4 text-sm">{(cart.error as Error).message}</p>
            ) : rows.length === 0 ? (
              // Un carrito vacío y un carrito nunca leído se ven igual y no son
              // lo mismo: sin sincronizar, la app no sabe qué hay en el portal.
              <div className="p-4">
                {cart.data?.syncedAt ? (
                  <p className="text-muted text-sm">El carrito está vacío. Agregá materias desde Buscar o mandá un plan.</p>
                ) : (
                  <>
                    <p className="text-sm">Todavía no leíste tu carrito del portal.</p>
                    <button
                      type="button"
                      onClick={() => refresh.mutate()}
                      disabled={refresh.isPending}
                      className="bg-accent text-accent-fg mt-3 rounded-[var(--radius)] px-3 py-2 text-sm font-medium disabled:opacity-50"
                    >
                      {refresh.isPending ? 'Leyendo PeopleSoft…' : 'Traerlo de PeopleSoft'}
                    </button>
                  </>
                )}
              </div>
            ) : (
              <ul className="divide-line divide-y">
                {rows.map((row) => (
                  <li key={row.index} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3">
                    <CourseChip
                      code={row.courseCode ?? row.classLabel}
                      title={row.title}
                      classNbr={row.classNbr}
                      size="sm"
                    />
                    <span className="flex items-center gap-3">
                      <span className="text-muted tabular font-mono text-xs">
                        {row.meetings
                          .map((m) => (m.start ? `${m.days.join('')} ${m.start}–${m.end}` : 'TBA'))
                          .join(' · ') || 'Sin horario'}
                      </span>
                      {row.status && <SeatBadge status={row.status} />}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* El horario que este carrito inscribiría, choques incluidos. */}
          {blocks.length > 0 && <WeeklyGrid blocks={blocks} />}
        </div>

        <aside className="space-y-4">
          <div className="border-line bg-surface overflow-hidden rounded-[var(--radius)] border">
            <div className="bg-accent h-1" aria-hidden />
            <div className="space-y-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-medium">Ventana publicada</h2>
                  <p className="text-muted text-xs">PeopleSoft · {terms.data?.next?.label ?? 'próximo ciclo'}</p>
                </div>
                <button
                  type="button"
                  onClick={() => refreshWindow.mutate()}
                  disabled={refreshWindow.isPending}
                  className="text-accent text-xs font-medium underline underline-offset-2 disabled:opacity-50"
                >
                  {refreshWindow.isPending ? 'leyendo…' : 'actualizar'}
                </button>
              </div>
              {enrollmentWindow ? (
                <div>
                  <div className="tabular font-display text-xl font-semibold tracking-tight">
                    {new Date(`${enrollmentWindow.startsAt}T12:00:00`).toLocaleDateString('es-DO', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </div>
                  <p className="text-muted mt-0.5 text-xs">
                    hasta el{' '}
                    {new Date(`${enrollmentWindow.endsAt}T12:00:00`).toLocaleDateString('es-DO', {
                      day: 'numeric',
                      month: 'short',
                    })}
                  </p>
                  {enrollmentWindow.precision === 'date' && (
                    <p className="border-waitlist/40 bg-waitlist/10 text-waitlist mt-3 rounded-[var(--radius)] border px-2.5 py-2 text-xs">
                      El portal no publica la hora. Escribí abajo la hora comunicada por tu escuela; mikampus no asumirá medianoche.
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-muted text-xs">Todavía no has leído Enrollment Dates.</p>
              )}
              {refreshWindow.error && <p className="text-closed text-xs">{refreshWindow.error.message}</p>}
            </div>
          </div>

          <div className="border-line bg-surface space-y-3 rounded-[var(--radius)] border p-4">
            <h2 className="text-sm font-medium">Hora de inscripción</h2>
            {scheduledAt ? (
              <div className="space-y-2">
                <Countdown toISO={scheduledAt} />
                <div className="text-muted text-xs">
                  {new Date(scheduledAt).toLocaleString('es-DO')}
                  <button
                    onClick={() => unschedule.mutate()}
                    className="text-closed ml-2 underline underline-offset-2"
                  >
                    cancelar
                  </button>
                </div>
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
            <div>
              <h2 className="text-sm font-medium">Validación previa</h2>
              <p className="text-muted mt-1 text-xs">Comprueba qué pre-chequeos habilitó PUCMM antes de someter.</p>
            </div>
            <button
              type="button"
              onClick={() => validation.mutate()}
              disabled={validation.isPending || rows.length === 0}
              className="border-line hover:bg-surface-2 w-full rounded-[var(--radius)] border px-3 py-2 text-sm font-medium disabled:opacity-50"
            >
              Validar carrito ahora
            </button>
            {validation.data && !validation.data.validate.supported && (
              <div className="border-line bg-bg rounded-[var(--radius)] border p-2.5 text-xs">
                <p className="font-medium">Validate no está habilitado por PUCMM</p>
                <p className="text-muted mt-1">{validation.data.validate.reason}</p>
                <p className="text-muted mt-2">
                  Waitlist: {validation.data.waitlistChoice.reason} {validation.data.waitlistPosition.reason}
                </p>
              </div>
            )}
            {validation.error && <p className="text-closed text-xs">{validation.error.message}</p>}
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
            <p className="text-muted text-xs">
              {watcherOn
                ? `Ciclo efectivo: cada ${Math.round((state.data?.watcher?.intervalMs ?? 45_000) / 1000)}s.`
                : 'Consulta compartida: una sola cuenta revisa las materias vigiladas de todos.'}
            </p>
            <p className="text-muted text-xs">El intervalo se ajusta al presupuesto del servidor durante el pico.</p>
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
