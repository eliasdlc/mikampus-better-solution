import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { fetchCatalog, fetchPlans, addToCart, addPlanItem } from '../lib/api.ts';
import { buildIndex } from '../lib/search.ts';
import { portalCatalogNbr } from '../../../src/shared/courseCode.ts';
import { normalizeSeatStatus, type CatalogCourse, type CatalogSection } from '../../../src/shared/schemas.ts';
import { SeatBadge } from './SeatBadge.tsx';
import { courseColor } from '../lib/color.ts';

// ⌘K global (plan §5.2): la misma búsqueda de /buscar, en overlay, desde
// cualquier pantalla y con las mismas acciones. Tres niveles, siempre con el
// teclado: materias → secciones de una materia → qué hacer con esa sección.
// Esc y ← vuelven un nivel; nunca te deja encerrado.

type Page = { kind: 'root' } | { kind: 'course'; course: CatalogCourse } | { kind: 'section'; course: CatalogCourse; section: CatalogSection };

const NAV = [
  { to: '/', label: 'Inicio' },
  { to: '/buscar', label: 'Buscar materias' },
  { to: '/planner', label: 'Planner de ciclos' },
  { to: '/builder', label: 'Constructor de horario' },
  { to: '/horario', label: 'Mi horario' },
  { to: '/inscripcion', label: 'Carrito e inscripción' },
  { to: '/academico', label: 'Notas y avance' },
  { to: '/holds', label: 'Holds y pendientes' },
];

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [page, setPage] = useState<Page>({ kind: 'root' });

  // El catálogo solo se pide (y el índice solo se construye) cuando el overlay
  // se abre por primera vez: montar el palette en toda la app no puede costarle
  // un índice MiniSearch a quien nunca lo use. Después es cache de TanStack,
  // compartido con /buscar.
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: () => fetchCatalog(), enabled: open });
  const courses = catalog.data?.courses ?? [];
  const byId = useMemo(() => new Map(courses.map((c) => [c.id, c])), [courses]);
  const index = useMemo(() => buildIndex(courses), [courses]);

  // Cada apertura empieza limpia: el palette es para actuar rápido, no para
  // retomar lo que buscabas hace dos días.
  useEffect(() => {
    if (!open) {
      setQ('');
      setPage({ kind: 'root' });
    }
  }, [open]);

  const resultados = useMemo(() => {
    if (!q.trim()) return [];
    return index
      .search(q)
      .map((r) => byId.get(r.id as number))
      .filter((c): c is CatalogCourse => !!c)
      .slice(0, 8);
  }, [q, index, byId]);

  const irA = (to: string) => {
    onOpenChange(false);
    navigate(to);
  };

  const volver = () => setPage((p) => (p.kind === 'section' ? { kind: 'course', course: p.course } : { kind: 'root' }));

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Buscar y ejecutar acciones"
      shouldFilter={false}
      overlayClassName="fixed inset-0 z-40 bg-black/40"
      contentClassName="border-line bg-surface fixed top-[12vh] left-1/2 z-50 w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-[var(--radius)] border shadow-2xl"
      onKeyDown={(e) => {
        // ← vuelve un nivel, pero solo con el input vacío: si estás escribiendo,
        // la flecha izquierda mueve el cursor, que es lo que un input hace.
        if (page.kind !== 'root' && (e.key === 'ArrowLeft' || e.key === 'Backspace') && !q) {
          e.preventDefault();
          volver();
        }
      }}
    >
      {page.kind !== 'root' && (
        <div className="border-line text-muted flex items-center gap-2 border-b px-3 py-2 text-xs">
          <button type="button" onClick={volver} className="hover:text-fg underline underline-offset-2">
            ← volver
          </button>
          <span className="tabular font-mono">
            {page.course.code}
            {page.kind === 'section' ? ` · ${page.section.classNbr}` : ''}
          </span>
        </div>
      )}

      <Command.Input
        value={q}
        onValueChange={setQ}
        autoFocus
        placeholder={
          page.kind === 'root' ? 'Buscar materias, ir a una pantalla…' : page.kind === 'course' ? 'Filtrar secciones…' : 'Elegí una acción…'
        }
        className="border-line placeholder:text-muted w-full border-b bg-transparent px-4 py-3.5 text-base outline-none"
      />

      <Command.List className="max-h-[min(400px,50vh)] overflow-y-auto p-1.5">
        {page.kind === 'root' && (
          <RootPage
            q={q}
            cargando={catalog.isLoading}
            resultados={resultados}
            onCourse={(course) => {
              setPage({ kind: 'course', course });
              setQ('');
            }}
            onNav={irA}
          />
        )}

        {page.kind === 'course' && (
          <CoursePage
            course={page.course}
            q={q}
            onSection={(section) => {
              setPage({ kind: 'section', course: page.course, section });
              setQ('');
            }}
          />
        )}

        {page.kind === 'section' && (
          <SectionActions course={page.course} section={page.section} onDone={() => onOpenChange(false)} onNav={irA} />
        )}
      </Command.List>
    </Command.Dialog>
  );
}

