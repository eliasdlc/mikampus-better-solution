import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addPlanItem,
  createPlan,
  deletePlan,
  duplicatePlan,
  fetchCatalog,
  fetchPlan,
  fetchPlans,
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

export function Planner() {
  const qc = useQueryClient();
  const plansQ = useQuery({ queryKey: ['plans'], queryFn: fetchPlans });
  const termsQ = useQuery({ queryKey: ['terms'], queryFn: fetchTerms });
  const catalogQ = useQuery({ queryKey: ['catalog'], queryFn: () => fetchCatalog() });

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
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
      </header>

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
          terms={(termsQ.data ?? []).map((t) => t.term)}
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
