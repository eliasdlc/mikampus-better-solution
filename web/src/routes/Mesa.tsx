import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Printer, ShoppingCart, X } from 'lucide-react';
import { clearMesaSelection, fetchMesa, sendPlanToCart, setMesaSelection } from '../lib/api.ts';
import { hasCollisions, sectionToBlocks, type Block } from '../lib/grid.ts';
import { meetingsOverlap } from '../../../src/shared/meetings.ts';
import type { MesaCandidate, MesaResponse, MesaSection } from '../../../src/shared/schemas.ts';
import { WeeklyGrid, type BloqueDetalle } from '../components/WeeklyGrid.tsx';
import { Capacidad, capabilityOf } from '../components/Capacidad.tsx';
import { HojaSecretaria } from '../components/HojaSecretaria.tsx';
import { Condiciones, type CondicionesValue, SIN_CONDICIONES } from '../components/Condiciones.tsx';

// La mesa de inscripción: una sola pantalla decide qué materias inscribir y
// termina en un papel.
//
// Arranca desde lo YA INSCRITO porque es lo que define los choques y la carga
// base; eso no es editable acá (dar de baja es otra operación, en Inscripción).
// Debajo van las materias que faltan y se ofertan, con las de tu campus
// primero. La unidad de elección es la teórica más su práctica: elegir media
// materia no es un estado válido, porque el portal no lo acepta.

function sectionBlocks(course: { code: string; title: string }, section: MesaSection, ghost = false): Block[] {
  return sectionToBlocks(course, section, { ghost });
}

// La práctica que se preselecciona al elegir una teórica: la primera del mismo
// campus que no choque con lo que ya hay en pantalla. Si todas chocan, la
// primera igual, para que la materia quede completa y el choque se VEA en vez
// de que la app se quede sin elegir y el estudiante no sepa por qué.
function suggestPractice(course: MesaCandidate, lecture: MesaSection, ocupado: Block[]): MesaSection | null {
  const practicas = course.sections.filter(
    (section) => section.component === 'PRA' && section.campus === lecture.campus
  );
  if (practicas.length === 0) return null;
  const libre = practicas.find(
    (practica) =>
      !practica.meetings.some((m) =>
        ocupado.some((block) =>
          meetingsOverlap(m, { days: [block.day], start: block.start, end: block.end, room: null })
        )
      )
  );
  return libre ?? practicas[0];
}

function FrescuraCupo({ mesa }: { mesa: MesaResponse }) {
  if (!mesa.seats.capturedAt) {
    return (
      <p className="border-line text-muted rounded-[var(--radius)] border px-3 py-2 text-xs">
        Nunca se observó el cupo de este ciclo. Las secciones se muestran sin estado.
      </p>
    );
  }
  if (mesa.seats.fresh) return null;
  const dias = Math.floor((mesa.seats.ageHours ?? 0) / 24);
  return (
    <p className="border-waitlist/40 bg-waitlist/10 text-waitlist rounded-[var(--radius)] border px-3 py-2 text-xs">
      El cupo que ves es del {mesa.seats.capturedAt.slice(0, 10)}, hace {dias} días. Ninguna sección se dibuja como
      abierta o cerrada con un dato tan viejo: dice “sin dato reciente”. Actualizá el catálogo para convertirlo en
      un estado.
    </p>
  );
}

function EstadoCupo({ section }: { section: MesaSection }) {
  if (!section.seats) return <span className="text-muted text-[11px]">sin dato</span>;
  // La regla que hace honesta la pantalla: sin observación reciente no se
  // afirma abierta ni cerrada, porque el portal solo publica un ícono y lo
  // único que sostiene el estado es que sea de hace poco.
  if (!section.seatsFresh) return <span className="text-muted text-[11px]">sin dato reciente</span>;
  const map = { open: ['text-open', 'abierta'], waitlist: ['text-waitlist', 'lista de espera'], closed: ['text-closed', 'cerrada'] } as const;
  const [color, label] = map[section.seats.status] ?? ['text-muted', section.seats.status];
  return <span className={`${color} text-[11px] font-medium`}>{label}</span>;
}

