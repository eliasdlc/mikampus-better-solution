import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import {
  fetchCatalog,
  addToCart,
  fetchPlans,
  addPlanItem,
  fetchMySchedule,
  fetchTermContext,
  fetchPensumCodes,
} from '../lib/api.ts';
import { buildIndex } from '../lib/search.ts';
import { normalizeSeatStatus, type CatalogCourse, type CatalogSection } from '../../../src/shared/schemas.ts';
import { portalCatalogNbr } from '../../../src/shared/courseCode.ts';
import { meetingSetsOverlap } from '../../../src/shared/meetings.ts';
import { CourseChip } from '../components/CourseChip.tsx';
import { SeatBadge } from '../components/SeatBadge.tsx';
import { StalenessTag } from '../components/StalenessTag.tsx';

export function Buscar() {
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: () => fetchCatalog() });
  // Buscar planifica el ciclo que viene, así que el choque se mide contra el
  // horario de ESE término (plan §11: "cruza contra el horario del término
  // correspondiente"), no contra el que corre hoy. Se lee de cache local: el
  // filtro es instantáneo — y es justo lo que micampus no puede hacer.
  const termsQ = useQuery({ queryKey: ['term-context'], queryFn: fetchTermContext });
  const planningCode = termsQ.data?.next?.code ?? null;
  const schedule = useQuery({
    queryKey: ['my-schedule', planningCode],
    queryFn: () => fetchMySchedule(planningCode!),
    enabled: planningCode != null,
  });
  // Carrera-first (§11): el índice arranca acotado a tu pénsum (requisitos +
  // inscritas). El chip "Todo el catálogo" — apagado por defecto — abre el resto.
  const pensumCodesQ = useQuery({ queryKey: ['pensum-codes'], queryFn: fetchPensumCodes });
  const pensumCodes = useMemo(() => new Set(pensumCodesQ.data ?? []), [pensumCodesQ.data]);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [sinChoque, setSinChoque] = useState(false);
  const [todoCatalogo, setTodoCatalogo] = useState(false);

  const courses = catalog.data?.courses ?? [];
  const byId = useMemo(() => new Map(courses.map((c) => [c.id, c])), [courses]);
  const index = useMemo(() => buildIndex(courses), [courses]);
  // Solo hay a qué acotar si el pénsum ya se sincronizó; sin eso, el catálogo
  // entero (no dejar la búsqueda vacía porque falte el pénsum).
  const hayPensum = pensumCodes.size > 0;
  const acotado = hayPensum && !todoCatalogo;

  // Solo lo inscrito ocupa tiempo: una materia dada de baja no choca con nada.
  const ocupado = useMemo(
    () =>
      (schedule.data?.courses ?? [])
        .filter((c) => c.status === 'enrolled')
        .flatMap((c) => c.sections.flatMap((s) => s.meetings)),
    [schedule.data]
  );
  const terminoInscrito = schedule.data?.term ?? null;

  // Una sección solo puede chocar con un horario del MISMO término: decir que
  // una clase de Septiembre pisa una de Abril no significa nada. Sin horario
  // de ese término, la app no opina.
  const choca = useMemo(
    () => (section: CatalogSection) =>
      !!terminoInscrito && section.term === terminoInscrito && meetingSetsOverlap(section.meetings, ocupado),
    [terminoInscrito, ocupado]
  );

  const results: CatalogCourse[] = useMemo(() => {
    const base = !q.trim()
      ? courses
      : (index
          .search(q)
          .map((r) => byId.get(r.id as number))
          .filter((c): c is CatalogCourse => !!c) as CatalogCourse[]);
    // Carrera-first primero, y todo el filtrado ANTES de cortar a 50: si no,
    // una materia tuya se perdería solo por caer 51ª entre las del catálogo.
    const propias = acotado ? base.filter((c) => pensumCodes.has(c.code)) : base;
    const filtrado = sinChoque ? propias.filter((c) => c.sections.some((s) => !choca(s))) : propias;
    return filtrado.slice(0, 50);
  }, [q, index, byId, courses, sinChoque, choca, acotado, pensumCodes]);

  const puedeFiltrar = ocupado.length > 0;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Buscar materias</h1>
        <p className="text-muted mt-1 text-sm">Nombre, código o profesor. Insensible a acentos, resultados al instante.</p>
      </header>

      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Estructuras de datos, ICC-303, Pérez…"
        className="border-line bg-surface focus:border-accent w-full rounded-[var(--radius)] border px-4 py-3 text-base outline-none"
      />

      {/* Filtros como chips togglables, no formulario (plan §5.2). */}
      {(puedeFiltrar || hayPensum) && (
        <div className="flex flex-wrap items-center gap-2">
          {hayPensum && (
            <button
              type="button"
              onClick={() => setTodoCatalogo((v) => !v)}
              aria-pressed={todoCatalogo}
              className={`min-h-8 rounded-full px-3 py-1 text-xs transition-colors duration-100 ${
                todoCatalogo ? 'bg-accent text-accent-fg font-medium' : 'border-line text-muted hover:text-fg border'
              }`}
            >
              Todo el catálogo
            </button>
          )}
          {puedeFiltrar && (
            <button
              type="button"
              onClick={() => setSinChoque((v) => !v)}
              aria-pressed={sinChoque}
              className={`min-h-8 rounded-full px-3 py-1 text-xs transition-colors duration-100 ${
                sinChoque ? 'bg-accent text-accent-fg font-medium' : 'border-line text-muted hover:text-fg border'
              }`}
            >
              Sin choque con mi horario
            </button>
          )}
          {acotado && <span className="text-muted text-xs">mostrando solo tu pénsum</span>}
          {sinChoque && (
            <span className="text-muted text-xs">
              se ocultan las secciones que pisan tus {ocupado.length} bloque(s) inscritos
            </span>
          )}
        </div>
      )}

      {catalog.isLoading ? (
        <p className="text-muted text-sm">Cargando catálogo…</p>
      ) : catalog.error ? (
        <p className="text-closed text-sm">{(catalog.error as Error).message}</p>
      ) : courses.length === 0 ? (
        <p className="text-muted text-sm">
          El catálogo está vacío. Traelo del portal con{' '}
          <code className="font-mono">node scripts/sync-catalog.mjs ICC</code> (unos minutos por materia).
        </p>
      ) : (
        <>
          <p className="text-muted text-xs">{results.length} materia(s)</p>
          <ul className="space-y-2">
            {results.map((course) => (
              <CourseRow
                key={course.id}
                course={course}
                open={expanded === course.id}
                onToggle={() => setExpanded(expanded === course.id ? null : course.id)}
                ocultarSeccion={sinChoque ? choca : undefined}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function CourseRow({
  course,
  open,
  onToggle,
  ocultarSeccion,
}: {
  course: CatalogCourse;
  open: boolean;
  onToggle: () => void;
  // Con el filtro "sin choque" activo, las secciones que pisan el horario no se
  // listan: la cuenta de secciones tiene que decir cuántas quedan, no cuántas
  // hay, o el desplegable contradice al encabezado.
  ocultarSeccion?: (s: CatalogSection) => boolean;
}) {
  const visibles = ocultarSeccion ? course.sections.filter((s) => !ocultarSeccion(s)) : course.sections;
  const ocultas = course.sections.length - visibles.length;
  return (
    <li className="border-line bg-surface rounded-[var(--radius)] border">
      <button onClick={onToggle} className="hover:bg-surface-2 flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors duration-100">
        <CourseChip code={course.code} title={course.title} />
        <span className="text-muted flex items-center gap-3 text-xs whitespace-nowrap">
          {course.credits != null && <span className="tabular">{course.credits} cr</span>}
          <span>{visibles.length} secc.</span>
          {ocultas > 0 && <span className="text-waitlist">{ocultas} chocan</span>}
          {open ? <ChevronUp className="size-4" aria-hidden /> : <ChevronDown className="size-4" aria-hidden />}
        </span>
      </button>
      {open && (
        <div className="border-line divide-line divide-y border-t">
          {visibles.map((s) => (
            <SectionRow key={s.id} section={s} course={course} />
          ))}
        </div>
      )}
    </li>
  );
}

function SectionRow({ section, course }: { section: CatalogSection; course: CatalogCourse }) {
  const qc = useQueryClient();
  const add = useMutation({
    mutationFn: () =>
      addToCart({
        term: section.term,
        career: course.career ?? 'GRDO',
        courseNumber: portalCatalogNbr(course),
        classNbr: section.classNbr,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cart'] }),
  });
  const meeting = section.meetings[0];

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-sm">
      <div className="min-w-0">
        <span className="tabular font-mono text-xs">{section.classNbr}</span>
        <span className="text-muted ml-2">{section.instructor || 'Sin profesor'}</span>
        {meeting && (
          <span className="text-muted tabular ml-2 font-mono text-xs">
            {meeting.days.join(' ')} {meeting.start && `${meeting.start}–${meeting.end}`} {meeting.room && `· ${meeting.room}`}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        {section.seats && (
          <div className="flex flex-col items-end gap-0.5">
            <SeatBadge status={normalizeSeatStatus(section.seats.status)} open={section.seats.open} capacity={section.seats.capacity} />
            <StalenessTag at={section.seatsUpdatedAt} />
          </div>
        )}
        <AddToPlanButton course={course} section={section} />
        <button
          onClick={() => add.mutate()}
          disabled={add.isPending || add.isSuccess}
          className="border-line hover:bg-surface-2 rounded-[var(--radius)] border px-2.5 py-1 text-xs disabled:opacity-50"
        >
          {add.isSuccess && <Check className="size-3.5" aria-hidden />}
          {add.isSuccess ? 'En el carrito' : add.isPending ? 'Agregando…' : add.isError ? 'Reintentar' : 'Agregar al carrito'}
        </button>
      </div>
      {add.isError && <p className="text-closed w-full text-xs">{(add.error as Error).message}</p>}
    </div>
  );
}

// "Agregar a un plan" (plan §5.2): desplegable con los planes existentes; la
// materia entra con esta sección ya elegida. Los planes se piden una sola vez
// (cache de TanStack) y solo al abrir el menú.
function AddToPlanButton({ course, section }: { course: CatalogCourse; section: CatalogSection }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const plansQ = useQuery({ queryKey: ['plans'], queryFn: fetchPlans, enabled: open });
  const add = useMutation({
    mutationFn: (planId: number) => addPlanItem(planId, { courseId: course.id, sectionId: section.id }),
    onSuccess: (_, planId) => {
      qc.invalidateQueries({ queryKey: ['plans'] });
      qc.invalidateQueries({ queryKey: ['plan', planId] });
      setOpen(false);
    },
  });

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="border-line hover:bg-surface-2 rounded-[var(--radius)] border px-2.5 py-1 text-xs"
      >
        {add.isSuccess ? <><Check className="size-3.5" aria-hidden />En el plan</> : <>Al plan<ChevronDown className="size-3.5" aria-hidden /></>}
      </button>
      {open && (
        <div className="border-line bg-surface absolute right-0 z-30 mt-1 w-52 rounded-[var(--radius)] border">
          {plansQ.isLoading ? (
            <p className="text-muted px-3 py-2 text-xs">Cargando…</p>
          ) : (plansQ.data ?? []).length === 0 ? (
            <p className="text-muted px-3 py-2 text-xs">No hay planes: creá uno en Planner.</p>
          ) : (
            plansQ.data!.map((p) => (
              <button
                key={p.id}
                onClick={() => add.mutate(p.id)}
                disabled={add.isPending}
                className="hover:bg-surface-2 block w-full px-3 py-2 text-left text-xs disabled:opacity-50"
              >
                {p.name}
              </button>
            ))
          )}
          {add.error && <p className="text-closed px-3 py-2 text-xs">{(add.error as Error).message}</p>}
        </div>
      )}
    </div>
  );
}
