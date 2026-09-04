import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronUp, X } from 'lucide-react';
import {
  addPlanItem,
  createPlan,
  createRecommendedPlan,
  deletePlan,
  duplicatePlan,
  fetchCatalog,
  fetchPlan,
  fetchPlans,
  fetchPensum,
  fetchRecommendation,
  fetchTerms,
  removePlanItem,
  sendPlanToCart,
  updatePlanItem,
} from '../lib/api.ts';
import type {
  CatalogCourse,
  CatalogSection,
  Meeting,
  PlanDetail,
  PlanItem,
  PlanToCartResult,
  RecommendationOptionsResponse,
  RecommendationResponse,
  RecommendationStrategy,
  ScheduleCourse,
} from '../../../src/shared/schemas.ts';
import { sectionToBlocks } from '../lib/grid.ts';
import { lectureSections, practiceSections } from '../../../src/shared/sections.ts';
import { formatRange12 } from '../../../src/shared/meetings.ts';
import { downloadICS } from '../lib/ics.ts';
import { WeeklyGrid } from '../components/WeeklyGrid.tsx';
import { CourseChip } from '../components/CourseChip.tsx';
import { CourseSearchBox } from '../components/CourseSearchBox.tsx';
import { SeatBadge } from '../components/SeatBadge.tsx';
import { LiveOpBanner } from '../components/LiveOpBanner.tsx';

const meetingSummary = (section: { meetings: Meeting[] }) =>
  section.meetings
    .map((m) => (m.start ? `${m.days.join('')} ${formatRange12(m.start, m.end)}` : 'TBA'))
    .join(' · ') || 'Sin horario';

