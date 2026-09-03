import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Lock, LockKeyholeOpen, X } from 'lucide-react';
import {
  addPlanItem,
  createPlan,
  addToCart,
  fetchCatalog,
  fetchAcademicCalendar,
  fetchMySchedule,
  fetchPlan,
  fetchPlans,
  updatePlanItem,
} from '../lib/api.ts';
import type { CatalogCourse, CatalogSection } from '../../../src/shared/schemas.ts';
import { portalCatalogNbr } from '../../../src/shared/courseCode.ts';
import {
  solveCombinations,
  DEFAULT_WEIGHTS,
  type CandidateSection,
  type Combination,
  type Weights,
} from '../../../src/shared/solver.ts';
import { toMinutes } from '../../../src/shared/meetings.ts';
import { sectionToBlocks, type Block } from '../lib/grid.ts';
import { lectureSections, practiceSections, seatsAreFresh } from '../../../src/shared/sections.ts';
import { courseColor } from '../lib/color.ts';
import { WeeklyGrid } from '../components/WeeklyGrid.tsx';
import { CourseChip } from '../components/CourseChip.tsx';
import { CourseSearchBox } from '../components/CourseSearchBox.tsx';
import { SeatBadge } from '../components/SeatBadge.tsx';
import { LiveOpBanner } from '../components/LiveOpBanner.tsx';
import { MoreSectionsButton } from '../components/MoreSectionsButton.tsx';
import { Condiciones, type CondicionesValue, SIN_CONDICIONES } from '../components/Condiciones.tsx';
import { preinscriptionFor } from '../../../src/shared/calendarPhases.ts';

// El builder trabaja en memoria: candidatas + una selección por materia +
// candados. Nada se persiste hasta "Guardar en plan" o "Enviar al carrito" —
// probar combinaciones tiene que ser gratis.

const toCandidate = (course: CatalogCourse, section: CatalogSection): CandidateSection => ({
  id: section.id,
  courseId: course.id,
  code: course.code,
  title: course.title,
  classNbr: section.classNbr,
  section: section.section,
  component: section.component,
  instructor: section.instructor,
  meetings: section.meetings,
});

type CartResult = { code: string; title: string; ok: boolean; error: string | null };

// Por debajo de esto el catálogo del ciclo no es una oferta, es lo poco que un
// barrido alcanzó a traer. Cinco materias no son un ciclo.
const MINIMO_DE_OFERTA = 40;

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// "11 al 13 de noviembre". Se arma desde el texto YYYY-MM-DD: `new Date(iso)` lo
// leería como medianoche UTC y en Santo Domingo correría el día hacia atrás.
function rangoLegible(startsOn: string, endsOn: string): string {
  const [, m1, d1] = startsOn.split('-').map(Number);
  const [, m2, d2] = endsOn.split('-').map(Number);
  if (startsOn === endsOn) return `${d1} de ${MESES[m1 - 1]}`;
  return m1 === m2 ? `${d1} al ${d2} de ${MESES[m1 - 1]}` : `${d1} de ${MESES[m1 - 1]} al ${d2} de ${MESES[m2 - 1]}`;
}

