import { useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { fetchCatalog, addToCart } from '../lib/api.ts';
import { buildIndex } from '../lib/search.ts';
import { normalizeSeatStatus, type CatalogCourse, type CatalogSection } from '../../../src/shared/schemas.ts';
import { CourseChip } from '../components/CourseChip.tsx';
import { SeatBadge } from '../components/SeatBadge.tsx';
import { StalenessTag } from '../components/StalenessTag.tsx';

export function Buscar() {
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: () => fetchCatalog() });
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);

  const courses = catalog.data?.courses ?? [];
  const byId = useMemo(() => new Map(courses.map((c) => [c.id, c])), [courses]);
  const index = useMemo(() => buildIndex(courses), [courses]);

  const results: CatalogCourse[] = useMemo(() => {
    if (!q.trim()) return courses.slice(0, 50);
    return index
      .search(q)
      .map((r) => byId.get(r.id as number))
      .filter((c): c is CatalogCourse => !!c)
      .slice(0, 50);
  }, [q, index, byId, courses]);

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
                term={catalog.data!.term ?? ''}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function CourseRow({ course, open, onToggle, term }: { course: CatalogCourse; open: boolean; onToggle: () => void; term: string }) {
  return (
    <li className="border-line bg-surface rounded-[var(--radius)] border">
      <button onClick={onToggle} className="hover:bg-surface-2 flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors duration-100">
        <CourseChip code={course.code} title={course.title} />
        <span className="text-muted flex items-center gap-3 text-xs whitespace-nowrap">
          {course.credits != null && <span className="tabular">{course.credits} cr</span>}
          <span>{course.sections.length} secc.</span>
          <span aria-hidden>{open ? '▲' : '▼'}</span>
        </span>
      </button>
      {open && (
        <div className="border-line divide-line divide-y border-t">
          {course.sections.map((s) => (
            <SectionRow key={s.id} section={s} course={course} term={term} />
          ))}
        </div>
      )}
    </li>
  );
}

function SectionRow({ section, course, term }: { section: CatalogSection; course: CatalogCourse; term: string }) {
  const add = useMutation({
    mutationFn: () =>
      addToCart({ term, career: course.career ?? 'GRDO', courseNumber: course.catalogNbr, classNbr: section.classNbr }),
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
        <button
          onClick={() => add.mutate()}
          disabled={add.isPending || add.isSuccess}
          className="border-line hover:bg-surface-2 rounded-[var(--radius)] border px-2.5 py-1 text-xs disabled:opacity-50"
        >
          {add.isSuccess ? 'En el carrito ✓' : add.isPending ? 'Agregando…' : add.isError ? 'Reintentar' : 'Agregar al carrito'}
        </button>
      </div>
      {add.isError && <p className="text-closed w-full text-xs">{(add.error as Error).message}</p>}
    </div>
  );
}