// "Pendientes de tu pénsum" (plan §5.3): lo que te falta y se está ofertando
// este término, a un click de entrar al plan.
//
// El plan lo llamaba "elegibles". No lo son: elegible querría decir que cumplís
// los requisitos, y el portal no publica prerequisitos en ninguna parte (§8 del
// plan, confirmado en el recon de Fase 4). Acá "se oferta" = te falta y tiene
// grupos publicados. La app dice lo que sabe, no lo que le gustaría saber.
function PendientesDelPensum({
  term,
  yaEnElPlan,
  onAdd,
}: {
  term: string;
  yaEnElPlan: number[];
  onAdd: (courseId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const pensumQ = useQuery({ queryKey: ['pensum', term], queryFn: () => fetchPensum(term) });

  const sugeridas = (pensumQ.data?.courses ?? []).filter(
    // Sin courseId no hay con qué agregarla: es una materia del pénsum que el
    // catálogo local todavía no conoce.
    (c) => c.status === 'pending' && c.offered && c.courseId !== null && !yaEnElPlan.includes(c.courseId)
  );

  if (!pensumQ.data?.syncedAt || !sugeridas.length) return null;

  return (
    <section className="border-line rounded-[var(--radius)] border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="hover:bg-surface-2 flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors duration-100"
      >
        <span className="text-sm font-medium">Pendientes de tu pénsum</span>
        <span className="text-muted flex items-center gap-2 text-xs">
          <span className="tabular">{sugeridas.length} se ofertan</span>
          {open ? <ChevronUp className="size-4" aria-hidden /> : <ChevronDown className="size-4" aria-hidden />}
        </span>
      </button>
      {open && (
        <ul className="border-line divide-line divide-y border-t">
          {sugeridas.map((c) => (
            <li key={c.code} className="flex min-h-11 items-center justify-between gap-3 px-3 py-2">
              <CourseChip code={c.code} title={c.title ?? c.code} size="sm" />
              <button
                type="button"
                onClick={() => onAdd(c.courseId!)}
                className="border-line hover:bg-surface-2 shrink-0 rounded-[var(--radius)] border px-2.5 py-1 text-xs transition-colors duration-100"
              >
                agregar
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Planner({
  activePlanId,
  onActivePlanChange,
  embedded = false,
  termId = null,
}: {
  activePlanId?: number | null;
  onActivePlanChange?: (planId: number | null) => void;
  embedded?: boolean;
  // El ciclo elegido arriba, en el header del recorrido. Sin esto el planner
  // resolvía su propio ciclo (el primero plannable) y se podía tener elegido
  // "Septiembre de 2026" en la cabecera y generar un plan para "Enero de 2027",
  // con secciones que la etapa siguiente no encontraba.
  termId?: string | null;
}) {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const plansQ = useQuery({ queryKey: ['plans'], queryFn: fetchPlans });
  const termsQ = useQuery({ queryKey: ['terms'], queryFn: fetchTerms });
  const catalogQ = useQuery({ queryKey: ['catalog'], queryFn: () => fetchCatalog() });

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [recommendOpen, setRecommendOpen] = useState(false);
  // Los controles del recomendador son una pregunta ("¿y si tomo 12 créditos y
  // dejo Física para después?"), no una configuración: viven en la pantalla y
  // no se persisten.
  const [maxCredits, setMaxCredits] = useState(18);
  const [strategy, setStrategy] = useState<RecommendationStrategy>('ponerse-al-dia');
  const [excluded, setExcluded] = useState<string[]>([]);
  const planId = activePlanId ?? selectedId ?? plansQ.data?.[0]?.id ?? null;
  const selectPlan = (id: number | null) => {
    setSelectedId(id);
    onActivePlanChange?.(id);
  };
  const clearRecommendedParam = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('recomendado');
    setSearchParams(next, { replace: true });
  };

  // El plan elegido es contexto de /inscripcion, no una selección efímera de la
  // pestaña de materias. Al cargar el primero lo publicamos para que Horario
  // abra exactamente ese mismo plan.
  useEffect(() => {
    if (activePlanId == null && planId != null) onActivePlanChange?.(planId);
  }, [activePlanId, planId, onActivePlanChange]);

  const planQ = useQuery({
    queryKey: ['plan', planId],
    queryFn: () => fetchPlan(planId!),
    enabled: planId != null,
  });

  // Toda mutación de plan devuelve el detalle actualizado: se escribe directo
  // en el cache (cero refetch) y se refresca la lista (créditos/conteos).
  const applyDetail = (detail: PlanDetail) => {
    qc.setQueryData(['plan', detail.id], detail);
    qc.invalidateQueries({ queryKey: ['plans'] });
  };

  const create = useMutation({
    mutationFn: createPlan,
    onSuccess: (detail) => {
      applyDetail(detail);
      selectPlan(detail.id);
      setCreating(false);
    },
  });
  const recommendationTerm =
    termId ??
    termsQ.data?.find((term) => term.isNext && term.hasSections)?.term ??
    termsQ.data?.find((term) => term.hasSections)?.term ??
    null;
  const recommendation = useMutation({
    mutationFn: ({ term, load, skip }: { term: string; load: number; skip: string[] }) =>
      fetchRecommendation(term, { maxCredits: load, exclude: skip }),
  });
  const runRecommendation = (overrides: { load?: number; skip?: string[] } = {}) => {
    if (!recommendationTerm) return;
    recommendation.mutate({
      term: recommendationTerm,
      load: overrides.load ?? maxCredits,
      skip: overrides.skip ?? excluded,
    });
  };
  const createRecommended = useMutation({
    mutationFn: ({ term, load, skip, pick }: { term: string; load: number; skip: string[]; pick: RecommendationStrategy }) =>
      createRecommendedPlan({
        term,
        maxCredits: load,
        exclude: skip,
        strategy: pick,
        name: pick === 'avanzar' ? 'Plan recomendado (avanzar)' : 'Plan recomendado',
      }),
    onSuccess: (detail) => {
      applyDetail(detail);
      // Esta mutación nace de ?recomendado=1. Actualizamos ambos parámetros
      // juntos para no perder el plan recién creado por una carrera entre la
      // pestaña y el callback del contenedor.
      setSelectedId(detail.id);
      const next = new URLSearchParams(searchParams);
      next.delete('recomendado');
      next.set('plan', String(detail.id));
      setSearchParams(next, { replace: true });
      setRecommendOpen(false);
    },
  });

  const openRecommendation = () => {
    if (!recommendationTerm) return;
    setRecommendOpen(true);
    runRecommendation();
  };

  // El Dashboard enlaza con ?recomendado=1 cuando el próximo ciclo no tiene
  // plan. Se abre una sola vez cuando ya conocemos el término objetivo.
  useEffect(() => {
    if (searchParams.get('recomendado') !== '1' || !recommendationTerm || recommendOpen) return;
    setRecommendOpen(true);
    runRecommendation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, recommendationTerm]);
  const duplicate = useMutation({
    mutationFn: () => duplicatePlan(planId!),
    onSuccess: (detail) => {
      applyDetail(detail);
      selectPlan(detail.id);
    },
  });
  const remove = useMutation({
    mutationFn: () => deletePlan(planId!),
    onSuccess: () => {
      qc.removeQueries({ queryKey: ['plan', planId] });
      qc.invalidateQueries({ queryKey: ['plans'] });
      selectPlan(null);
    },
  });
  const toCart = useMutation({
    mutationFn: () => sendPlanToCart(planId!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cart'] }),
  });
  // Agregar desde el panel de pendientes es lo mismo que agregar desde el
  // buscador: mismo applyDetail, o los créditos de la lista de planes quedarían
  // desactualizados.
  const addItemById = useMutation({
    mutationFn: (courseId: number) => addPlanItem(planId!, { courseId }),
    onSuccess: applyDetail,
  });

  const addItem = useMutation({
    mutationFn: (course: CatalogCourse) => addPlanItem(planId!, { courseId: course.id }),
    onSuccess: applyDetail,
  });

  const plan = planQ.data;
  const catalogById = useMemo(
    () => new Map((catalogQ.data?.courses ?? []).map((c) => [c.id, c])),
    [catalogQ.data]
  );

  const blocks = useMemo(
    () =>
      (plan?.items ?? [])
        .filter((item) => item.section)
        .flatMap((item) => sectionToBlocks(item, item.section!)),
    [plan]
  );

  const credits = (plan?.items ?? []).reduce((n, item) => n + (item.credits ?? 0), 0);
  const plannedCount = (plan?.items ?? []).filter((i) => i.section).length;
  const termDates = termsQ.data?.find((t) => t.term === plan?.term);

  // El ICS del plan reutiliza el export del horario: se arma la misma forma
  // (materia → secciones con fechas) con las fechas del término que Mi Horario
  // ya trajo. Sin fechas no hay recurrencia que acotar → botón deshabilitado.
  const exportICS = () => {
    if (!plan || !termDates?.startDate || !termDates.endDate) return;
    const courses: ScheduleCourse[] = plan.items
      .filter((item) => item.section)
      .map((item) => ({
        id: item.courseId,
        code: item.code,
        subject: item.subject,
        catalogNbr: item.catalogNbr,
        title: item.title,
        status: 'enrolled',
        units: item.credits,
        grading: null,
        grade: null,
        sections: [
          {
            ...item.section!,
            startDate: termDates.startDate,
            endDate: termDates.endDate,
          },
        ],
      }));
    downloadICS(courses, plan.term);
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-semibold tracking-tight">Materias</h2>
          <p className="text-muted mt-1 text-sm">
            {embedded
              ? 'Elegí las materias de tu plan antes de decidir sus grupos.'
              : 'Planes por término: materias deseadas, grupos elegidos y el horario que arman.'}
          </p>
        </div>
        <button
          type="button"
          onClick={openRecommendation}
          disabled={!recommendationTerm || recommendation.isPending}
          className="bg-accent text-accent-fg rounded-[var(--radius)] px-3 py-2 text-sm font-medium disabled:opacity-50"
        >
          {recommendation.isPending ? 'Leyendo tu trayectoria…' : 'Generar plan recomendado'}
        </button>
      </header>

      {recommendOpen && (
        <RecommendationPanel
          options={recommendation.data ?? null}
          strategy={strategy}
          maxCredits={maxCredits}
          excluded={excluded}
          pending={recommendation.isPending}
          creating={createRecommended.isPending}
          error={(recommendation.error ?? createRecommended.error) as Error | null}
          onStrategy={setStrategy}
          onMaxCredits={setMaxCredits}
          onToggleExcluded={(code) => {
            const next = excluded.includes(code) ? excluded.filter((c) => c !== code) : [...excluded, code];
            setExcluded(next);
            runRecommendation({ skip: next });
          }}
          onRecalculate={() => runRecommendation()}
          onCreate={() =>
            recommendation.data?.term &&
            createRecommended.mutate({
              term: recommendation.data.term,
              load: maxCredits,
              skip: excluded,
              pick: strategy,
            })
          }
          onClose={() => {
            setRecommendOpen(false);
            clearRecommendedParam();
          }}
        />
      )}

      {/* Tabs por plan + crear */}
      <div className="flex flex-wrap items-center gap-1.5">
        {(plansQ.data ?? []).map((p) => (
          <button
            key={p.id}
            onClick={() => selectPlan(p.id)}
            className={`rounded-[var(--radius)] px-3 py-1.5 text-sm transition-colors duration-100 ${
              p.id === planId
                ? 'bg-accent text-accent-fg font-medium'
                : 'border-line hover:bg-surface-2 border'
            }`}
          >
            {p.name}
            <span className={`tabular ml-2 font-mono text-xs ${p.id === planId ? 'opacity-80' : 'text-muted'}`}>
              {p.itemCount}
            </span>
          </button>
        ))}
        <button
          onClick={() => setCreating(!creating)}
          className="border-line hover:bg-surface-2 rounded-[var(--radius)] border border-dashed px-3 py-1.5 text-sm"
        >
          + Nuevo plan
        </button>
      </div>

      {creating && (
        <CreatePlanForm
          // Solo términos plannable (con secciones en el catálogo): un plan
          // contra una etiqueta suelta de grades no tendría materias que elegir.
          terms={(termsQ.data ?? []).filter((t) => t.hasSections).map((t) => t.term)}
          pending={create.isPending}
          error={create.error as Error | null}
          onCreate={(input) => create.mutate(input)}
        />
      )}

      <LiveOpBanner
        active={toCart.isPending}
        message="Enviando el plan al carrito en PeopleSoft, materia por materia…"
      />
      {toCart.data && <ToCartResults result={toCart.data} />}
      {toCart.error && <p className="text-closed text-sm">{(toCart.error as Error).message}</p>}

      {plansQ.isLoading ? (
        <p className="text-muted text-sm">Cargando planes…</p>
      ) : !plan ? (
        <div className="border-line bg-surface rounded-[var(--radius)] border p-8 text-center">
          <p className="text-sm">Todavía no hay planes.</p>
          <p className="text-muted mt-1 text-sm">Creá uno para empezar a armar tu próximo ciclo.</p>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[400px_minmax(0,1fr)]">
          {/* min-w-0: en móvil esto es una grilla de una columna, y un item de
              grilla no baja de su min-content salvo que se le diga. Sin esto la
              columna se estiraba a lo que midiera la fila más larga del plan y
              la pantalla entera scrolleaba 23px en horizontal. */}
          <section className="min-w-0 space-y-3">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-medium">
                {plan.items.length} materia(s) ·{' '}
                <span className="tabular font-mono">{credits}</span> créditos
              </h2>
              <div className="text-muted flex gap-3 text-xs">
                <button onClick={() => duplicate.mutate()} className="underline underline-offset-2">
                  duplicar
                </button>
                <button
                  onClick={exportICS}
                  disabled={!termDates?.startDate}
                  title={termDates?.startDate ? undefined : 'Sin fechas del término (sincronizá Mi Horario)'}
                  className="underline underline-offset-2 disabled:no-underline disabled:opacity-50"
                >
                  exportar ICS
                </button>
                <button
                  onClick={() => {
                    if (window.confirm(`¿Borrar el plan "${plan.name}"?`)) remove.mutate();
                  }}
                  className="text-closed underline underline-offset-2"
                >
                  borrar
                </button>
              </div>
            </div>

            {catalogQ.data && (
              <CourseSearchBox
                courses={catalogQ.data.courses}
                exclude={plan.items.map((i) => i.courseId)}
                onPick={(course) => addItem.mutate(course)}
              />
            )}
            {addItem.error && <p className="text-closed text-xs">{(addItem.error as Error).message}</p>}

            <PendientesDelPensum
              term={plan.term}
              yaEnElPlan={plan.items.map((i) => i.courseId)}
              onAdd={(courseId) => addItemById.mutate(courseId)}
            />

            {plan.items.length === 0 ? (
              <p className="text-muted text-sm">
                El plan está vacío. Buscá una materia arriba para agregarla como deseada.
              </p>
            ) : (
              <ul className="space-y-2">
                {plan.items.map((item) => (
                  <PlanItemRow
                    key={item.id}
                    item={item}
                    course={catalogById.get(item.courseId)}
                    planId={plan.id}
                    onDetail={applyDetail}
                  />
                ))}
              </ul>
            )}

            <button
              disabled={plannedCount === 0 || toCart.isPending}
              onClick={() => toCart.mutate()}
              title={plannedCount === 0 ? 'Elegí grupo en al menos una materia' : undefined}
              className="bg-accent text-accent-fg w-full rounded-[var(--radius)] px-3 py-2.5 text-sm font-medium disabled:opacity-50"
            >
              {toCart.isPending
                ? 'Enviando al carrito…'
                : `Enviar plan al carrito (${plannedCount} materia(s))`}
            </button>
          </section>

          <section className="min-w-0">
            <WeeklyGrid blocks={blocks} animate />
            {plannedCount === 0 && (
              <p className="text-muted mt-2 text-xs">
                Las materias deseadas no tienen bloque: elegí grupo para verlas en el horario.
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

const STRATEGY_TABS: { id: RecommendationStrategy; label: string; hint: string }[] = [
  {
    id: 'ponerse-al-dia',
    label: 'Ponerme al día',
    hint: 'Drena primero la deuda más vieja del pénsum, aunque no destrabe nada.',
  },
  {
    id: 'avanzar',
    label: 'Avanzar',
    hint: 'Ataca primero las materias que más cosas destraban, para no atrasar la graduación.',
  },
];

function RecommendationPanel({
  options,
  strategy,
  maxCredits,
  excluded,
  pending,
  creating,
  error,
  onStrategy,
  onMaxCredits,
  onToggleExcluded,
  onRecalculate,
  onCreate,
  onClose,
}: {
  options: RecommendationOptionsResponse | null;
  strategy: RecommendationStrategy;
  maxCredits: number;
  excluded: string[];
  pending: boolean;
  creating: boolean;
  error: Error | null;
  onStrategy: (value: RecommendationStrategy) => void;
  onMaxCredits: (value: number) => void;
  onToggleExcluded: (code: string) => void;
  onRecalculate: () => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  const proposal: RecommendationResponse | null =
    options?.proposals.find((item) => item.strategy === strategy) ?? options?.proposals[0] ?? null;

  // Una materia y su laboratorio son UNA decisión académica repartida en dos
  // inscripciones. Listarlos como dos filas sueltas es lo que hacía que se
  // pudiera "quitar el lab" sin entender que eso invalida la materia entera.
  const bundles = useMemo(() => {
    if (!proposal) return [];
    const leads = proposal.recommendations.filter((item) => item.requiredBy == null);
    return leads.map((lead) => ({
      lead,
      attached: proposal.recommendations.filter((item) => item.requiredBy === lead.code),
    }));
  }, [proposal]);

  return (
    // @container y no breakpoints de viewport: este panel vive anidado dentro de
    // dos columnas (el workspace de inscripción y el planner), así que a 1440px
    // de pantalla mide 600px. Con `lg:` creía tener sitio de sobra, partía en dos
    // columnas y el porqué de cada materia terminaba a una palabra por línea.
    <section className="@container border-line bg-surface overflow-hidden rounded-[var(--radius)] border">
      <div className="border-line relative border-b px-4 py-3 pr-20">
        <p className="text-muted text-xs font-medium tracking-wide uppercase">
          {options?.plan
            ? `Plan ${options.plan.code}${options.plan.issuedAt ? ` · emitido ${options.plan.issuedAt}` : ''}`
            : 'Lectura de tu pénsum'}
        </p>
        <h2 className="font-display mt-0.5 text-xl font-semibold tracking-tight">Plan recomendado</h2>
        <p className="text-muted mt-1 max-w-2xl text-sm">
          Cruza el plan académico oficial con lo que ya aprobaste: respeta prerrequisitos, nunca separa una materia de
          su laboratorio, y solo propone lo que cabe en un horario real.
        </p>
        <button type="button" onClick={onClose} className="text-muted hover:text-fg absolute top-2 right-2 min-h-11 px-2 text-sm">
          cerrar
        </button>
      </div>

      {/* Las dos propuestas: cuál conviene no lo decide el algoritmo. */}
      <div className="border-line border-b px-4 py-2.5">
        <div className="border-line flex w-full gap-1 rounded-[var(--radius)] border p-1 sm:w-fit" role="tablist">
          {STRATEGY_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={strategy === tab.id}
              onClick={() => onStrategy(tab.id)}
              className={`flex-1 rounded-[calc(var(--radius)-2px)] px-3 py-1.5 text-sm transition-colors duration-100 sm:flex-none ${
                strategy === tab.id ? 'bg-accent text-accent-fg font-medium' : 'text-muted hover:bg-surface-2 hover:text-fg'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <p className="text-muted mt-1.5 text-xs">{STRATEGY_TABS.find((t) => t.id === strategy)?.hint}</p>
      </div>

      <div className="grid gap-4 p-4 @3xl:grid-cols-[minmax(0,1fr)_240px]">
        <div className="min-w-0">
          {pending ? (
            <p className="text-muted py-4 text-sm">Cruzando plan académico, requisitos, oferta y horarios…</p>
          ) : bundles.length ? (
            <ol className="border-line divide-line divide-y rounded-[var(--radius)] border">
              {bundles.map(({ lead, attached }) => (
                <li key={`${lead.groupId}-${lead.code}`} className="px-3 py-3">
                  <div className="grid gap-2 @lg:grid-cols-[minmax(0,200px)_minmax(0,1fr)]">
                    <div>
                      <CourseChip code={lead.code} title={lead.title} size="sm" />
                      {lead.unlocks > 0 && (
                        <p className="text-muted mt-1 text-xs">destraba {lead.unlocks} materia(s)</p>
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm">{lead.reason}</p>
                      <p className="text-muted tabular mt-1 font-mono text-xs">
                        {lead.section.section ?? lead.section.classNbr} · {meetingSummary(lead.section)}
                      </p>
                      {lead.conditionalOn.length > 0 && (
                        <p className="text-waitlist mt-1 text-xs">
                          Cuenta con que apruebes {lead.conditionalOn.join(' y ')}, que estás cursando ahora.
                        </p>
                      )}
                      {/* El laboratorio va anidado bajo su teoría: son una sola
                          materia y quitarle una mitad la invalida entera. */}
                      {attached.map((extra) => (
                        <div key={extra.code} className="border-line mt-2 border-l-2 pl-2.5">
                          <CourseChip code={extra.code} title={extra.title} size="sm" />
                          <p className="text-muted tabular mt-0.5 font-mono text-xs">
                            {extra.section.section ?? extra.section.classNbr} · {meetingSummary(extra.section)}
                          </p>
                          <p className="text-muted mt-0.5 text-xs">{extra.reason}</p>
                        </div>
                      ))}
                      {lead.kind === 'electiva' && lead.alternatives.length > 0 && (
                        <p className="text-muted mt-1 text-xs">
                          Alternativas: {lead.alternatives.map((alt) => `${alt.title} (${alt.code})`).join(' · ')}
                        </p>
                      )}
                      <button
                        type="button"
                        onClick={() => onToggleExcluded(lead.code)}
                        className="text-muted hover:text-fg mt-1.5 text-xs underline underline-offset-2"
                      >
                        No la quiero este ciclo
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="border-line text-muted rounded-[var(--radius)] border border-dashed p-4 text-sm">
              {proposal?.caveats[0] ?? 'No hay una propuesta calculada todavía.'}
            </p>
          )}

          {proposal && proposal.schedule.omitted.length > 0 && (
            <div className="border-waitlist/35 bg-waitlist/5 mt-3 rounded-[var(--radius)] border px-3 py-2 text-sm">
              <p className="font-medium">Quedaron fuera de este ciclo</p>
              <ul className="mt-1 space-y-0.5 text-xs">
                {proposal.schedule.omitted.map((item) => (
                  <li key={item.code}>
                    <span className="tabular font-mono">{item.code}</span> — {item.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Lo que NO se puede cursar y por qué. Suele ser lo más útil de la
              pantalla: dice exactamente qué aprobar para desatascar la carrera. */}
          {proposal && proposal.blocked.length > 0 && (
            <div className="border-line mt-3 rounded-[var(--radius)] border">
              <p className="border-line border-b px-3 py-2 text-sm font-medium">
                Todavía no podés cursarlas ({proposal.blocked.length})
              </p>
              <ul className="divide-line divide-y">
                {proposal.blocked.map((item) => (
                  <li key={item.code} className="px-3 py-2">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="tabular font-mono text-xs font-medium">{item.code}</span>
                      <span className="text-sm">{item.title}</span>
                      <span className="text-muted text-xs">· {item.periodLabel}</span>
                    </div>
                    <p className="text-muted mt-0.5 text-xs">{item.reason}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {excluded.length > 0 && (
            <div className="border-line mt-3 rounded-[var(--radius)] border border-dashed px-3 py-2">
              <p className="text-muted text-xs">Descartadas por vos para este ciclo:</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {excluded.map((code) => (
                  <button
                    key={code}
                    type="button"
                    onClick={() => onToggleExcluded(code)}
                    className="border-line hover:bg-surface-2 tabular rounded-full border px-2.5 py-1 font-mono text-xs"
                  >
                    {code} <span aria-hidden>×</span>
                    <span className="sr-only">volver a considerar</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && <p className="text-closed mt-2 text-sm">{error.message}</p>}
        </div>

        <aside className="border-line space-y-3 border-t pt-4 @3xl:border-t-0 @3xl:border-l @3xl:pt-0 @3xl:pl-4">
          <label className="block text-sm font-medium">
            Carga máxima
            <span className="mt-1 flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={30}
                value={maxCredits}
                onChange={(event) => onMaxCredits(Number(event.target.value))}
                className="border-line bg-paper tabular w-20 rounded-[var(--radius)] border px-2 py-2 font-mono text-sm"
              />
              <span className="text-muted text-xs">créditos</span>
            </span>
          </label>
          <button
            type="button"
            onClick={onRecalculate}
            disabled={pending || maxCredits <= 0}
            className="border-line hover:bg-surface-2 w-full rounded-[var(--radius)] border px-3 py-2 text-sm disabled:opacity-50"
          >
            Recalcular
          </button>
          {proposal && (
            <p className="tabular font-mono text-sm">
              {proposal.recommendations.length} materia(s) · {proposal.totalCredits}/{proposal.maxCredits} créditos
            </p>
          )}
          <button
            type="button"
            onClick={onCreate}
            disabled={!proposal?.schedule.valid || creating}
            className="bg-accent text-accent-fg w-full rounded-[var(--radius)] px-3 py-2.5 text-sm font-medium disabled:opacity-50"
          >
            {creating ? 'Creando plan…' : 'Crear este plan'}
          </button>
          <p className="text-muted text-xs">
            El plan queda editable. Podés cambiar grupos, quitar materias o elegir otra electiva.
          </p>
          {proposal?.caveats.map((caveat) => (
            <p key={caveat} className="text-muted border-line border-t pt-2 text-xs">{caveat}</p>
          ))}
        </aside>
      </div>
    </section>
  );
}

function CreatePlanForm({
  terms,
  pending,
  error,
  onCreate,
}: {
  terms: string[];
  pending: boolean;
  error: Error | null;
  onCreate: (input: { term: string; name: string }) => void;
}) {
  const [name, setName] = useState('');
  const [term, setTerm] = useState(terms[0] ?? '');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onCreate({ term, name });
      }}
      className="border-line bg-surface flex flex-wrap items-end gap-3 rounded-[var(--radius)] border p-4"
    >
      <label className="flex flex-col gap-1 text-xs">
        Nombre
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ago–Dic 2026"
          className="border-line bg-bg rounded-[var(--radius)] border px-2 py-1.5 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        Término
        {terms.length > 0 ? (
          <select
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            className="border-line bg-bg rounded-[var(--radius)] border px-2 py-1.5 text-sm"
          >
            {terms.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="1930"
            className="border-line bg-bg tabular w-24 rounded-[var(--radius)] border px-2 py-1.5 font-mono text-sm"
          />
        )}
      </label>
      <button
        type="submit"
        disabled={!name.trim() || !term.trim() || pending}
        className="bg-accent text-accent-fg rounded-[var(--radius)] px-3 py-1.5 text-sm font-medium disabled:opacity-50"
      >
        Crear plan
      </button>
      {error && <p className="text-closed w-full text-xs">{error.message}</p>}
    </form>
  );
}

function PlanItemRow({
  item,
  course,
  planId,
  onDetail,
}: {
  item: PlanItem;
  course: CatalogCourse | undefined;
  planId: number;
  onDetail: (d: PlanDetail) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [note, setNote] = useState(item.note ?? '');

  // La unidad de este plan es la fila entera: materia, grupo y práctica del
  // grupo. Separar teóricas de prácticas se decide en shared/sections.ts, que
  // es la misma regla que usan la mesa y el solver del servidor.
  const grupos = lectureSections(course?.sections ?? []);
  const practicas = practiceSections(course?.sections ?? [], item.section);
  const faltaPractica = Boolean(item.section) && practicas.length > 0 && !item.relatedSection;

  const patch = useMutation({
    mutationFn: (p: { sectionId?: number | null; relatedSectionId?: number | null; note?: string | null }) =>
      updatePlanItem(planId, item.id, p),
    onSuccess: (detail) => {
      onDetail(detail);
      // Elegir la teórica NO cierra el selector cuando la materia tiene
      // laboratorio: la elección está a medias y cerrar acá era lo que dejaba
      // items sin práctica que después el portal completaba por su cuenta.
      if (!faltaPractica) setPickerOpen(false);
    },
  });
  const remove = useMutation({
    mutationFn: () => removePlanItem(planId, item.id),
    onSuccess: onDetail,
  });

  const desired = !item.section;

  return (
    <li
      className={`bg-surface rounded-[var(--radius)] border ${
        desired ? 'border-line border-dashed' : 'border-line'
      }`}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <CourseChip code={item.code} title={item.title} classNbr={item.section?.classNbr} size="sm" />
        <div className="flex items-center gap-2">
          {item.credits != null && <span className="text-muted tabular text-xs">{item.credits} cr</span>}
          <button
            onClick={() => setPickerOpen(!pickerOpen)}
            className="border-line hover:bg-surface-2 rounded-[var(--radius)] border px-2 py-1 text-xs"
          >
            {desired ? 'Elegir grupo' : 'Cambiar'}
          </button>
          <button
            onClick={() => remove.mutate()}
            title="Quitar del plan"
            aria-label={`Quitar ${item.title} del plan`}
            className="text-muted hover:text-closed px-1 text-sm"
          >
            ×
          </button>
        </div>
      </div>

      {item.section ? (
        <div className="text-muted flex flex-wrap items-center gap-2 px-3 pb-2.5 text-xs">
          <span className="tabular font-mono">{meetingSummary(item.section)}</span>
          {item.section.instructor && <span>{item.section.instructor}</span>}
          {item.section.seats && <SeatBadge status={item.section.seats.status} />}
        </div>
      ) : (
        <div className="px-3 pb-2.5">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => note !== (item.note ?? '') && patch.mutate({ note: note || null })}
            placeholder="Nota (ej. con Pérez si abre)…"
            className="text-muted placeholder:text-muted/60 w-full bg-transparent text-xs outline-none"
          />
        </div>
      )}

      {pickerOpen && (
        <div className="border-line divide-line divide-y border-t">
          {!course || grupos.length === 0 ? (
            <p className="text-muted px-3 py-2 text-xs">
              Sin grupos publicados este término: queda como deseada.
            </p>
          ) : (
            <>
              {grupos.map((section) => (
                <SectionOption
                  key={section.id}
                  section={section}
                  chosen={item.section?.id === section.id}
                  onPick={() => patch.mutate({ sectionId: section.id })}
                />
              ))}
              {/* La práctica se elige acá y no la elige el portal. Antes esta
                  lista mezclaba las PRA con los grupos, así que elegir "el
                  grupo" podía guardar un laboratorio como si fuera la clase, y
                  al mandar al carrito PeopleSoft marcaba la primera práctica
                  que encontrara. */}
              {item.section && practicas.length > 0 && (
                <div className="bg-surface-2/40 px-3 py-2">
                  <p className="mb-1 text-xs font-medium">
                    Práctica
                    {faltaPractica && <span className="text-closed font-normal"> · falta elegir una</span>}
                  </p>
                  <p className="text-muted mb-1.5 text-[11px]">
                    Se muestran las del mismo campus que el grupo. El portal confirma cuál corresponde al agregarla.
                  </p>
                </div>
              )}
              {item.section &&
                practicas.map((section) => (
                  <SectionOption
                    key={section.id}
                    section={section}
                    chosen={item.relatedSection?.id === section.id}
                    onPick={() => patch.mutate({ relatedSectionId: section.id })}
                  />
                ))}
              {item.section && (
                <button
                  onClick={() => patch.mutate({ sectionId: null })}
                  className="text-muted hover:bg-surface-2 w-full px-3 py-2 text-left text-xs"
                >
                  Quitar grupo (volver a deseada)
                </button>
              )}
            </>
          )}
          {patch.error && <p className="text-closed px-3 py-2 text-xs">{(patch.error as Error).message}</p>}
        </div>
      )}
    </li>
  );
}

function SectionOption({
  section,
  chosen,
  onPick,
}: {
  section: CatalogSection;
  chosen: boolean;
  onPick: () => void;
}) {
  return (
    <button
      onClick={onPick}
      className={`flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left text-xs transition-colors duration-100 ${
        chosen ? 'bg-surface-2' : 'hover:bg-surface-2'
      }`}
    >
      <span className="flex items-center gap-2">
        <span className="tabular font-mono">{section.classNbr}</span>
        <span className="text-muted">{section.section}</span>
        <span className="text-muted tabular font-mono">{meetingSummary(section)}</span>
      </span>
      <span className="flex items-center gap-2">
        {section.instructor && <span className="text-muted">{section.instructor}</span>}
        {section.seats && <SeatBadge status={section.seats.status} />}
        {chosen && <Check className="size-3.5 text-open" aria-label="Seleccionada" />}
      </span>
    </button>
  );
}

function ToCartResults({ result }: { result: PlanToCartResult }) {
  return (
    <ul className="border-line bg-surface divide-line divide-y rounded-[var(--radius)] border text-sm">
      {result.results.map((r) => (
        <li key={r.itemId} className="flex items-center justify-between gap-3 px-4 py-2">
          <span>
            {r.ok ? (r.alreadyInCart ? '· ' : <Check className="mr-1 inline size-3.5 text-open" aria-hidden />) : <X className="mr-1 inline size-3.5 text-closed" aria-hidden />}
            {r.title}
          </span>
          <span className={`text-xs ${r.ok ? 'text-muted' : 'text-closed'}`}>
            {r.ok ? (r.alreadyInCart ? 'ya estaba en el carrito' : 'agregada') : r.error}
          </span>
        </li>
      ))}
    </ul>
  );
}
