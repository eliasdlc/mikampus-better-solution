import { useMemo, useState } from 'react';
import type { CatalogCourse } from '../../../src/shared/schemas.ts';
import { buildIndex } from '../lib/search.ts';
import { CourseChip } from './CourseChip.tsx';

// Input de búsqueda con dropdown para agregar una materia (planner y builder).
// Es la misma búsqueda instantánea de /buscar (índice MiniSearch en memoria),
// acotada a elegir: escribe → aparecen hasta 8 materias → click y listo.
export function CourseSearchBox({
  courses,
  onPick,
  placeholder = 'Agregar materia…',
  exclude = [],
}: {
  courses: CatalogCourse[];
  onPick: (course: CatalogCourse) => void;
  placeholder?: string;
  exclude?: number[]; // ids de materias ya agregadas — no se reofrecen
}) {
  const [q, setQ] = useState('');
  const index = useMemo(() => buildIndex(courses), [courses]);
  const byId = useMemo(() => new Map(courses.map((c) => [c.id, c])), [courses]);

  const results = useMemo(() => {
    if (!q.trim()) return [];
    return index
      .search(q)
      .map((r) => byId.get(r.id as number))
      .filter((c): c is CatalogCourse => !!c && !exclude.includes(c.id))
      .slice(0, 8);
  }, [q, index, byId, exclude]);

  return (
    <div className="relative">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        className="border-line bg-surface focus:border-accent w-full rounded-[var(--radius)] border px-3 py-2 text-sm outline-none"
      />
      {results.length > 0 && (
        <ul className="border-line bg-surface absolute z-30 mt-1 max-h-72 w-full overflow-auto rounded-[var(--radius)] border shadow-none">
          {results.map((course) => (
            <li key={course.id}>
              {/* onMouseDown y no onClick: dispara antes del blur del input,
                  que si no cierra el dropdown antes de que llegue el click. */}
              <button
                onMouseDown={() => {
                  onPick(course);
                  setQ('');
                }}
                className="hover:bg-surface-2 flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
              >
                <CourseChip code={course.code} title={course.title} size="sm" />
                <span className="text-muted text-xs whitespace-nowrap">{course.sections.length} secc.</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