function RootPage({
  q,
  cargando,
  resultados,
  onCourse,
  onNav,
}: {
  q: string;
  cargando: boolean;
  resultados: CatalogCourse[];
  onCourse: (c: CatalogCourse) => void;
  onNav: (to: string) => void;
}) {
  const nav = q.trim() ? NAV.filter((n) => n.label.toLowerCase().includes(q.trim().toLowerCase())) : NAV;

  return (
    <>
      {q.trim() && (
        <Command.Group heading="Materias" className="text-muted px-2 py-1 text-xs">
          {cargando && <Command.Loading className="text-muted px-2 py-2 text-sm">Cargando catálogo…</Command.Loading>}
          {!cargando && resultados.length === 0 && (
            <div className="text-muted px-2 py-2 text-sm">Ninguna materia coincide con "{q}".</div>
          )}
          {resultados.map((course) => (
            <Row key={course.id} value={`course-${course.id}`} onSelect={() => onCourse(course)}>
              <span className="h-5 w-1 shrink-0 rounded-full" style={{ background: courseColor(course.code) }} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{course.title}</span>
              <span className="text-muted tabular font-mono text-xs">
                {course.code} · {course.sections.length} secc.
              </span>
            </Row>
          ))}
        </Command.Group>
      )}

      {nav.length > 0 && (
        <Command.Group heading="Ir a" className="text-muted px-2 py-1 text-xs">
          {nav.map((item) => (
            <Row key={item.to} value={`nav-${item.to}`} onSelect={() => onNav(item.to)}>
              <span className="flex-1">{item.label}</span>
            </Row>
          ))}
        </Command.Group>
      )}
    </>
  );
}

function CoursePage({ course, q, onSection }: { course: CatalogCourse; q: string; onSection: (s: CatalogSection) => void }) {
  const filtro = q.trim().toLowerCase();
  const secciones = filtro
    ? course.sections.filter(
        (s) => s.classNbr.includes(filtro) || (s.instructor ?? '').toLowerCase().includes(filtro)
      )
    : course.sections;

  return (
    <Command.Group heading={course.title} className="text-muted px-2 py-1 text-xs">
      {secciones.length === 0 && <div className="text-muted px-2 py-2 text-sm">Esta materia no tiene secciones este término.</div>}
      {secciones.map((section) => {
        const m = section.meetings[0];
        return (
          <Row key={section.id} value={`section-${section.id}`} onSelect={() => onSection(section)}>
            <span className="tabular font-mono text-xs">{section.classNbr}</span>
            <span className="min-w-0 flex-1 truncate">{section.instructor || 'Sin profesor'}</span>
            {m?.start && (
              <span className="text-muted tabular font-mono text-xs">
                {m.days.join('')} {m.start}–{m.end}
              </span>
            )}
            {section.seats && <SeatBadge status={normalizeSeatStatus(section.seats.status)} />}
          </Row>
        );
      })}
    </Command.Group>
  );
}

// Las acciones del plan §5.2 sobre una sección concreta. "Vigilar cupo" no está:
// el watcher vigila el carrito entero, no secciones sueltas — ofrecerlo acá
// sería prometer algo que el backend no hace.
function SectionActions({
  course,
  section,
  onDone,
  onNav,
}: {
  course: CatalogCourse;
  section: CatalogSection;
  onDone: () => void;
  onNav: (to: string) => void;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const planes = useQuery({ queryKey: ['plans'], queryFn: fetchPlans });

  const alCarrito = useMutation({
    mutationFn: () =>
      addToCart({
        term: section.term,
        career: course.career ?? 'GRDO',
        courseNumber: portalCatalogNbr(course),
        classNbr: section.classNbr,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cart'] });
      onDone();
    },
    onError: (err: Error) => setError(err.message),
  });

  const alPlan = useMutation({
    mutationFn: (planId: number) => addPlanItem(planId, { courseId: course.id, sectionId: section.id }),
    onSuccess: (_, planId) => {
      qc.invalidateQueries({ queryKey: ['plans'] });
      qc.invalidateQueries({ queryKey: ['plan', planId] });
      onDone();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <>
      {error && <div className="text-closed px-3 py-2 text-xs">{error}</div>}

      <Command.Group heading="Acciones" className="text-muted px-2 py-1 text-xs">
        <Row value="add-cart" onSelect={() => alCarrito.mutate()}>
          <span className="flex-1">{alCarrito.isPending ? 'Agregando al carrito en PeopleSoft…' : 'Agregar al carrito'}</span>
          <span className="text-muted text-xs">operación en vivo · tarda</span>
        </Row>
        <Row value="see-search" onSelect={() => onNav('/buscar')}>
          <span className="flex-1">Ver en Buscar</span>
        </Row>
      </Command.Group>

      <Command.Group heading="Agregar a un plan" className="text-muted px-2 py-1 text-xs">
        {(planes.data ?? []).length === 0 ? (
          <Row value="new-plan" onSelect={() => onNav('/planner')}>
            <span className="flex-1">No hay planes todavía: crear uno en el planner</span>
          </Row>
        ) : (
          planes.data!.map((p) => (
            <Row key={p.id} value={`plan-${p.id}`} onSelect={() => alPlan.mutate(p.id)}>
              <span className="flex-1">{p.name}</span>
              <span className="text-muted tabular text-xs">{p.itemCount} materia(s)</span>
            </Row>
          ))
        )}
      </Command.Group>
    </>
  );
}

// data-[selected=true]: cmdk marca así el item bajo el cursor del teclado. Es
// lo que hace que la lista se recorra con ↑↓ y se vea cuál está elegido.
function Row({ value, onSelect, children }: { value: string; onSelect: () => void; children: React.ReactNode }) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="data-[selected=true]:bg-surface-2 flex min-h-11 cursor-pointer items-center gap-2.5 rounded-[var(--radius)] px-2.5 py-2 text-sm"
    >
      {children}
    </Command.Item>
  );
}
