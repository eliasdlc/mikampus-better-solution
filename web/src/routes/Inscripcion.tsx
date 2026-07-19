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
  fetchCatalog,
  fetchPensum,
} from '../lib/api.ts';
import type { CartRow, CatalogCourse } from '../../../src/shared/schemas.ts';
import { AlertTriangle, CheckCircle2, CircleDot, Clock3, Radio, Zap } from 'lucide-react';
import { sectionToBlocks, type Block } from '../lib/grid.ts';
import { WeeklyGrid } from '../components/WeeklyGrid.tsx';
import { CourseChip } from '../components/CourseChip.tsx';
import { SeatBadge } from '../components/SeatBadge.tsx';
import { LiveOpBanner } from '../components/LiveOpBanner.tsx';
import { Countdown } from '../components/Countdown.tsx';
import { StalenessTag } from '../components/StalenessTag.tsx';
import { ActivityFeed } from '../components/ActivityFeed.tsx';
import { CourseSearchBox } from '../components/CourseSearchBox.tsx';

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
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: fetchCatalog });
  const pensum = useQuery({
    queryKey: ['pensum', nextTerm],
    queryFn: () => fetchPensum(nextTerm),
    enabled: !!nextTerm,
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
    mutationFn: () => {
      const expiresAt = windows.data?.windows[0]?.endsAt ?? 'el cierre de inscripción';
      if (!window.confirm(`Para ejecutar el disparo aunque cierres la app, mikampus guardará tu credencial cifrada hasta ${expiresAt}. ¿Aceptás?`)) {
        return Promise.reject(new Error('No autorizaste el disparo programado.'));
      }
      return scheduleAt({ atISO: new Date(at).toISOString(), term: nextTerm, consent: true });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['state'] }),
  });
  const unschedule = useMutation({
    mutationFn: cancelSchedule,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['state'] }),
  });
  const watch = useMutation({
    mutationFn: (input: { enabled: boolean; autoEnroll?: boolean }) => {
      const expiresAt = windows.data?.windows[0]?.endsAt ?? 'el cierre de inscripción';
      if (input.autoEnroll && !window.confirm(`Auto-inscripción puede modificar tu matrícula sin que estés frente a la app. Se guardará tu credencial cifrada hasta ${expiresAt}. ¿Aceptás?`)) {
        return Promise.reject(new Error('No autorizaste la auto-inscripción.'));
      }
      return setWatcher({
        ...input,
        term: nextTerm,
        appointmentAt: scheduledAt ?? null,
        consent: input.autoEnroll === true,
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['state'] }),
  });

  const watcherOn = !!state.data?.watcher;
  const autoEnrollOn = state.data?.watcher?.autoEnroll ?? false;
  const scheduledAt = state.data?.schedule?.atISO;
  const rows = cart.data?.rows ?? [];
  const blocks = useMemo(() => cartBlocks(rows), [rows]);
  const enrollmentWindow = windows.data?.windows[0] ?? null;
  const hasClosedSection = rows.some((row) => row.status === 'closed');
  const hasCollision = blocks.some((block) => block.conflictsWith.length > 0);
  const isLive = enroll.isPending || validation.isPending || refresh.isPending || refreshWindow.isPending;
  const stage = enroll.isSuccess
    ? 'result'
    : isLive
      ? 'live'
      : rows.length === 0 || hasClosedSection || hasCollision
        ? 'preparing'
        : scheduledAt || watcherOn
          ? 'armed'
          : 'ready';
  const recommendedCourses = useMemo(() => {
    const byId = new Map((catalog.data?.courses ?? []).map((course) => [course.id, course]));
    return (pensum.data?.courses ?? [])
      .filter((course) => course.status === 'pending' && course.offered && course.courseId != null)
      .map((course) => byId.get(course.courseId!))
      .filter((course): course is CatalogCourse => !!course)
      .filter((course) => course.sections.some((section) => !nextTerm || section.term === nextTerm));
  }, [catalog.data, pensum.data, nextTerm]);
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
        active={isLive}
        message={liveMessage}
      />

      <section className="border-line bg-surface overflow-hidden rounded-[var(--radius)] border" aria-live="polite">
        <div className={`h-1 ${stage === 'preparing' ? 'bg-waitlist' : stage === 'result' ? 'bg-open' : 'bg-accent'}`} aria-hidden />
        <div className="grid gap-4 p-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
          <StageIcon stage={stage} />
          <div>
            <p className="text-muted text-xs font-medium tracking-wide uppercase">Estado de inscripción</p>
            <h2 className="font-display mt-0.5 text-xl font-semibold tracking-tight">{stageCopy(stage).title}</h2>
            <p className="text-muted mt-1 text-sm">{stageCopy(stage).description}</p>
          </div>
          {stage === 'ready' && (
            <button
              type="button"
              disabled={enroll.isPending}
              onClick={() => enroll.mutate()}
              className="bg-accent text-accent-fg flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              <Zap className="size-4" aria-hidden />Inscribir ahora
            </button>
          )}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          {stage === 'preparing' && catalog.data && (
            <section className="border-line bg-surface rounded-[var(--radius)] border p-4">
              <div className="mb-3">
                <h2 className="text-sm font-medium">Completá tu carrito</h2>
                <p className="text-muted mt-1 text-xs">Primero te mostramos las materias pendientes de tu pénsum que se ofrecen este ciclo.</p>
              </div>
              <CourseSearchBox
                courses={catalog.data.courses.filter((course) => course.sections.some((section) => !nextTerm || section.term === nextTerm))}
                suggestions={recommendedCourses}
                placeholder="Buscar una materia para el carrito…"
              />
            </section>
          )}

          {stage === 'preparing' && (hasCollision || hasClosedSection) && (
            <section className="border-waitlist/40 bg-waitlist/10 text-waitlist rounded-[var(--radius)] border p-3 text-sm">
              {hasCollision && <p>Hay secciones que chocan en el horario proyectado. Ajustá el carrito antes de programar el disparo.</p>}
              {hasClosedSection && <p className={hasCollision ? 'mt-1' : ''}>Hay secciones cerradas. Podés activar el watcher o elegir otro grupo.</p>}
            </section>
          )}
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

          {/* El horario sube al chequeo maestro: aquí se lee como una prueba,
              no como decoración al final de la pantalla. */}
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
                <p className="text-muted text-xs">
                  {state.data?.schedule?.prewarmed
                    ? 'El asistente ya está preparado; a la hora exacta solo se enviará.'
                    : `Preparación automática desde ${new Date(state.data?.schedule?.prewarmAtISO ?? scheduledAt).toLocaleString('es-DO')}.`}
                </p>
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
                onClick={() => watch.mutate({ enabled: !watcherOn, autoEnroll: false })}
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
            {watcherOn && (
              <label className="border-line flex items-start gap-2 rounded-[var(--radius)] border p-2.5 text-xs">
                <input
                  type="checkbox"
                  checked={autoEnrollOn}
                  disabled={watch.isPending}
                  onChange={(event) => watch.mutate({ enabled: true, autoEnroll: event.target.checked })}
                  className="mt-0.5"
                />
                <span>
                  <span className="block font-medium">Inscribirme al instante si abre cupo</span>
                  <span className="text-muted">
                    {autoEnrollOn
                      ? 'Activo con cola FIFO. Si no conocemos tu hora exacta, solo te avisará hasta que abra.'
                      : 'Por defecto solo avisa; activarlo pide consentimiento explícito.'}
                  </span>
                </span>
              </label>
            )}
            {state.data?.watcher?.queue.map((item) => (
              <p key={item.courseCode} className="text-muted text-xs">
                Fila de {item.courseCode}: posición {item.position} de {item.total}.
              </p>
            ))}
            {watch.error && <p className="text-closed text-xs">{watch.error.message}</p>}
          </div>

          {stage !== 'ready' && stage !== 'live' && (
            <button
              disabled={enroll.isPending || rows.length === 0}
              onClick={() => enroll.mutate()}
              className="border-line hover:bg-surface-2 w-full rounded-[var(--radius)] border px-3 py-2 text-sm font-medium disabled:opacity-50"
            >
              Inscribir ahora de todas formas
            </button>
          )}
        </aside>
      </div>

      <ActivityFeed />
    </div>
  );
}