export function Builder({
  activePlanId,
  onActivePlanChange,
  embedded = false,
  termId = null,
  termCode = null,
}: {
  activePlanId?: number | null;
  onActivePlanChange?: (planId: number | null) => void;
  embedded?: boolean;
  // El identificador del ciclo elegido arriba (STRM si lo hay, si no la
  // etiqueta). Acota qué secciones se muestran: un plan pertenece a un ciclo, y
  // ofrecer el grupo de otro término es ofrecer algo que no se puede inscribir.
  termId?: string | null;
  // El STRM. Es lo único que PeopleSoft acepta para consultar en vivo, así que
  // sin él "Ver más grupos" no se ofrece.
  termCode?: string | null;
}) {
  const qc = useQueryClient();
  const catalogQ = useQuery({ queryKey: ['catalog'], queryFn: () => fetchCatalog() });
  // El horario ya inscrito de este ciclo: entra como bloque fijo de la grilla.
  const scheduleQ = useQuery({
    queryKey: ['my-schedule', termId],
    queryFn: () => fetchMySchedule(termId ?? undefined),
    enabled: Boolean(termId),
  });
  const plansQ = useQuery({ queryKey: ['plans'], queryFn: fetchPlans });

  // El plan es la fuente de verdad, no un destino al que se guarda al final.
  //
  // Antes las candidatas, los grupos elegidos y los candados vivían en useState:
  // el contenedor desmonta esta etapa al pasar a Carrito, así que todo lo que
  // elegiste acá se perdía salvo que hubieras apretado "Guardar en plan", un
  // botón secundario y opcional. El carrito veía la materia sin grupo y el
  // portal terminaba eligiendo por vos.
  const [candidateIds, setCandidateIds] = useState<number[]>([]);
  const [selections, setSelections] = useState<Map<number, number>>(new Map()); // courseId → sectionId
  const [practices, setPractices] = useState<Map<number, number>>(new Map()); // courseId → sectionId de la PRA
  const [locks, setLocks] = useState<Set<number>>(new Set()); // courseIds con candado
  const [hover, setHover] = useState<{ courseId: number; sectionId: number } | null>(null);
  const [loadedPlanId, setLoadedPlanId] = useState<number | null>(null);
  const [weights, setWeights] = useState<Weights>(DEFAULT_WEIGHTS);
  const [condiciones, setCondiciones] = useState<CondicionesValue>(SIN_CONDICIONES);
  const [suggesting, setSuggesting] = useState(false);

  // Las secciones se acotan al ciclo elegido antes de tocar nada más. Sin esto
  // el builder listaba los grupos de TODOS los términos que el catálogo tuviera
  // guardados, mezclados y sin distintivo: se podía armar un horario perfecto
  // con la sección de un ciclo que ya pasó.
  const byId = useMemo(() => {
    const entries = (catalogQ.data?.courses ?? []).map((c) => [
      c.id,
      termId ? { ...c, sections: c.sections.filter((s) => s.term === termId) } : c,
    ] as const);
    return new Map<number, CatalogCourse>(entries);
  }, [catalogQ.data, termId]);
  const candidates = candidateIds
    .map((id) => byId.get(id))
    .filter((c): c is CatalogCourse => !!c);

  const sectionOf = (course: CatalogCourse, sectionId: number | undefined) =>
    course.sections.find((s) => s.id === sectionId);

  // Cargar las materias de un plan como candidatas (con sus grupos y candados).
  const loadPlan = useMutation({
    mutationFn: (id: number) => fetchPlan(id),
    onSuccess: (plan) => {
      setLoadedPlanId(plan.id);
      onActivePlanChange?.(plan.id);
      setCandidateIds(plan.items.map((i) => i.courseId));
      setSelections(new Map(plan.items.filter((i) => i.section).map((i) => [i.courseId, i.section!.id])));
      setPractices(
        new Map(plan.items.filter((i) => i.relatedSection).map((i) => [i.courseId, i.relatedSection!.id]))
      );
      setLocks(new Set(plan.items.filter((i) => i.locked).map((i) => i.courseId)));
    },
  });

  // Al entrar a la vista Horario, el plan elegido en Materias se carga sin
  // pedirle al estudiante que vuelva a escogerlo. Si cambia de plan desde el
  // selector de esta vista, la misma selección se propaga al contenedor.
  useEffect(() => {
    if (activePlanId != null && activePlanId !== loadedPlanId) loadPlan.mutate(activePlanId);
    // `loadPlan` es la mutación estable de React Query; el efecto responde al
    // id, no a los rerenders de los controles del builder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePlanId, loadedPlanId]);

  // Escribe la elección en el plan en cuanto ocurre. Es best-effort a propósito:
  // la pantalla ya se actualizó de forma optimista, y un fallo de red no puede
  // deshacer un click en la etapa donde se decide el horario. La próxima
  // escritura reintenta el estado completo de esa materia.
  const persist = useMutation({
    mutationFn: async (input: { courseId: number; sectionId: number | null; relatedSectionId: number | null }) => {
      // Sin plan abierto se crea uno. Antes esta etapa se podía usar entera sin
      // plan y todo lo elegido moría al cambiar de paso; pedir "creá un plan
      // primero" para poder elegir un grupo es burocracia, no una decisión.
      let planId = loadedPlanId;
      if (planId == null) {
        if (!termId) return;
        const nuevo = await createPlan({ term: termId, name: 'Mi ciclo' });
        planId = nuevo.id;
        setLoadedPlanId(planId);
        onActivePlanChange?.(planId);
      }
      const plan = await fetchPlan(planId);
      const item = plan.items.find((i) => i.courseId === input.courseId);
      if (item) {
        await updatePlanItem(planId, item.id, {
          sectionId: input.sectionId,
          relatedSectionId: input.relatedSectionId,
        });
      } else {
        await addPlanItem(planId, {
          courseId: input.courseId,
          sectionId: input.sectionId,
          relatedSectionId: input.relatedSectionId,
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plan', loadedPlanId] });
      qc.invalidateQueries({ queryKey: ['plans'] });
    },
  });

  const select = (courseId: number, sectionId: number) => {
    const next = new Map(selections);
    const nextPractices = new Map(practices);
    // Click en la sección ya elegida la des-elige; en otra, swap instantáneo.
    if (next.get(courseId) === sectionId) {
      next.delete(courseId);
      setLocks((l) => {
        const nl = new Set(l);
        nl.delete(courseId);
        return nl;
      });
    } else {
      next.set(courseId, sectionId);
    }
    // Cambiar de grupo se lleva la práctica: el laboratorio del grupo anterior
    // no es el de este, y muchas veces ni siquiera es del mismo campus.
    nextPractices.delete(courseId);
    setSelections(next);
    setPractices(nextPractices);
    persist.mutate({ courseId, sectionId: next.get(courseId) ?? null, relatedSectionId: null });
  };

  const selectPractice = (courseId: number, sectionId: number) => {
    const next = new Map(practices);
    if (next.get(courseId) === sectionId) next.delete(courseId);
    else next.set(courseId, sectionId);
    setPractices(next);
    persist.mutate({
      courseId,
      sectionId: selections.get(courseId) ?? null,
      relatedSectionId: next.get(courseId) ?? null,
    });
  };

  // Lo que ya estás cursando es el piso del horario, no una opción. Sin esto se
  // podía armar y guardar un horario que choca con una materia inscrita y la
  // grilla lo dibujaba limpio, mientras la mesa marcaba el mismo choque rayado.
  const enrolledBlocks: Block[] = useMemo(
    () =>
      (scheduleQ.data?.courses ?? []).flatMap((course) =>
        course.sections.flatMap((section) => sectionToBlocks(course, section))
      ),
    [scheduleQ.data]
  );

  const blocks: Block[] = useMemo(() => {
    const chosen = candidates.flatMap((course) => {
      const section = sectionOf(course, selections.get(course.id));
      return section ? sectionToBlocks(course, section) : [];
    });
    const practiceBlocks = candidates.flatMap((course) => {
      const section = sectionOf(course, practices.get(course.id));
      return section ? sectionToBlocks(course, section) : [];
    });
    const all = [...enrolledBlocks, ...chosen, ...practiceBlocks];
    // Preview fantasma: hover sobre una sección NO elegida.
    if (hover && selections.get(hover.courseId) !== hover.sectionId) {
      const course = byId.get(hover.courseId);
      const section = course && sectionOf(course, hover.sectionId);
      if (course && section) all.push(...sectionToBlocks(course, section, { ghost: true }));
    }
    return all;
  }, [candidates, selections, practices, hover, byId, enrolledBlocks]);

  // Las combinaciones respetan candados dejando la sección fijada como única
  // candidata de su materia (el solver no conoce el concepto).
  const combos = useMemo(() => {
    if (!suggesting || candidates.length === 0) return null;
    return solveCombinations(
      candidates.map((course) => {
        const lockedSection = locks.has(course.id) ? sectionOf(course, selections.get(course.id)) : null;
        const sections = lockedSection ? [lockedSection] : course.sections;
        return {
          courseId: course.id,
          code: course.code,
          title: course.title,
          sections: sections.map((s) => toCandidate(course, s)),
        };
      }),
      { weights }
    );
  }, [suggesting, candidates, locks, selections, weights]);

  const applyCombo = (combo: Combination) => {
    setSelections(new Map(combo.sections.map((s) => [s.courseId, s.id])));
  };

  // Guardar las selecciones en el plan cargado: actualiza items existentes y
  // agrega los que el builder sumó por búsqueda.
  const saveToPlan = useMutation({
    mutationFn: async () => {
      const plan = await fetchPlan(loadedPlanId!);
      const itemByCourse = new Map(plan.items.map((i) => [i.courseId, i]));
      for (const course of candidates) {
        const sectionId = selections.get(course.id) ?? null;
        const item = itemByCourse.get(course.id);
        if (item) {
          if ((item.section?.id ?? null) !== sectionId || item.locked !== locks.has(course.id)) {
            await updatePlanItem(plan.id, item.id, { sectionId, locked: locks.has(course.id) });
          }
        } else {
          await addPlanItem(plan.id, { courseId: course.id, sectionId });
        }
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plan', loadedPlanId] });
      qc.invalidateQueries({ queryKey: ['plans'] });
    },
  });

  // Enviar las selecciones directo al carrito real, una por una (cada una es
  // una operación Playwright de segundos; el banner lo dice).
  const toCart = useMutation({
    mutationFn: async () => {
      const results: CartResult[] = [];
      for (const course of candidates) {
        const section = sectionOf(course, selections.get(course.id));
        if (!section) continue;
        try {
          // La práctica viaja con la teórica. Sin ella, PeopleSoft marca el
          // primer radio del paso Select y te inscribe en un laboratorio que
          // nunca elegiste, muchas veces de otro día u otro campus.
          const practica = sectionOf(course, practices.get(course.id));
          const r = await addToCart({
            term: section.term,
            career: course.career ?? 'GRDO',
            courseNumber: portalCatalogNbr(course),
            classNbr: section.classNbr,
            relatedClassNbr: practica?.classNbr ?? null,
          });
          results.push({ code: course.code, title: course.title, ok: true, error: r.alreadyInCart ? 'ya estaba en el carrito' : null });
        } catch (err) {
          results.push({ code: course.code, title: course.title, ok: false, error: (err as Error).message });
        }
      }
      return results;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cart'] }),
  });

  const selectedCount = candidates.filter((c) => selections.has(c.id)).length;

  // Cuántos grupos hay publicados de este ciclo en el catálogo local. Es la
  // señal de "todavía no hay oferta": el 1940 tenía 18 secciones de 5 materias
  // en septiembre, y la mesa mostraba eso sin explicar nada.
  const gruposDelCiclo = useMemo(
    () => (termId ? [...byId.values()].reduce((total, course) => total + lectureSections(course.sections).length, 0) : 0),
    [byId, termId]
  );
  const sinOferta = Boolean(termId) && gruposDelCiclo < MINIMO_DE_OFERTA && candidates.length === 0;

  // El calendario entero, no la ventana que dibuja Inicio: la preinscripción del
  // próximo ciclo cae en noviembre, o sea más de una docena de fechas adelante.
  // Con el límite de Inicio (seis) la fecha nunca aparecía y el aviso salía sin
  // ella, que es justo el dato por el que existe. Solo se pide cuando hace falta.
  const calendar = useQuery({
    queryKey: ['academic-calendar', 50, 0],
    queryFn: () => fetchAcademicCalendar(50, 0),
    enabled: sinOferta,
  });
  const preinscripcion = useMemo(() => {
    if (!termCode || !calendar.data) return null;
    const fila = preinscriptionFor(calendar.data.timeline.future, termCode);
    return fila ? rangoLegible(fila.startsOn, fila.endsOn) : null;
  }, [termCode, calendar.data]);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-semibold tracking-tight">Horario</h2>
          <p className="text-muted mt-1 text-sm">
            {embedded
              ? 'Elegí grupos para las materias del mismo plan; el solver sugiere combinaciones sin choque.'
              : 'Elegí secciones y mirá el horario armarse; el solver sugiere combinaciones sin choque.'}
          </p>
        </div>
        {!embedded && (plansQ.data ?? []).length > 0 && (
          <label className="text-muted flex items-center gap-2 text-xs">
            desde un plan:
            <select
              value={loadedPlanId ?? ''}
              onChange={(e) => e.target.value && loadPlan.mutate(Number(e.target.value))}
              className="border-line bg-surface rounded-[var(--radius)] border px-2 py-1.5 text-sm"
            >
              <option value="">elegir…</option>
              {plansQ.data!.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      <LiveOpBanner
        active={toCart.isPending}
        message="Enviando secciones al carrito en PeopleSoft, una por una…"
      />
      {toCart.data && (
        <ul className="border-line bg-surface divide-line divide-y rounded-[var(--radius)] border text-sm">
          {toCart.data.map((r) => (
            <li key={r.code} className="flex items-center justify-between gap-3 px-4 py-2">
              <span>
                {r.ok ? <Check className="mr-1 inline size-3.5 text-open" aria-hidden /> : <X className="mr-1 inline size-3.5 text-closed" aria-hidden />}
                {r.title}
              </span>
              <span className={`text-xs ${r.ok ? 'text-muted' : 'text-closed'}`}>{r.error ?? 'agregada'}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Sin candidatas no hay dos columnas que balancear: la etapa se colapsa a
          una sola. Antes la grilla semanal se dibujaba igual —catorce filas de
          horas vacías ocupando media pantalla al lado de un párrafo de dos
          líneas—, y el resultado se leía como una pantalla rota en vez de como
          una pantalla que todavía no empezó. */}
      {/* Las condiciones duras vinieron de la mesa junto con el resto del paso.
          No son pesos del solver: son "no antes de las 8" y "libre los viernes",
          y una combinación que las viola no se penaliza, se descarta. */}
      {termId && (
        <Condiciones
          term={termId}
          value={condiciones}
          onChange={setCondiciones}
          onApply={(combo) => {
            for (const section of combo) select(section.courseId, section.id);
          }}
        />
      )}

      <div className={`grid gap-6 ${candidates.length > 0 ? 'lg:grid-cols-[380px_minmax(0,1fr)]' : ''}`}>
        <section className="space-y-3">
          {catalogQ.data && (
            <CourseSearchBox
              courses={catalogQ.data.courses}
              exclude={candidateIds}
              placeholder="Agregar materia candidata…"
              onPick={(course) => {
                setCandidateIds((ids) => [...ids, course.id]);
                // La candidata también entra al plan, como deseada. Si solo
                // viviera en memoria, pasar a Carrito la borraría.
                persist.mutate({ courseId: course.id, sectionId: null, relatedSectionId: null });
              }}
            />
          )}

          {sinOferta ? (
            // Planear el próximo ciclo es posible desde hoy; elegir su grupo no,
            // porque PUCMM publica la oferta cerca de la preinscripción. Decirlo
            // con la fecha real es mejor que mostrar una lista casi vacía y
            // dejar creer que eso es todo lo que hay.
            <div className="border-line text-muted rounded-[var(--radius)] border border-dashed p-6 text-center">
              <p className="text-fg text-sm">La oferta de este ciclo todavía no se publicó</p>
              <p className="mx-auto mt-1 max-w-sm text-xs">
                {preinscripcion
                  ? `PUCMM publica los grupos cerca de la preinscripción, del ${preinscripcion}. Hasta entonces podés decidir QUÉ cursar en la etapa Plan: el pénsum y tus pendientes ya están.`
                  : 'PUCMM todavía no publicó los grupos de este ciclo. Hasta entonces podés decidir QUÉ cursar en la etapa Plan: el pénsum y tus pendientes ya están.'}
              </p>
            </div>
          ) : candidates.length === 0 ? (
            <div className="border-line text-muted rounded-[var(--radius)] border border-dashed p-6 text-center">
              <p className="text-fg text-sm">Todavía no elegiste qué cursar</p>
              <p className="mx-auto mt-1 max-w-sm text-xs">
                Buscá una materia arriba o volvé a la etapa <span className="text-fg">Plan</span> y cargá uno: acá
                elegís el grupo de cada una y el horario se arma solo.
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {candidates.map((course) => (
                <CandidateCard
                  key={course.id}
                  course={course}
                  termCode={termCode}
                  selectedId={selections.get(course.id)}
                  practiceId={practices.get(course.id)}
                  locked={locks.has(course.id)}
                  onSelect={(sectionId) => select(course.id, sectionId)}
                  onSelectPractice={(sectionId) => selectPractice(course.id, sectionId)}
                  onHover={(sectionId) => setHover(sectionId ? { courseId: course.id, sectionId } : null)}
                  onToggleLock={() =>
                    setLocks((l) => {
                      const next = new Set(l);
                      if (next.has(course.id)) next.delete(course.id);
                      else if (selections.has(course.id)) next.add(course.id);
                      return next;
                    })
                  }
                  onRemove={() => {
                    setCandidateIds((ids) => ids.filter((id) => id !== course.id));
                    setSelections((s) => {
                      const next = new Map(s);
                      next.delete(course.id);
                      return next;
                    });
                  }}
                />
              ))}
            </ul>
          )}

          {candidates.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setSuggesting(!suggesting)}
                className={`rounded-[var(--radius)] px-3 py-2 text-sm font-medium ${
                  suggesting ? 'bg-accent text-accent-fg' : 'border-line hover:bg-surface-2 border'
                }`}
              >
                Sugerir combinaciones
              </button>
              <button
                disabled={!loadedPlanId || saveToPlan.isPending}
                onClick={() => saveToPlan.mutate()}
                title={loadedPlanId ? undefined : 'Elegí un plan primero'}
                className="border-line hover:bg-surface-2 rounded-[var(--radius)] border px-3 py-2 text-sm disabled:opacity-50"
              >
                {saveToPlan.isPending ? 'Guardando…' : saveToPlan.isSuccess ? <><Check className="mr-1 inline size-3.5" aria-hidden />Guardado</> : 'Guardar en plan'}
              </button>
              <button
                disabled={selectedCount === 0 || toCart.isPending}
                onClick={() => toCart.mutate()}
                className="border-line hover:bg-surface-2 rounded-[var(--radius)] border px-3 py-2 text-sm disabled:opacity-50"
              >
                Enviar al carrito ({selectedCount})
              </button>
            </div>
          )}
          {saveToPlan.error && <p className="text-closed text-xs">{(saveToPlan.error as Error).message}</p>}
        </section>

        <section className={`min-w-0 space-y-4 ${candidates.length === 0 ? 'hidden' : ''}`}>
          <WeeklyGrid blocks={blocks} animate />

          {suggesting && combos && (
            <SuggestionsPanel
              combos={combos.combinations}
              truncated={combos.truncated}
              weights={weights}
              onWeights={setWeights}
              onApply={applyCombo}
            />
          )}
        </section>
      </div>
    </div>
  );
}

// La misma regla de honestidad que la mesa: sin observación reciente no se
// afirma "Abierta". Esta era la pantalla que mentía, y es justo desde la que se
// decide qué grupo tomar.
function EstadoCupo({ section }: { section: CatalogSection }) {
  if (!section.seats) return <span className="text-muted text-[11px]">sin dato</span>;
  if (!seatsAreFresh(section.seatsUpdatedAt)) {
    return <span className="text-muted text-[11px]">sin dato reciente</span>;
  }
  return <SeatBadge status={section.seats.status} />;
}

function CandidateCard({
  course,
  termCode,
  selectedId,
  practiceId,
  locked,
  onSelect,
  onSelectPractice,
  onHover,
  onToggleLock,
  onRemove,
}: {
  course: CatalogCourse;
  termCode: string | null;
  selectedId: number | undefined;
  practiceId: number | undefined;
  locked: boolean;
  onSelect: (sectionId: number) => void;
  onSelectPractice: (sectionId: number) => void;
  onHover: (sectionId: number | null) => void;
  onToggleLock: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(true);

  // Los grupos son las teóricas. Las prácticas no son grupos alternativos de la
  // materia: son la otra mitad del mismo grupo, y listarlas juntas hacía que
  // elegir "el grupo" pudiera guardar un laboratorio como si fuera la clase.
  const grupos = lectureSections(course.sections);
  const teorica = grupos.find((section) => section.id === selectedId) ?? null;
  const practicas = practiceSections(course.sections, teorica);
  const faltaPractica = Boolean(teorica) && practicas.length > 0 && practiceId == null;

  return (
    <li className="border-line bg-surface rounded-[var(--radius)] border">
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <button onClick={() => setOpen(!open)} className="min-w-0 text-left">
          <CourseChip code={course.code} title={course.title} size="sm" />
          <span className="text-muted mt-0.5 block text-xs">
            {grupos.length === 0
              ? 'sin grupos guardados de este ciclo'
              : `${grupos.length} grupo(s)${practicas.length ? ` · ${practicas.length} práctica(s)` : ''}`}
            {faltaPractica && <span className="text-closed"> · falta la práctica</span>}
          </span>
        </button>
        <div className="flex items-center gap-1.5">
          {selectedId != null && (
            <button
              onClick={onToggleLock}
              title={locked ? 'Quitar candado' : 'Fijar esta sección (el solver no la cambia)'}
              aria-pressed={locked}
              className={`rounded-[var(--radius)] px-1.5 py-0.5 text-sm ${locked ? 'bg-surface-2' : 'opacity-40 hover:opacity-100'}`}
            >
              {locked ? <Lock className="size-4" aria-hidden /> : <LockKeyholeOpen className="size-4" aria-hidden />}
            </button>
          )}
          <button
            onClick={onRemove}
            title="Quitar candidata"
            aria-label={`Quitar ${course.title}`}
            className="text-muted hover:text-closed px-1 text-sm"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      </div>

      {open && (
        <div className="border-line divide-line divide-y border-t" onMouseLeave={() => onHover(null)}>
          {grupos.length === 0 && (
            <p className="text-muted px-3 py-2 text-xs">
              El catálogo local no tiene grupos de esta materia para este ciclo. Traelos del portal.
            </p>
          )}
          {grupos.map((section) => {
            const chosen = section.id === selectedId;
            return (
              <button
                key={section.id}
                onClick={() => onSelect(section.id)}
                onMouseEnter={() => onHover(section.id)}
                onFocus={() => onHover(section.id)}
                onBlur={() => onHover(null)}
                className={`flex w-full flex-wrap items-center justify-between gap-x-2 px-3 py-2 text-left text-xs transition-colors duration-100 ${
                  chosen ? 'bg-surface-2' : 'hover:bg-surface-2'
                }`}
                style={chosen ? { boxShadow: `inset 2px 0 0 ${courseColor(course.code)}` } : undefined}
              >
                <span className="flex items-center gap-2">
                  <span className="tabular font-mono">{section.classNbr}</span>
                  <span className="text-muted tabular font-mono">
                    {section.meetings.map((m) => `${m.days.join('')} ${m.start ?? 'TBA'}${m.end ? `–${m.end}` : ''}`).join(' · ') || 'TBA'}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  {section.instructor && <span className="text-muted">{section.instructor}</span>}
                  <EstadoCupo section={section} />
                  {chosen && <Check className="size-3.5 text-open" aria-label="Seleccionada" />}
                </span>
              </button>
            );
          })}
          {/* La práctica se elige acá, no la elige el portal. Aparece recién
              con la teórica elegida porque se acota a su campus: sin grupo no
              hay a qué acompañar. */}
          {teorica && practicas.length > 0 && (
            <>
              <div className="bg-surface-2/40 px-3 py-2">
                <p className="text-xs font-medium">
                  Práctica
                  {faltaPractica && <span className="text-closed font-normal"> · falta elegir una</span>}
                </p>
                <p className="text-muted mt-0.5 text-[11px]">
                  Del mismo campus que el grupo. El portal confirma cuál corresponde al agregarla.
                </p>
              </div>
              {practicas.map((section) => {
                const chosen = section.id === practiceId;
                return (
                  <button
                    key={section.id}
                    onClick={() => onSelectPractice(section.id)}
                    onMouseEnter={() => onHover(section.id)}
                    onFocus={() => onHover(section.id)}
                    onBlur={() => onHover(null)}
                    className={`flex w-full flex-wrap items-center justify-between gap-x-2 px-3 py-2 text-left text-xs transition-colors duration-100 ${
                      chosen ? 'bg-surface-2' : 'hover:bg-surface-2'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="tabular font-mono">{section.classNbr}</span>
                      <span className="text-muted tabular font-mono">
                        {section.meetings.map((m) => `${m.days.join('')} ${m.start ?? 'TBA'}${m.end ? `–${m.end}` : ''}`).join(' · ') || 'TBA'}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <EstadoCupo section={section} />
                      {chosen && <Check className="size-3.5 text-open" aria-label="Seleccionada" />}
                    </span>
                  </button>
                );
              })}
            </>
          )}
          {/* Traer más grupos vive PEGADO a la lista de grupos, no en una barra
              de acciones arriba: es la respuesta a "¿esto es todo lo que hay?",
              y esa pregunta se hace mirando la lista. */}
          <div className="px-3 py-2">
            <MoreSectionsButton course={course} term={termCode} known={course.sections.length} />
          </div>
        </div>
      )}
    </li>
  );
}

const SLIDERS: Array<{ key: keyof Weights; label: string }> = [
  { key: 'gaps', label: 'Menos huecos' },
  { key: 'earlyStarts', label: 'No madrugar' },
  { key: 'fewDays', label: 'Menos días' },
];

function SuggestionsPanel({
  combos,
  truncated,
  weights,
  onWeights,
  onApply,
}: {
  combos: Combination[];
  truncated: boolean;
  weights: Weights;
  onWeights: (w: Weights) => void;
  onApply: (c: Combination) => void;
}) {
  return (
    <div className="border-line bg-surface space-y-3 rounded-[var(--radius)] border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium">
          {combos.length === 0
            ? 'Ninguna combinación sin choques con estas candidatas'
            : `${combos.length} combinación(es) sin choques${truncated ? ' (recorte de seguridad: ranking parcial)' : ''}`}
        </h2>
        <div className="flex flex-wrap gap-4">
          {SLIDERS.map(({ key, label }) => (
            <label key={key} className="text-muted flex items-center gap-2 text-xs">
              {label}
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(weights[key] * 100)}
                onChange={(e) => onWeights({ ...weights, [key]: Number(e.target.value) / 100 })}
                className="w-24"
              />
            </label>
          ))}
        </div>
      </div>

      {combos.length > 0 && (
        <div className="flex snap-x gap-3 overflow-x-auto pb-1">
          {combos.slice(0, 8).map((combo, i) => (
            <button
              key={combo.sections.map((s) => s.id).join('-')}
              onClick={() => onApply(combo)}
              className="border-line hover:border-accent shrink-0 snap-start rounded-[var(--radius)] border p-2 text-left transition-colors duration-100"
            >
              <MiniGrid sections={combo.sections} />
              <div className="text-muted tabular mt-1.5 font-mono text-[10px]">
                #{i + 1} · {combo.metrics.daysUsed} día(s) · {combo.metrics.gapMinutes}min huecos
                {combo.metrics.earlyMinutes > 0 ? ` · madruga ${combo.metrics.earlyMinutes}min` : ' · sin madrugar'}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Vista miniatura de una combinación: 6 columnas (Lun–Sáb), bloques como
// franjas de color posicionadas en % del rango 7:00–22:00. Solo forma y color:
// para comparar de un vistazo, el detalle está al aplicarla.
const MINI_START = 7 * 60;
const MINI_SPAN = 15 * 60;

function MiniGrid({ sections }: { sections: CandidateSection[] }) {
  const days = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;
  return (
    <div className="border-line grid h-24 w-44 grid-cols-6 gap-px overflow-hidden rounded-sm border">
      {days.map((day) => (
        <div key={day} className="bg-bg relative">
          {sections.flatMap((section) =>
            section.meetings
              .filter((m) => m.start && m.end && m.days.includes(day))
              .map((m, i) => (
                <div
                  key={`${section.id}-${i}`}
                  className="absolute right-0 left-0 rounded-[1px]"
                  style={{
                    top: `${((toMinutes(m.start!) - MINI_START) / MINI_SPAN) * 100}%`,
                    height: `${((toMinutes(m.end!) - toMinutes(m.start!)) / MINI_SPAN) * 100}%`,
                    background: courseColor(section.code),
                  }}
                />
              ))
          )}
        </div>
      ))}
    </div>
  );
}
