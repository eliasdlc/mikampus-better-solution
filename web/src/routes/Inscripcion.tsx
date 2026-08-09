import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, LayoutGrid, ShoppingCart, Zap, type LucideIcon } from 'lucide-react';
import { fetchCart, syncCart, enrollNow, fetchTermContext, fetchCatalog, fetchPensum } from '../lib/api.ts';
import type { CartRow, CatalogCourse, TermInfo } from '../../../src/shared/schemas.ts';
import { sectionToBlocks, hasCollisions, type Block } from '../lib/grid.ts';
import { WeeklyGrid } from '../components/WeeklyGrid.tsx';
import { CourseChip } from '../components/CourseChip.tsx';
import { SeatBadge } from '../components/SeatBadge.tsx';
import { LiveOpBanner } from '../components/LiveOpBanner.tsx';
import { StalenessTag } from '../components/StalenessTag.tsx';
import { ActivityFeed } from '../components/ActivityFeed.tsx';
import { CourseSearchBox } from '../components/CourseSearchBox.tsx';
import { EnrollmentContext, useTermDiscovery } from '../components/EnrollmentContext.tsx';
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

  const discovery = useTermDiscovery();
  const enroll = useMutation({ mutationFn: enrollNow });
  const refresh = useMutation({
    mutationFn: syncCart,
    onSuccess: (fresh) => qc.setQueryData(['cart'], fresh),
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
  const isLive = enroll.isPending || refresh.isPending;
  const readyToSubmit = rows.length > 0 && !hasClosedSection && !hasCollision;

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
        message={enroll.isPending ? 'Ejecutando inscripción del carrito en PeopleSoft…' : 'Leyendo el carrito en PeopleSoft…'}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-5">
          {stage === 'plan' && (
            <Planner activePlanId={activePlanId} onActivePlanChange={(id) => patchParams({ plan: id ? String(id) : null })} embedded />
          )}

          {stage === 'grupos' && (
            <Builder activePlanId={activePlanId} onActivePlanChange={(id) => patchParams({ plan: id ? String(id) : null })} embedded />
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
                <header className="border-line flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
                  <h2 className="text-sm font-medium">Carrito</h2>
                  {readyToSubmit && (
                    <button
                      type="button"
                      disabled={enroll.isPending}
                      onClick={() => enroll.mutate()}
                      className="bg-accent text-accent-fg flex min-h-9 items-center gap-2 rounded-[var(--radius)] px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                    >
                      <Zap className="size-4" aria-hidden />
                      Inscribir ahora
                    </button>
                  )}
                </header>

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
                        </span>
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

              {blocks.length > 0 && <WeeklyGrid blocks={blocks} />}

              {enroll.error && <p className="text-closed text-sm">{(enroll.error as Error).message}</p>}
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
    </div>
  );
}