function FilaSeccion({
  section,
  elegida,
  onPick,
  onHover,
}: {
  section: MesaSection;
  elegida: boolean;
  onPick: () => void;
  onHover: (section: MesaSection | null) => void;
}) {
  const horario = section.meetings
    .filter((m) => m.start && m.end)
    .map((m) => `${m.days.join('')} ${m.start}-${m.end}`)
    .join(' · ');
  return (
    <button
      type="button"
      onClick={onPick}
      onMouseEnter={() => onHover(section)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(section)}
      onBlur={() => onHover(null)}
      aria-pressed={elegida}
      className={`focus-visible:outline-accent flex w-full items-center gap-2 rounded-[var(--radius)] border px-2.5 py-1.5 text-left text-xs focus-visible:outline-2 ${
        elegida ? 'border-accent bg-accent/10' : 'border-line hover:bg-surface-2'
      }`}
    >
      <span className="tabular min-w-10 shrink-0 font-mono font-medium">
        {section.section ?? <span className="text-muted font-sans text-[11px]">sin sección</span>}
      </span>
      <span className="tabular text-muted w-12 shrink-0 font-mono">{section.classNbr}</span>
      <span className="tabular min-w-0 flex-1 font-mono">{horario || 'sin horario publicado'}</span>
      <span className="text-muted hidden min-w-0 flex-1 truncate sm:block">{section.instructor ?? 'sin asignar'}</span>
      <EstadoCupo section={section} />
    </button>
  );
}

function Candidata({
  course,
  mesa,
  onHover,
  onPickLecture,
  onPickPractice,
  onClear,
}: {
  course: MesaCandidate;
  mesa: MesaResponse;
  onHover: (section: MesaSection | null) => void;
  onPickLecture: (course: MesaCandidate, section: MesaSection) => void;
  onPickPractice: (course: MesaCandidate, section: MesaSection) => void;
  onClear: (course: MesaCandidate) => void;
}) {
  const item = mesa.plan?.items.find((entry) => entry.courseId === course.courseId);
  const teorica = item?.section ?? null;
  const practica = item?.relatedSection ?? null;
  const tienePracticas = course.sections.some((section) => section.component === 'PRA');
  const incompleta = teorica != null && tienePracticas && practica == null;

  return (
    <article className="border-line bg-surface rounded-[var(--radius)] border">
      <header className="border-line flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b px-3 py-2">
        <h3 className="font-medium">
          {course.code} <span className="text-muted font-normal">{course.title}</span>
        </h3>
        <span className="text-muted text-xs">
          {course.credits} cr · {course.kind} · {course.periodLabel}
        </span>
        {teorica && (
          <button
            type="button"
            onClick={() => onClear(course)}
            className="text-muted hover:text-fg ml-auto flex items-center gap-1 text-xs"
          >
            <X className="size-3" aria-hidden />
            Quitar
          </button>
        )}
      </header>

      <div className="flex flex-col gap-3 px-3 py-2.5">
        {course.campusGroups.map((group) => {
          const teoricas = group.sections.filter((section) => section.component !== 'PRA');
          if (teoricas.length === 0) return null;
          return (
            <section key={group.label}>
              {/* Un grupo único no lleva encabezado: sería ruido. Con dos, el
                  del campus propio va primero y el otro queda claramente
                  marcado como la opción secundaria que es. */}
              {course.campusGroups.length > 1 && (
                <h4
                  className={`mb-1.5 text-xs font-medium ${group.isHome ? 'text-fg' : 'text-muted'}`}
                >
                  {group.label}
                  {!group.isHome && <span className="font-normal"> · otra ciudad</span>}
                </h4>
              )}
              <div className={`flex flex-col gap-1 ${group.isHome ? '' : 'opacity-80'}`}>
                {teoricas.map((section) => (
                  <FilaSeccion
                    key={section.id}
                    section={section}
                    elegida={teorica?.id === section.id}
                    onPick={() => onPickLecture(course, section)}
                    onHover={onHover}
                  />
                ))}
              </div>
            </section>
          );
        })}

        {teorica && tienePracticas && (
          <section className="border-line border-t pt-2.5">
            <h4 className="mb-1.5 text-xs font-medium">
              Práctica
              {incompleta && <span className="text-closed font-normal"> · falta elegir una</span>}
            </h4>
            {/* Qué práctica es válida para qué teórica solo lo dice el portal en
                su paso Select. Se declara en vez de fingir que lo sabemos. */}
            <p className="text-muted mb-1.5 text-[11px]">
              Se muestran las prácticas del mismo campus. El portal confirma cuál corresponde al agregar la materia.
            </p>
            <div className="flex flex-col gap-1">
              {course.sections
                .filter((section) => section.component === 'PRA' && section.campus === teorica.campus)
                .map((section) => (
                  <FilaSeccion
                    key={section.id}
                    section={section}
                    elegida={practica?.id === section.id}
                    onPick={() => onPickPractice(course, section)}
                    onHover={onHover}
                  />
                ))}
            </div>
          </section>
        )}
      </div>
    </article>
  );
}

