import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  RecommendationResponse,
  ScheduleCourse,
} from '../../../src/shared/schemas.ts';
import { sectionToBlocks } from '../lib/grid.ts';
import { downloadICS } from '../lib/ics.ts';
import { WeeklyGrid } from '../components/WeeklyGrid.tsx';
import { CourseChip } from '../components/CourseChip.tsx';
import { CourseSearchBox } from '../components/CourseSearchBox.tsx';
import { SeatBadge } from '../components/SeatBadge.tsx';
import { LiveOpBanner } from '../components/LiveOpBanner.tsx';

const meetingSummary = (section: { meetings: Meeting[] }) =>
  section.meetings
    .map((m) => (m.start ? `${m.days.join('')} ${m.start}–${m.end}` : 'TBA'))
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
          <span aria-hidden>{open ? '▲' : '▼'}</span>
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

export function Planner() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const plansQ = useQuery({ queryKey: ['plans'], queryFn: fetchPlans });
  const termsQ = useQuery({ queryKey: ['terms'], queryFn: fetchTerms });
  const catalogQ = useQuery({ queryKey: ['catalog'], queryFn: () => fetchCatalog() });

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [recommendOpen, setRecommendOpen] = useState(false);
  const [maxCredits, setMaxCredits] = useState(18);
  const planId = selectedId ?? plansQ.data?.[0]?.id ?? null;

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
      setSelectedId(detail.id);
      setCreating(false);
    },
  });
  const recommendationTerm =
    termsQ.data?.find((term) => term.isNext && term.hasSections)?.term ??
    termsQ.data?.find((term) => term.hasSections)?.term ??
    null;
  const recommendation = useMutation({
    mutationFn: ({ term, load }: { term: string; load: number }) => fetchRecommendation(term, load),
  });
  const createRecommended = useMutation({
    mutationFn: ({ term, load }: { term: string; load: number }) =>
      createRecommendedPlan({ term, maxCredits: load, name: 'Plan recomendado' }),
    onSuccess: (detail) => {
      applyDetail(detail);
      setSelectedId(detail.id);
      setRecommendOpen(false);
      setSearchParams({}, { replace: true });
    },
  });

  const openRecommendation = () => {
    if (!recommendationTerm) return;
    setRecommendOpen(true);
    recommendation.mutate({ term: recommendationTerm, load: maxCredits });
  };

  // El Dashboard enlaza con ?recomendado=1 cuando el próximo ciclo no tiene
  // plan. Se abre una sola vez cuando ya conocemos el término objetivo.
  useEffect(() => {
    if (searchParams.get('recomendado') !== '1' || !recommendationTerm || recommendOpen) return;
    setRecommendOpen(true);
    recommendation.mutate({ term: recommendationTerm, load: maxCredits });
  }, [searchParams, recommendationTerm]);
  const duplicate = useMutation({
    mutationFn: () => duplicatePlan(planId!),
    onSuccess: (detail) => {
      applyDetail(detail);
      setSelectedId(detail.id);
    },
  });
  const remove = useMutation({
    mutationFn: () => deletePlan(planId!),
    onSuccess: () => {
      qc.removeQueries({ queryKey: ['plan', planId] });
      qc.invalidateQueries({ queryKey: ['plans'] });
      setSelectedId(null);
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
          <h1 className="font-display text-2xl font-semibold tracking-tight">Planner</h1>
          <p className="text-muted mt-1 text-sm">
            Planes por término: materias deseadas, grupos elegidos y el horario que arman.
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
          proposal={recommendation.data ?? null}
          maxCredits={maxCredits}
          pending={recommendation.isPending}
          creating={createRecommended.isPending}
          error={(recommendation.error ?? createRecommended.error) as Error | null}
          onMaxCredits={setMaxCredits}
          onRecalculate={() => recommendationTerm && recommendation.mutate({ term: recommendationTerm, load: maxCredits })}
          onCreate={() =>
            recommendation.data &&
            createRecommended.mutate({ term: recommendation.data.term, load: recommendation.data.maxCredits })
          }
          onClose={() => {
            setRecommendOpen(false);
            setSearchParams({}, { replace: true });
          }}
        />
      )}

      {/* Tabs por plan + crear */}
      <div className="flex flex-wrap items-center gap-1.5">
        {(plansQ.data ?? []).map((p) => (
          <button
            key={p.id}
            onClick={() => setSelectedId(p.id)}
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
          <section className="space-y-3">
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

function RecommendationPanel({
  proposal,
  maxCredits,
  pending,
  creating,
  error,
  onMaxCredits,
  onRecalculate,
  onCreate,
  onClose,
}: {
  proposal: RecommendationResponse | null;
  maxCredits: number;
  pending: boolean;
  creating: boolean;
  error: Error | null;
  onMaxCredits: (value: number) => void;
  onRecalculate: () => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  return (
    <section className="border-line bg-surface overflow-hidden rounded-[var(--radius)] border">
      <div className="border-line relative border-b px-4 py-3 pr-20">
        <div>
          <p className="text-muted text-xs font-medium tracking-wide uppercase">Lectura de tu pénsum</p>
          <h2 className="font-display mt-0.5 text-xl font-semibold tracking-tight">Plan recomendado</h2>
          <p className="text-muted mt-1 max-w-2xl text-sm">
            Prioriza el período pendiente más viejo y conserva solo materias que caben juntas.
          </p>
        </div>
        <button type="button" onClick={onClose} className="text-muted hover:text-fg absolute top-2 right-2 min-h-11 px-2 text-sm">
          cerrar
        </button>
      </div>

      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_220px]">
        <div>
          {pending ? (
            <p className="text-muted py-4 text-sm">Cruzando requisitos, oferta y horarios…</p>
          ) : proposal?.recommendations.length ? (
            <ol className="border-line divide-line divide-y rounded-[var(--radius)] border">
              {proposal.recommendations.map((item) => (
                <li key={`${item.groupId}-${item.code}`} className="grid gap-2 px-3 py-3 sm:grid-cols-[minmax(0,220px)_1fr]">
                  <CourseChip code={item.code} title={item.title} size="sm" />
                  <div className="min-w-0">
                    <p className="text-sm">{item.reason}</p>
                    <p className="text-muted tabular mt-1 font-mono text-xs">
                      {item.section.section ?? item.section.classNbr} · {meetingSummary(item.section)}
                    </p>
                    {item.kind === 'electiva' && item.alternatives.length > 0 && (
                      <p className="text-muted mt-1 text-xs">
                        Alternativas: {item.alternatives.map((alt) => `${alt.title} (${alt.code})`).join(' · ')}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="border-line text-muted rounded-[var(--radius)] border border-dashed p-4 text-sm">
              {proposal?.caveats[0] ?? 'No hay una propuesta calculada todavía.'}
            </p>
          )}

          {proposal?.schedule.adjusted && (
            <div className="border-waitlist/35 bg-waitlist/5 mt-3 rounded-[var(--radius)] border px-3 py-2 text-sm">
              Se redujo la propuesta para evitar choques. {proposal.schedule.omitted.length} requisito(s) quedaron fuera.
            </div>
          )}
          {error && <p className="text-closed mt-2 text-sm">{error.message}</p>}
        </div>

        <aside className="border-line space-y-3 border-t pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-4">
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

  const patch = useMutation({
    mutationFn: (p: { sectionId?: number | null; note?: string | null }) =>
      updatePlanItem(planId, item.id, p),
    onSuccess: (detail) => {
      onDetail(detail);
      setPickerOpen(false);
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
          {!course || course.sections.length === 0 ? (
            <p className="text-muted px-3 py-2 text-xs">
              Sin grupos publicados este término: queda como deseada.
            </p>
          ) : (
            <>
              {course.sections.map((section) => (
                <SectionOption
                  key={section.id}
                  section={section}
                  chosen={item.section?.id === section.id}
                  onPick={() => patch.mutate({ sectionId: section.id })}
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
        {chosen && <span aria-hidden>✓</span>}
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
            {r.ok ? (r.alreadyInCart ? '· ' : '✓ ') : '✗ '}
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
