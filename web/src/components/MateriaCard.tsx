import { Link } from 'react-router-dom';
import type { AulaCourseCard } from '../../../src/shared/schemas.ts';
import { gradeLabel, whenLabel } from '../lib/aula.ts';

// Una materia del ciclo (decisión 1A): lo que debés, en grande.
//
// Moodle pone una foto de colores y "0 de 131 actividades completadas". Ese
// porcentaje no dice qué hacer hoy. Acá manda la fecha de lo próximo, después
// el nombre, y el código queda de dato chico porque nadie reconoce su materia
// por "CSTI-1930-5227".

export function MateriaCard({ course }: { course: AulaCourseCard }) {
  const vence = course.next?.dueAt ?? null;
  // Sin consultar el estado de la entrega, urgente no se puede afirmar: eso ya
  // lo decide el modelo, acá solo se pinta lo que llegó.
  const urgente = course.next?.submitted !== true && vence != null;

  return (
    <Link
      to={`/aula/${course.courseId}`}
      className="border-line bg-surface hover:bg-surface-2 focus-visible:outline-accent block rounded-[var(--radius)] border p-3 transition-colors duration-100 focus-visible:outline-2"
    >
      <p className="text-sm leading-snug font-semibold">{course.name}</p>
      <p className="text-muted tabular mt-0.5 font-mono text-[11px]">{course.shortname}</p>

      <div className="mt-2 flex items-baseline gap-2">
        <span className={`text-sm font-bold ${urgente ? 'text-closed' : 'text-muted'}`}>
          {vence ? whenLabel(vence) : 'sin fecha'}
        </span>
        <span className="text-muted min-w-0 flex-1 truncate text-xs">{course.next?.name ?? 'Nada pendiente'}</span>
        {course.pending > 0 && (
          <span className="bg-accent text-accent-fg shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-bold">{course.pending}</span>
        )}
      </div>

      <p className="text-muted mt-1.5 text-xs">{gradeLabel(course.grade)}</p>

      {course.progress != null && (
        <span className="bg-surface-2 mt-2 block h-1 overflow-hidden rounded-full" aria-hidden>
          <span className="bg-accent block h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, course.progress))}%` }} />
        </span>
      )}
    </Link>
  );
}
