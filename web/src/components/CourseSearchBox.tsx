import { useMemo, useState } from 'react';
import type { CatalogCourse } from '../../../src/shared/schemas.ts';
import { buildIndex } from '../lib/search.ts';
import { CourseChip } from './CourseChip.tsx';
import { CourseDetailDialog } from './CourseDetailDialog.tsx';

// Input de búsqueda con dropdown para agregar una materia (planner y builder).
// Es la misma búsqueda instantánea del catálogo (índice MiniSearch en memoria),
// acotada a elegir: escribe → aparecen hasta 8 materias → click y listo.
export function CourseSearchBox({
  courses,
  onPick,
  placeholder = 'Agregar materia…',
  exclude = [],
  suggestions = [],
}: {
  courses: CatalogCourse[];
  onPick?: (course: CatalogCourse) => void;
  placeholder?: string;
  exclude?: number[]; // ids de materias ya agregadas — no se reofrecen
  suggestions?: CatalogCourse[];
}) {
  const [q, setQ] = useState('');
  const [focused, setFocused] = useState(false);
  const [detail, setDetail] = useState<CatalogCourse | null>(null);
  const index = useMemo(() => buildIndex(courses), [courses]);
  const byId = useMemo(() => new Map(courses.map((c) => [c.id, c])), [courses]);

  const results = useMemo(() => {
    if (!q.trim()) return suggestions.filter((c) => !exclude.includes(c.id)).slice(0, 6);
    return index
      .search(q)
      .map((r) => byId.get(r.id as number))
      .filter((c): c is CatalogCourse => !!c && !exclude.includes(c.id))
      .slice(0, 8);
  }, [q, index, byId, exclude, suggestions]);

  return (
    <div className="relative">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => setFocused(true)}
        // onBlur cierra el popover; los ítems usan onMouseDown, que dispara
        // antes del blur, así que el click se registra antes de desmontarlo.
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => e.key === 'Escape' && (e.currentTarget.blur(), setFocused(false))}
        placeholder={placeholder}
        className="border-line bg-surface focus:border-accent w-full rounded-[var(--radius)] border px-3 py-2 text-sm outline-none"
      />
      {focused && results.length > 0 && (
        <ul className="border-line bg-surface absolute z-30 mt-1 max-h-72 w-full overflow-auto rounded-[var(--radius)] border shadow-lg">
          {!q.trim() && <li className="text-muted border-line border-b px-3 py-2 text-xs">Lo que te toca cursar este ciclo</li>}
          {results.map((course) => (
            <li key={course.id} className="flex items-stretch">
              {/* onMouseDown y no onClick: dispara antes del blur del input,
                  que si no cierra el dropdown antes de que llegue el click. */}
              <button
                type="button"
                onMouseDown={() => {
                  setDetail(course);
                  setQ('');
                }}
                className="hover:bg-surface-2 flex min-w-0 flex-1 items-center justify-between gap-2 px-3 py-2 text-left"
              >
                <CourseChip code={course.code} title={course.title} size="sm" />
                <span className="text-muted text-xs whitespace-nowrap">{course.sections.length} secc.</span>
              </button>
              {onPick && (
                <button
                  type="button"
                  onMouseDown={() => {
                    onPick(course);
                    setQ('');
                  }}
                  className="border-line text-muted hover:bg-surface-2 border-l px-3 text-xs"
                  aria-label={`Agregar ${course.title}`}
                  title="Agregar materia"
                >
                  +
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <CourseDetailDialog course={detail} open={detail !== null} onClose={() => setDetail(null)} onPick={onPick} />
    </div>
  );
}
