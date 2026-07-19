import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { fetchCatalog, fetchPensumCodes } from '../lib/api.ts';
import { buildIndex } from '../lib/search.ts';
import type { CatalogCourse } from '../../../src/shared/schemas.ts';
import { CourseDetailDialog } from './CourseDetailDialog.tsx';
import { courseColor } from '../lib/color.ts';

// ⌘K global (plan §12): la búsqueda de materias vive acá y cerca de las
// acciones que la necesitan, no como una sección de navegación. Una materia
// abre la misma ficha de grupos y acciones que los buscadores locales.

const NAV = [
  { to: '/', label: 'Inicio' },
  { to: '/planear', label: 'Planear' },
  { to: '/horario', label: 'Mi horario' },
  { to: '/inscripcion', label: 'Carrito e inscripción' },
  { to: '/academico', label: 'Notas y avance' },
  { to: '/ajustes', label: 'Ajustes' },
];

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState<CatalogCourse | null>(null);

  // El catálogo solo se pide (y el índice solo se construye) cuando el overlay
  // se abre por primera vez: montar el palette en toda la app no puede costarle
  // un índice MiniSearch a quien nunca lo use. Después es cache de TanStack,
  // compartido con los buscadores dentro de Planear e Inscripción.
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: () => fetchCatalog(), enabled: open });
  const pensumCodesQ = useQuery({ queryKey: ['pensum-codes'], queryFn: fetchPensumCodes, enabled: open });
  const pensumCodes = useMemo(() => new Set(pensumCodesQ.data ?? []), [pensumCodesQ.data]);
  const courses = catalog.data?.courses ?? [];
  const byId = useMemo(() => new Map(courses.map((c) => [c.id, c])), [courses]);
  const index = useMemo(() => buildIndex(courses), [courses]);

  // Cada apertura empieza limpia: el palette es para actuar rápido, no para
  // retomar lo que buscabas hace dos días.
  useEffect(() => {
    if (!open) setQ('');
  }, [open]);

  const resultados = useMemo(() => {
    if (!q.trim()) return [];
    const todos = index
      .search(q)
      .map((r) => byId.get(r.id as number))
      .filter((c): c is CatalogCourse => !!c);
    // Carrera-first (§11): primero lo tuyo. Si la búsqueda no matchea nada de
    // tu pénsum, cae al catálogo entero — el palette nunca queda inútil.
    const propios = pensumCodes.size ? todos.filter((c) => pensumCodes.has(c.code)) : todos;
    return (propios.length ? propios : todos).slice(0, 8);
  }, [q, index, byId, pensumCodes]);

  const irA = (to: string) => {
    onOpenChange(false);
    navigate(to);
  };

  return (
    <>
      <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Buscar y ejecutar acciones"
      shouldFilter={false}
      overlayClassName="fixed inset-0 z-40 bg-black/40"
      contentClassName="border-line bg-surface fixed top-[12vh] left-1/2 z-50 w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-[var(--radius)] border shadow-2xl"
    >
      <Command.Input
        value={q}
        onValueChange={setQ}
        autoFocus
        placeholder="Buscar materias, ir a una pantalla…"
        className="border-line placeholder:text-muted w-full border-b bg-transparent px-4 py-3.5 text-base outline-none"
      />

      <Command.List className="max-h-[min(400px,50vh)] overflow-y-auto p-1.5">
        <RootPage
          q={q}
          cargando={catalog.isLoading}
          resultados={resultados}
          onCourse={(course) => {
            setDetail(course);
            onOpenChange(false);
          }}
          onNav={irA}
        />
      </Command.List>
      </Command.Dialog>
      <CourseDetailDialog course={detail} open={detail !== null} onClose={() => setDetail(null)} />
    </>
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

// data-[selected=true]: cmdk marca así el item bajo el cursor del teclado. Es
// lo que hace que la lista se recorra con ↑↓ y se vea cuál está elegido.
function Row({ value, onSelect, children }: { value: string; onSelect: () => void; children: ReactNode }) {
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