type EnrollmentStage = 'preparing' | 'ready' | 'armed' | 'live' | 'result';

function stageCopy(stage: EnrollmentStage) {
  switch (stage) {
    case 'preparing':
      return { title: 'Preparando', description: 'Revisá el carrito, los choques y los cupos antes de comprometer el disparo.' };
    case 'ready':
      return { title: 'Armado para inscribir', description: 'El carrito no muestra problemas. Podés inscribir ahora o programar tu hora.' };
    case 'armed':
      return { title: 'Disparo armado', description: 'Tu horario quedó preparado. mikampus conserva el contexto y te muestra cada paso al ejecutarse.' };
    case 'live':
      return { title: 'Operación en vivo', description: 'No cierres esta pantalla: el feed registra la respuesta de PeopleSoft paso a paso.' };
    case 'result':
      return { title: 'Resultado recibido', description: 'Revisá el feed para confirmar cada materia y activá el watcher para las que no entraron.' };
  }
}

function StageIcon({ stage }: { stage: EnrollmentStage }) {
  const Icon = stage === 'preparing' ? AlertTriangle : stage === 'ready' ? CircleDot : stage === 'armed' ? Clock3 : stage === 'live' ? Radio : CheckCircle2;
  const tone = stage === 'preparing' ? 'text-waitlist bg-waitlist/10' : stage === 'result' ? 'text-open bg-open/10' : 'text-accent bg-accent/10';
  return <span className={`flex size-10 items-center justify-center rounded-full ${tone}`}><Icon className="size-5" aria-hidden /></span>;
}