export function Mesa() {
  const queryClient = useQueryClient();
  const [ghost, setGhost] = useState<{ course: MesaCandidate; section: MesaSection } | null>(null);
  const [hoja, setHoja] = useState(false);
  const [detalle, setDetalle] = useState<BloqueDetalle | null>(null);
  const [condiciones, setCondiciones] = useState<CondicionesValue>(SIN_CONDICIONES);

  const mesa = useQuery({ queryKey: ['mesa'], queryFn: () => fetchMesa() });

  const guardar = useMutation({
    mutationFn: setMesaSelection,
    onSuccess: (data) => queryClient.setQueryData(['mesa'], data),
  });
  const quitar = useMutation({
    mutationFn: clearMesaSelection,
    onSuccess: (data) => queryClient.setQueryData(['mesa'], data),
  });
  const alCarrito = useMutation({
    mutationFn: (planId: number) => sendPlanToCart(planId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['mesa'] }),
  });

  const data = mesa.data;

  // Los bloques del horario: lo inscrito (fijo) más lo elegido, y encima el
  // fantasma de lo que el mouse está señalando.
  const blocks = useMemo(() => {
    if (!data) return [];
    const out: Block[] = [];
    for (const course of data.enrolled) {
      for (const section of course.sections) {
        out.push(
          ...sectionBlocks(course, {
            ...section,
            term: data.term,
            seats: null,
            seatsUpdatedAt: null,
            seatsAgeHours: null,
            seatsFresh: false,
            campus: null,
            campusSource: null,
          })
        );
      }
    }
    for (const item of data.plan?.items ?? []) {
      if (item.section) out.push(...sectionBlocks(item, item.section as MesaSection));
      if (item.relatedSection) out.push(...sectionBlocks(item, item.relatedSection as MesaSection));
    }
    return out;
  }, [data]);

  const conFantasma = useMemo(() => {
    if (!ghost) return blocks;
    const yaEsta = blocks.some((block) => block.classNbr === ghost.section.classNbr);
    return yaEsta ? blocks : [...blocks, ...sectionBlocks(ghost.course, ghost.section, true)];
  }, [blocks, ghost]);

  if (mesa.isLoading) {
    return <p className="text-muted text-sm">Armando la mesa…</p>;
  }
  if (mesa.isError || !data) {
    return <p className="text-closed text-sm">{(mesa.error as Error)?.message ?? 'No se pudo armar la mesa'}</p>;
  }

  const choque = hasCollisions(blocks);
  const elegidas = new Set(
    (data.plan?.items ?? []).flatMap((item) =>
      [item.section?.classNbr, item.relatedSection?.classNbr].filter((n): n is string => !!n)
    )
  );
  const puedeCarrito = capabilityOf(data.phase, 'mandar-al-carrito');
  const porPeriodo = new Map<string, MesaCandidate[]>();
  for (const course of data.candidates) {
    porPeriodo.set(course.periodLabel, [...(porPeriodo.get(course.periodLabel) ?? []), course]);
  }

  const pickLecture = (course: MesaCandidate, section: MesaSection) => {
    const sugerida = suggestPractice(course, section, blocks);
    guardar.mutate({
      term: data.term,
      courseId: course.courseId,
      sectionId: section.id,
      relatedSectionId: sugerida?.id ?? null,
    });
  };

  const pickPractice = (course: MesaCandidate, section: MesaSection) => {
    const item = data.plan?.items.find((entry) => entry.courseId === course.courseId);
    if (!item?.section) return;
    guardar.mutate({
      term: data.term,
      courseId: course.courseId,
      sectionId: item.section.id,
      relatedSectionId: section.id,
    });
  };

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="font-display text-xl font-semibold">Mesa de inscripción</h1>
        <span className="text-muted text-sm">
          {data.phase.termLabel ?? data.term}
          {data.phase.until && ` · cierra el ${data.phase.until}`}
        </span>
        <span className="tabular ml-auto text-sm">
          <strong>{data.totals.credits}</strong> créditos
          <span className="text-muted">
            {' '}
            ({data.totals.enrolledCredits} inscritos + {data.totals.selectedCredits} elegidos)
          </span>
        </span>
      </header>

      <FrescuraCupo mesa={data} />

      {choque && (
        <p className="border-closed/40 bg-closed/10 text-closed rounded-[var(--radius)] border px-3 py-2 text-sm">
          Hay un choque de horario en tu selección. Está rayado en la semana.
        </p>
      )}

      {/* Lo elegido se marca con anillo y punto, no volviéndose acento: acá el
          color ES la materia, y si al elegir se vuelve azul se pierde la única
          pista de qué bloque pertenece a cuál justo mientras se comparan. */}
      <WeeklyGrid blocks={conFantasma} animate selectedIds={elegidas} onSelect={setDetalle} />

      {/* El detalle de un bloque. El profesor y el aula vivían solo en el
          atributo title, que en teléfono no existe y con teclado tampoco. */}
      {detalle && (
        <div className="border-line bg-surface-2 rounded-[var(--radius)] border px-3 py-2.5 text-sm">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {detalle.code} <span className="text-muted font-normal">{detalle.title}</span>
              </p>
              <dl className="text-muted mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                <dt>Cuándo</dt>
                <dd className="tabular text-fg font-mono">
                  {detalle.start}–{detalle.end}
                </dd>
                <dt>Grupo</dt>
                <dd className="text-fg">
                  {detalle.section ?? `NRC ${detalle.classNbr}`} {detalle.component ?? ''}
                </dd>
                <dt>Profesor</dt>
                <dd className="text-fg">{detalle.instructor ?? 'no asignado'}</dd>
                <dt>Aula</dt>
                {/* Ausente explícito: el portal la publica en 34 de 1427
                    secciones del ciclo, así que decirlo vale más que un vacío. */}
                <dd className="text-fg">{detalle.room ?? 'no publicada'}</dd>
              </dl>
              {detalle.conflictsWith.length > 0 && (
                <p className="text-closed mt-2 text-xs">Choca con {detalle.conflictsWith.join(', ')}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => setDetalle(null)}
              className="text-muted hover:text-fg shrink-0 rounded px-2 py-1 text-xs"
            >
              Cerrar
            </button>
          </div>
        </div>
      )}

      <Condiciones
        term={data.term}
        value={condiciones}
        onChange={setCondiciones}
        onApply={(combo) => {
          // Aplicar una propuesta es elegir sus teóricas una por una: cada
          // elección arrastra su práctica sugerida, igual que a mano.
          for (const section of combo) {
            const course = data.candidates.find((entry) => entry.courseId === section.courseId);
            const full = course?.sections.find((entry) => entry.id === section.id);
            if (course && full) pickLecture(course, full);
          }
        }}
      />

      {data.enrolled.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium">Ya inscrito</h2>
          <ul className="flex flex-col gap-1.5">
            {data.enrolled.map((course) => (
              <li
                key={course.id}
                className="border-line bg-surface-2 flex flex-wrap items-baseline gap-x-2 rounded-[var(--radius)] border px-3 py-2 text-sm"
              >
                <span className="font-medium">{course.code}</span>
                <span className="text-muted">{course.title}</span>
                <span className="tabular text-muted ml-auto font-mono text-xs">
                  {/* View My Classes no publica el número de grupo, así que en
                      lo ya inscrito suele faltar. Un "?" se lee como un dato
                      roto; el NRC sí existe siempre y es lo que la oficina
                      teclea, así que es lo que se muestra cuando no hay grupo. */}
                  {course.sections
                    .map((section) =>
                      [section.section ?? `NRC ${section.classNbr}`, section.component].filter(Boolean).join(' ')
                    )
                    .join(' · ')}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-muted mt-1.5 text-xs">
            No se edita desde acá: dar de baja una materia es otra operación, en Inscripción.
          </p>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-medium">
          Te falta y se oferta este ciclo <span className="text-muted font-normal">({data.candidates.length})</span>
        </h2>
        {data.candidates.length === 0 ? (
          <p className="text-muted text-sm">
            No hay materias pendientes de tu pénsum con oferta en este ciclo. Si esperabas alguna, sincronizá el
            pénsum y el catálogo.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {[...porPeriodo.entries()].map(([periodo, cursos]) => (
              <div key={periodo} className="flex flex-col gap-2">
                <h3 className="text-muted text-xs font-medium">{periodo}</h3>
                {cursos.map((course) => (
                  <Candidata
                    key={course.courseId}
                    course={course}
                    mesa={data}
                    onHover={(section) => setGhost(section ? { course, section } : null)}
                    onPickLecture={pickLecture}
                    onPickPractice={pickPractice}
                    onClear={(entry) => quitar.mutate({ term: data.term, courseId: entry.courseId })}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </section>

      <footer className="border-line flex flex-wrap items-start gap-3 border-t pt-4">
        {/* La acción de mañana es la única con acento: llevar el papel. */}
        <button
          type="button"
          onClick={() => setHoja(true)}
          disabled={data.totals.selectedCourses === 0 && data.enrolled.length === 0}
          className="bg-accent text-accent-fg flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          <Printer className="size-4" aria-hidden />
          Hoja para la secretaría
        </button>

        <Capacidad state={puedeCarrito}>
          {(blocked) => (
            <button
              type="button"
              onClick={() => data.plan && alCarrito.mutate(data.plan.id)}
              disabled={blocked || !data.plan || data.totals.selectedCourses === 0 || alCarrito.isPending}
              className="border-line hover:bg-surface-2 flex items-center gap-2 rounded-full border px-4 py-2 text-sm disabled:opacity-50"
            >
              <ShoppingCart className="size-4" aria-hidden />
              {alCarrito.isPending ? 'Enviando al carrito…' : 'Enviar al carrito del portal'}
            </button>
          )}
        </Capacidad>
      </footer>

      {(guardar.isError || quitar.isError || alCarrito.isError) && (
        <p className="text-closed text-sm">
          {((guardar.error ?? quitar.error ?? alCarrito.error) as Error)?.message}
        </p>
      )}

      {hoja && (
        <div className="border-line bg-surface rounded-[var(--radius)] border p-4">
          <div className="mb-3 flex items-center gap-2 print:hidden">
            <button
              type="button"
              onClick={() => window.print()}
              className="border-line hover:bg-surface-2 rounded-full border px-3 py-1.5 text-sm"
            >
              Imprimir
            </button>
            <button
              type="button"
              onClick={() => setHoja(false)}
              className="border-line rounded-full border px-3 py-1.5 text-sm"
            >
              Cerrar
            </button>
          </div>
          <HojaSecretaria mesa={data} />
        </div>
      )}
    </div>
  );
}
