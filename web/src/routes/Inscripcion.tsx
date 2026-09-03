import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleDot, ClipboardList, LayoutGrid, ShoppingCart, Table2, Trash2, Zap, type LucideIcon } from 'lucide-react';
import {
  fetchCart,
  syncCart,
  enrollNow,
  fetchTermContext,
  fetchCatalog,
  fetchPensum,
  fetchSeatTrends,
  fetchMySchedule,
  fetchEnrollmentWindows,
  fetchHolds,
  fetchTermPhase,
  removeCartRow,
} from '../lib/api.ts';
import type { CartRow, CatalogCourse, TermInfo } from '../../../src/shared/schemas.ts';
import type { CapabilityState } from '../../../src/shared/termPhase.ts';
import { sectionToBlocks, hasCollisions, type Block } from '../lib/grid.ts';
import { ClassDetail } from '../components/ClassDetail.tsx';
import { WeeklyGrid } from '../components/WeeklyGrid.tsx';
import { CourseChip } from '../components/CourseChip.tsx';
import { SeatBadge } from '../components/SeatBadge.tsx';
import { LiveOpBanner } from '../components/LiveOpBanner.tsx';
import { StalenessTag } from '../components/StalenessTag.tsx';
import { ActivityFeed } from '../components/ActivityFeed.tsx';
import { CourseSearchBox } from '../components/CourseSearchBox.tsx';
import { EnrollmentContext, useTermDiscovery } from '../components/EnrollmentContext.tsx';
import { capabilityOf } from '../components/Capacidad.tsx';
import { DropCoursePanel } from '../components/DropCoursePanel.tsx';
import { Planner } from './Planner.tsx';
import { Builder } from './Builder.tsx';

// Inscripción es UN recorrido, no tres pantallas (P2). Antes "Planear" y
// "Inscripción" partían el mismo trabajo en dos secciones primarias, cada una
// con su propio contexto de ciclo: se podía estar planeando Septiembre y
// mirando el carrito de Abril sin que nada lo dijera.
//
// Ahora el ciclo se elige una vez, arriba, vive en la URL, y las tres etapas
// —qué cursar, qué grupo, y someterlo— se derivan de esa elección.

type Stage = 'plan' | 'grupos' | 'carrito';

// `short` es para el teléfono: con los tres nombres largos, la tercera etapa
// quedaba cortada a media palabra y el recorrido dejaba de leerse como tres
// pasos. El nombre completo sigue en desktop y en el title.
const STAGES: { id: Stage; label: string; short: string; icon: LucideIcon; hint: string }[] = [
  { id: 'plan', label: 'Plan', short: 'Plan', icon: ClipboardList, hint: 'Qué materias querés cursar' },
  { id: 'grupos', label: 'Grupos y horario', short: 'Grupos', icon: LayoutGrid, hint: 'Qué grupo de cada una' },
  { id: 'carrito', label: 'Carrito y ejecución', short: 'Carrito', icon: ShoppingCart, hint: 'Someterlo a PeopleSoft' },
];

function isStage(value: string | null): value is Stage {
  return value === 'plan' || value === 'grupos' || value === 'carrito';
}

// Salida lateral desde el recorrido: mismo peso visual que el botón secundario
// del header, nunca el del acento, que acá lo lleva la etapa activa.
function SideTrip({ to, icon: Icon, label, hint }: { to: string; icon: LucideIcon; label: string; hint: string }) {
  return (
    <Link
      to={to}
      title={hint}
      className="border-line hover:bg-surface-2 text-muted hover:text-fg tap flex min-h-9 items-center gap-2 rounded-[var(--radius)] border px-2.5 py-1.5 text-xs font-medium"
    >
      <Icon className="size-4" aria-hidden />
      {label}
    </Link>
  );
}

