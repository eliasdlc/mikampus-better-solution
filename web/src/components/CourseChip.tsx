import { courseColor } from '../lib/color.ts';

// El componente transversal del plan: nombre real de la materia como texto
// principal (Inter), el código en chip pequeño monoespaciado al lado, y la
// barrita del color estable de la materia a la izquierda. Es el hilo visual que
// une búsqueda, planner, builder, horario y carrito.
export function CourseChip({
  code,
  title,
  classNbr,
  size = 'md',
}: {
  code: string;
  title: string;
  classNbr?: string | null;
  size?: 'sm' | 'md';
}) {
  const color = courseColor(code);
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="h-6 w-1 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
      <div className="min-w-0">
        <div className={`truncate font-medium ${size === 'sm' ? 'text-sm' : 'text-[15px]'}`}>{title}</div>
        <div className="tabular text-muted font-mono text-xs">
          {code}
          {classNbr ? ` · ${classNbr}` : ''}
        </div>
      </div>
    </div>
  );
}