// ── Cuándo se puede someter ─────────────────────────────────────────────────
//
// Inscribir es la acción más importante de la app y hasta ahora el botón
// simplemente NO SE RENDERIZABA cuando algo no cuadraba: la pantalla más
// crítica no tenía su acción principal y no decía por qué. Un botón ausente no
// enseña nada; uno deshabilitado que dice qué falta, sí.
//
// La distinción que importa es entre lo que PeopleSoft va a rechazar (no tiene
// sentido gastar la navegación) y lo que solo es un mal resultado previsible
// (se avisa, se confirma, y se somete igual: la decisión es del estudiante).
type Gate =
  | { can: false; reason: string; detail: string | null }
  | { can: true; warn: string | null };

// Una fecha sin hora se agota al final de SU día en Santo Domingo. Se calcula
// desde el texto y no con `new Date(iso)`, que lo leería como medianoche UTC y
// correría el borde cuatro horas hacia atrás.
const SANTO_DOMINGO_UTC_OFFSET_H = 4;

function endOfDay(iso: string): number {
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
  return Date.UTC(year, month - 1, day, 23 + SANTO_DOMINGO_UTC_OFFSET_H, 59, 59, 999);
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function readableDay(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
  return `${day} de ${MESES[month - 1] ?? '?'} de ${year}`;
}

function enrollmentGate(input: {
  rows: number;
  holds: number;
  windowStartsAt: string | null;
  windowEndsAt: string | null;
  windowPrecision: 'date' | 'datetime' | null;
  hasWindowData: boolean;
  hasCollision: boolean;
  hasClosedSection: boolean;
  // Lo que la etapa del ciclo dice sobre inscribir. Es una SEGUNDA fuente sobre
  // la misma pregunta, y por eso entra acá en vez de decidir aparte: cuando
  // este gate miraba solo enrollment_windows, el carrito y la pantalla del
  // ciclo se contradecían sobre el mismo ciclo y nada las reconciliaba.
  inscribir: CapabilityState;
  now: number;
}): Gate {
  if (input.rows === 0) {
    return { can: false, reason: 'El carrito está vacío', detail: 'Agregá al menos una materia antes de someter.' };
  }
  if (input.holds > 0) {
    return {
      can: false,
      reason: `Tenés ${input.holds} hold(s) activos`,
      detail: 'PeopleSoft bloquea la inscripción con holds abiertos. Resolvelos primero.',
    };
  }

  // La etapa manda sobre la ventana cuando dice que cerró: sus fechas salen del
  // calendario oficial y de la ventana del portal juntas, y siguen vivas cuando
  // el scrape de Enrollment Dates lleva días fallando.
  if (input.inscribir.state === 'cerrada') {
    return {
      can: false,
      reason: 'La inscripción de este ciclo está cerrada',
      detail: input.inscribir.reason,
    };
  }

  // Una ventana con precisión de día abre a una hora que el portal no publica:
  // no se puede afirmar que ya cerró el primer día ni que abrió a medianoche.
  // Por eso el borde de apertura solo bloquea con precisión de hora.
  if (input.windowStartsAt && input.windowEndsAt) {
    const opens = new Date(input.windowStartsAt).getTime();
    const closes = new Date(input.windowEndsAt).getTime();
    if (input.windowPrecision === 'datetime' && input.now < opens) {
      return {
        can: false,
        reason: 'Todavía no abre el período de inscripción',
        detail: `Abre el ${new Date(opens).toLocaleString('es-DO')}.`,
      };
    }
    // Con precisión de día, "2026-09-03" es medianoche UTC, que en Santo Domingo
    // (UTC-4) son las 8 de la noche del día ANTERIOR: comparar contra eso
    // apagaba el botón durante todo el último día hábil de la ventana, diciendo
    // encima que había cerrado ayer. Un día cerrado se termina de agotar al
    // final de ese día, no al empezarlo.
    const closesAt = input.windowPrecision === 'datetime' ? closes : endOfDay(input.windowEndsAt);
    if (input.now > closesAt) {
      return {
        can: false,
        reason: 'El período de inscripción cerró',
        detail: `Cerró el ${readableDay(input.windowEndsAt)}. PeopleSoft ya no acepta cambios de este ciclo.`,
      };
    }
  }

  const avisos = [
    !input.hasWindowData
      ? 'Todavía no leíste el período de inscripción de este ciclo: si no es tu fecha, PeopleSoft va a rechazar el envío.'
      : null,
    input.hasCollision ? 'Hay secciones que chocan en el horario: el portal va a rechazar al menos una.' : null,
    input.hasClosedSection ? 'Hay secciones llenas: se someten igual y el portal responde materia por materia.' : null,
  ].filter(Boolean);

  return { can: true, warn: avisos.length ? avisos.join(' ') : null };
}

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
  const [params, setParams] = useSearchParams();
  // El detalle de un bloque del horario. Sin esto la grilla de esta pantalla
  // era un div mudo: sin rol, sin teclado, y el profesor y el aula no estaban
  // en ningún lado.
  const [detalleClase, setDetalleClase] = useState<Block | null>(null);

  const stage: Stage = isStage(params.get('etapa')) ? (params.get('etapa') as Stage) : 'plan';
  const parsedPlanId = Number(params.get('plan'));
  const activePlanId = Number.isSafeInteger(parsedPlanId) && parsedPlanId > 0 ? parsedPlanId : null;

  const terms = useQuery({ queryKey: ['term-context'], queryFn: fetchTermContext });
  const cart = useQuery({ queryKey: ['cart'], queryFn: fetchCart });
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: fetchCatalog });

  // El ciclo elegido manda sobre todo lo demás. Sin elección explícita, el
  // próximo; sin próximo, el actual. Nunca "el último que se sincronizó".
  const termList = terms.data?.terms ?? [];
  const requested = params.get('ciclo');
  const selectedTerm: TermInfo | null =
    termList.find((item) => item.term === requested) ?? terms.data?.next ?? terms.data?.current ?? null;
  const termId = selectedTerm?.term;

  const pensum = useQuery({
    queryKey: ['pensum', termId],
    queryFn: () => fetchPensum(termId),
    enabled: Boolean(termId),
  });

  // Lo que YA tenés inscrito en este mismo ciclo. Inscribirse y darse de baja
  // son la misma decisión mirada desde los dos lados —se suelta un cupo para
  // tomar otro, casi siempre en la misma sesión— y tener la baja en otra
  // pantalla obligaba a abandonar el recorrido en el peor momento.
  const enrolled = useQuery({
    queryKey: ['my-schedule', termId],
    queryFn: () => fetchMySchedule(termId!),
    enabled: Boolean(termId),
  });

  // Las dos señales que deciden si someter tiene sentido. Comparten queryKey
  // con la columna contextual, así que esto no agrega ni una consulta: React
  // Query sirve la misma respuesta a los dos.
  const holds = useQuery({ queryKey: ['holds'], queryFn: fetchHolds });
  const windows = useQuery({
    queryKey: ['enrollment-windows', termId],
    queryFn: () => fetchEnrollmentWindows(termId),
    enabled: Boolean(termId),
  });
  const phase = useQuery({
    queryKey: ['term-phase', termId],
    queryFn: () => fetchTermPhase(termId),
    enabled: Boolean(termId),
  });

  const discovery = useTermDiscovery();
  const enroll = useMutation({
    mutationFn: enrollNow,
    // Someter cambia tu matrícula: el horario inscrito y el carrito dejan de
    // ser lo que esta pantalla tiene cacheado en el mismo instante.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cart'] });
      qc.invalidateQueries({ queryKey: ['my-schedule'] });
      qc.invalidateQueries({ queryKey: ['state'] });
    },
  });
  const refresh = useMutation({
    mutationFn: syncCart,
    onSuccess: (fresh) => qc.setQueryData(['cart'], fresh),
  });

  // Qué fila se está quitando: se apaga SU botón, no la lista entera. Antes
  // esto alimentaba un ícono que latía; el estado deshabilitado ya dice lo
  // mismo y no repinta.
  const [removing, setRemoving] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: removeCartRow,
    onSuccess: (fresh) => qc.setQueryData(['cart'], fresh),
    onSettled: () => setRemoving(null),
  });

  const patchParams = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value == null) next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  };

  const setStage = (nextStage: Stage) => patchParams({ etapa: nextStage === 'plan' ? null : nextStage });

  // Cambiar de ciclo suelta el plan activo: un plan pertenece a un ciclo y
  // arrastrarlo al siguiente produciría secciones que no existen ahí. Se
  // explica antes de hacerlo, y se puede cancelar.
  const changeTerm = (nextTermId: string) => {
    if (nextTermId === termId) return;
    if (activePlanId != null) {
      const target = termList.find((item) => item.term === nextTermId);
      const ok = window.confirm(
        `El plan que tenés abierto pertenece a ${selectedTerm?.label ?? selectedTerm?.term}. ` +
          `Al cambiar a ${target?.label ?? nextTermId} se cierra ese plan (no se borra: sigue en la lista). ¿Seguir?`
      );
      if (!ok) return;
    }
    patchParams({ ciclo: nextTermId, plan: null });
  };

  const rows = cart.data?.rows ?? [];
  const blocks = useMemo(() => cartBlocks(rows), [rows]);
  const hasClosedSection = rows.some((row) => row.status === 'closed');
  const hasCollision = hasCollisions(blocks);
  const isLive = enroll.isPending || refresh.isPending || remove.isPending;

  const enrollmentWindow = windows.data?.windows[0] ?? null;
  const gate = enrollmentGate({
    rows: rows.length,
    holds: holds.data?.holds.length ?? 0,
    inscribir: capabilityOf(phase.data, 'inscribir'),
    windowStartsAt: enrollmentWindow?.startsAt ?? null,
    windowEndsAt: enrollmentWindow?.endsAt ?? null,
    windowPrecision: enrollmentWindow?.precision ?? null,
    hasWindowData: Boolean(enrollmentWindow),
    hasCollision,
    hasClosedSection,
    now: Date.now(),
  });

  // Someter con un problema conocido se puede, pero no por accidente: el aviso
  // se lee y se acepta. Sin problemas, el click somete directo — pedir confirmar
  // lo que ya está bien solo entrena a confirmar sin leer.
  const submit = () => {
    if (!gate.can || enroll.isPending) return;
    if (gate.warn && !window.confirm(`${gate.warn}\n\n¿Someter el carrito igual?`)) return;
    enroll.mutate();
  };

  const removeRow = (row: CartRow) => {
    const name = row.courseCode ?? row.classLabel;
    if (!window.confirm(`Quitar ${name}${row.classNbr ? ` (NRC ${row.classNbr})` : ''} del carrito en PeopleSoft?`)) return;
    setRemoving(String(row.index));
    remove.mutate({ classNbr: row.classNbr, courseCode: row.courseCode });
  };

  // El ritmo de cupo de MIS secciones. Sale de la serie que la app ya venía
  // guardando: el portal dice cuántos asientos hay ahora, esto dice cuántos
  // había hace dos horas — que durante una inscripción es la decisión entera.
  const cartClassNbrs = rows.map((row) => row.classNbr).filter((value): value is string => Boolean(value));
  const trends = useQuery({
    queryKey: ['seat-trend', termId, cartClassNbrs.join(',')],
    queryFn: () => fetchSeatTrends(termId!, cartClassNbrs),
    enabled: Boolean(termId) && cartClassNbrs.length > 0,
    refetchInterval: 60_000,
  });

  const recommendedCourses = useMemo(() => {
    const byId = new Map((catalog.data?.courses ?? []).map((course) => [course.id, course]));
    return (pensum.data?.courses ?? [])
      .filter((course) => course.status === 'pending' && course.offered && course.courseId != null)
      .map((course) => byId.get(course.courseId!))
      .filter((course): course is CatalogCourse => Boolean(course))
      .filter((course) => course.sections.some((section) => !termId || section.term === termId));
  }, [catalog.data, pensum.data, termId]);

  return (
    <div className="space-y-5">
      <header className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight">Inscripción</h1>
            <p className="text-muted mt-1 text-sm">
              Elegí qué cursar, con qué grupo, y sometelo. Todo para el mismo ciclo.
            </p>
          </div>
          <StalenessTag
            at={cart.data?.syncedAt ?? null}
            onRefresh={() => refresh.mutate()}
            refreshing={refresh.isPending}
          />
        </div>

        {/* El selector de ciclo vive en el header y en la URL: es el contexto
            del que cuelgan plan, catálogo, carrito, ventana y watcher. */}
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="ciclo" className="text-muted text-xs font-medium tracking-wide uppercase">
            Ciclo
          </label>
          <select
            id="ciclo"
            value={termId ?? ''}
            onChange={(event) => changeTerm(event.target.value)}
            disabled={termList.length === 0}
            className="border-line bg-bg min-h-9 rounded-[var(--radius)] border px-2 py-1.5 text-sm"
          >
            {termList.length === 0 && <option value="">sin ciclos conocidos</option>}
            {termList.map((item) => (
              <option key={item.term} value={item.term}>
                {item.label ?? item.term}
                {item.isCurrent ? ' · en curso' : item.isNext ? ' · próximo' : ''}
              </option>
            ))}
          </select>

          {/* Un ciclo sin STRM no es un error terminal: es una acción concreta,
              en el mismo lugar donde estorba. */}
          {selectedTerm && !selectedTerm.code && (
            <button
              type="button"
              onClick={() => discovery.mutate()}
              disabled={discovery.isPending}
              className="border-line hover:bg-surface-2 min-h-9 rounded-[var(--radius)] border px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              {discovery.isPending ? 'buscando…' : 'Buscar ciclos en PeopleSoft'}
            </button>
          )}
          {selectedTerm && !selectedTerm.code && (
            <span className="text-muted text-xs">
              Sin el código interno del ciclo, PeopleSoft no acepta consultas de cupos ni de carrito.
            </span>
          )}
        </div>

        {/* Mesa y El ciclo cuelgan de acá y no del nav principal: no son
            destinos paralelos sino contexto del mismo ciclo que se eligió
            arriba. Van fuera de la barra de etapas a propósito, porque no son
            un cuarto paso del recorrido: se consultan, no se recorren. */}
        <div className="flex flex-wrap items-center gap-2">
          <SideTrip to="/mesa" icon={Table2} label="Mesa de inscripción" hint="La hoja que se lleva a la mesa" />
          <SideTrip to="/ciclo" icon={CircleDot} label="El ciclo" hint="En qué etapa está y qué se puede hacer" />
        </div>

        <nav className="border-line flex w-full gap-1 overflow-x-auto rounded-[var(--radius)] border p-1 sm:w-fit" aria-label="Etapas de la inscripción">
          {STAGES.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={stage === item.id ? 'step' : undefined}
              onClick={() => setStage(item.id)}
              title={item.hint}
              className={`tap flex flex-1 shrink-0 items-center justify-center gap-2 rounded-[calc(var(--radius)-2px)] px-3 py-1.5 text-sm transition-colors duration-100 sm:flex-none sm:justify-start ${
                stage === item.id ? 'bg-accent text-accent-fg font-medium' : 'text-muted hover:bg-surface-2 hover:text-fg'
              }`}
            >
              <item.icon className="size-4" aria-hidden />
              <span className="sm:hidden">{item.short}</span>
              <span className="hidden sm:inline">{item.label}</span>
            </button>
          ))}
        </nav>
      </header>

      <LiveOpBanner
        active={isLive}
        message={
          enroll.isPending
            ? 'Ejecutando inscripción del carrito en PeopleSoft…'
            : remove.isPending
              ? 'Quitando la materia del carrito en PeopleSoft…'
              : 'Leyendo el carrito en PeopleSoft…'
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-5">
          {stage === 'plan' && (
            <Planner activePlanId={activePlanId} onActivePlanChange={(id) => patchParams({ plan: id ? String(id) : null })} embedded />
          )}

          {stage === 'grupos' && (
            <Builder
              activePlanId={activePlanId}
              onActivePlanChange={(id) => patchParams({ plan: id ? String(id) : null })}
              embedded
              termId={termId ?? null}
              termCode={selectedTerm?.code ?? null}
            />
          )}

          {stage === 'carrito' && (
            <>
              {catalog.data && (
                <section className="border-line bg-surface rounded-[var(--radius)] border p-4">
                  <div className="mb-3">
                    <h2 className="text-sm font-medium">Enviar al carrito</h2>
                    <p className="text-muted mt-1 text-xs">
                      Primero las materias pendientes de tu pénsum que se ofrecen en este ciclo.
                    </p>
                  </div>
                  <CourseSearchBox
                    courses={catalog.data.courses.filter((course) =>
                      course.sections.some((section) => !termId || section.term === termId)
                    )}
                    suggestions={recommendedCourses}
                    placeholder="Buscar una materia para el carrito…"
                  />
                </section>
              )}

              <section className="border-line bg-surface rounded-[var(--radius)] border">
                {/* El botón vive acá y SIEMPRE está: es la acción principal de
                    la pantalla. Cuando no se puede someter se muestra apagado
                    con el motivo debajo, en vez de desaparecer y dejar la
                    pantalla más importante sin su acción. */}
                <header className="border-line flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
                  <div>
                    <h2 className="text-sm font-medium">Carrito</h2>
                    {!gate.can && <p className="text-waitlist mt-0.5 text-xs">{gate.reason}</p>}
                    {gate.can && gate.warn && <p className="text-waitlist mt-0.5 text-xs">Se puede someter, con reparos</p>}
                  </div>
                  <button
                    type="button"
                    disabled={!gate.can || enroll.isPending}
                    onClick={submit}
                    title={gate.can ? (gate.warn ?? 'Somete el carrito a PeopleSoft') : `${gate.reason}. ${gate.detail ?? ''}`}
                    className="bg-accent text-accent-fg flex min-h-9 items-center gap-2 rounded-[var(--radius)] px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Zap className="size-4" aria-hidden />
                    {enroll.isPending ? 'Sometiendo…' : 'Inscribir ahora'}
                  </button>
                </header>

                {!gate.can && gate.detail && (
                  <p className="text-muted border-line border-b px-4 py-2 text-xs">{gate.detail}</p>
                )}

                {cart.isPending ? (
                  <p className="text-muted p-4 text-sm">Leyendo el carrito…</p>
                ) : cart.error ? (
                  <p className="text-closed p-4 text-sm">{(cart.error as Error).message}</p>
                ) : rows.length === 0 ? (
                  // Un carrito vacío y uno nunca leído se ven igual y no son lo
                  // mismo: sin sincronizar, la app no sabe qué hay en el portal.
                  <div className="p-4">
                    {cart.data?.syncedAt ? (
                      <p className="text-muted text-sm">
                        El carrito está vacío. Armá un plan en la etapa anterior o buscá una materia arriba.
                      </p>
                    ) : (
                      <>
                        <p className="text-sm">Todavía no leíste tu carrito del portal.</p>
                        <button
                          type="button"
                          onClick={() => refresh.mutate()}
                          disabled={refresh.isPending}
                          className="bg-accent text-accent-fg mt-3 min-h-11 rounded-[var(--radius)] px-3 py-2 text-sm font-medium disabled:opacity-50"
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
                        <CourseChip code={row.courseCode ?? row.classLabel} title={row.title} classNbr={row.classNbr} size="sm" />
                        <span className="flex items-center gap-3">
                          <span className="text-muted tabular font-mono text-xs">
                            {row.meetings.map((m) => (m.start ? `${m.days.join('')} ${m.start}–${m.end}` : 'TBA')).join(' · ') ||
                              'Sin horario'}
                          </span>
                          {row.status && <SeatBadge status={row.status} />}
                          {/* Quitar del carrito no es darse de baja: el carrito
                              es una lista de intenciones, no matrícula. Por eso
                              alcanza con una confirmación y no con el ritual de
                              escribir el código que exige soltar un cupo. */}
                          <button
                            type="button"
                            onClick={() => removeRow(row)}
                            // Solo SU fila se apaga, no la lista entera: quitar
                            // una materia no es motivo para congelar las otras.
                            disabled={removing === String(row.index)}
                            aria-label={`Quitar ${row.courseCode ?? row.classLabel} del carrito`}
                            title="Quitar del carrito"
                            className="tap text-muted hover:text-closed disabled:opacity-40"
                          >
                            <Trash2
                              className="size-4"
                              aria-hidden
                            />
                          </button>
                        </span>
                        {/* Lo que el portal no puede decirte: cómo venía este
                            cupo. mikampus lo sabe porque lo viene anotando. */}
                        {row.classNbr && trends.data?.trends[row.classNbr]?.summary && (
                          <span
                            className={`basis-full text-xs ${
                              trends.data.trends[row.classNbr].direction === 'filling' ? 'text-waitlist' : 'text-muted'
                            }`}
                          >
                            {trends.data.trends[row.classNbr].summary}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {(hasCollision || hasClosedSection) && (
                <section className="border-waitlist/40 bg-waitlist/10 text-waitlist rounded-[var(--radius)] border p-3 text-sm">
                  {hasCollision && <p>Hay secciones que chocan en el horario proyectado. Ajustá el carrito antes de someter.</p>}
                  {hasClosedSection && (
                    <p className={hasCollision ? 'mt-1' : ''}>
                      Hay secciones cerradas. Podés activar el watcher o elegir otro grupo.
                    </p>
                  )}
                </section>
              )}

              {/* La baja va DESPUÉS del carrito, no antes: primero lo que
                  estás por sumar, después lo que ya tenés y podés soltar. */}
              <DropCoursePanel
                courses={enrolled.data?.courses ?? []}
                termCode={selectedTerm?.code ?? null}
                heading={`Ya inscrito en ${selectedTerm?.label ?? 'este ciclo'}`}
                hint="Soltar un cupo es irreversible: si se ocupa, no vuelve."
                onDropped={() => qc.invalidateQueries({ queryKey: ['cart'] })}
              />

              {blocks.length > 0 && <WeeklyGrid blocks={blocks} onSelect={setDetalleClase} />}

              {enroll.error && <p className="text-closed text-sm">{(enroll.error as Error).message}</p>}
              {remove.error && (
                <p className="text-closed text-sm">No se pudo quitar del carrito: {(remove.error as Error).message}</p>
              )}
            </>
          )}

          {refresh.error && (
            <p className="text-closed text-sm">PeopleSoft no respondió al leer el carrito ({(refresh.error as Error).message}).</p>
          )}
        </div>

        <EnrollmentContext
          term={selectedTerm}
          cartRows={rows.length}
          hasCollision={hasCollision}
          hasClosedSection={hasClosedSection}
          onResolveTerm={() => discovery.mutate()}
        />
      </div>

      <ActivityFeed />

      <ClassDetail block={detalleClase} onClose={() => setDetalleClase(null)} />
    </div>
  );
}
