import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { dropScheduleCourse } from '../lib/api.ts';
import type { ScheduleCourse } from '../../../src/shared/schemas.ts';
import { CourseChip } from './CourseChip.tsx';
import { LiveOpBanner } from './LiveOpBanner.tsx';

// La baja de una materia: el panel con lo inscrito y el diálogo de confirmación.
//
// Vivía dentro de /horario, y solo ahí. Pero dar de baja no es "mirar mi
// horario": es la mitad que falta de inscribirse — se suelta un cupo para
// tomar otro, casi siempre en la misma sesión y contra el mismo ciclo. Tenerlo
// en otra pantalla obligaba a salir del recorrido de inscripción justo en el
// momento de más presión.
//
// Extraído acá para que las dos pantallas usen el MISMO flujo, con el mismo
// contrato de confirmación: escribir el código exacto. Una segunda copia de
// una acción irreversible es una copia que se va a quedar atrás.

export function DropCoursePanel({
  courses,
  termCode,
  heading = 'Materias inscritas',
  hint,
  onDropped,
}: {
  courses: ScheduleCourse[];
  // El STRM. La baja usa el flujo de inscripción, que solo opera sobre el ciclo
  // abierto para inscribir; sin STRM no hay a qué mandarle la petición y el
  // panel no se muestra.
  termCode: string | null;
  heading?: string;
  hint?: string;
  onDropped?: () => void;
}) {
  const qc = useQueryClient();
  const [target, setTarget] = useState<ScheduleCourse | null>(null);
  const [confirmCode, setConfirmCode] = useState('');

  const drop = useMutation({
    mutationFn: (course: ScheduleCourse) =>
      dropScheduleCourse({
        term: termCode!,
        courseCode: course.code,
        classNbr: course.sections[0]?.classNbr ?? null,
        confirmCode,
      }),
    onSuccess: () => {
      // El horario de CUALQUIER ciclo puede haber cambiado de forma, y el
      // contexto de términos también (un ciclo puede quedarse sin materias).
      qc.invalidateQueries({ queryKey: ['my-schedule'] });
      qc.invalidateQueries({ queryKey: ['term-context'] });
      setTarget(null);
      setConfirmCode('');
      onDropped?.();
    },
  });

  const enrolled = courses.filter((course) => course.status === 'enrolled');
  if (!termCode || enrolled.length === 0) return null;

  return (
    <>
      <LiveOpBanner active={drop.isPending} message={`Dando de baja ${target?.code ?? 'la materia'} en PeopleSoft…`} />

      <section className="border-line bg-surface rounded-[var(--radius)] border print:hidden">
        <header className="border-line border-b px-4 py-2.5">
          <h2 className="text-sm font-medium">{heading}</h2>
          {hint && <p className="text-muted mt-0.5 text-xs">{hint}</p>}
        </header>
        <ul className="divide-line divide-y">
          {enrolled.map((course) => (
            <li key={course.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <CourseChip
                code={course.code}
                title={course.title}
                classNbr={course.sections[0]?.classNbr ?? null}
                size="sm"
              />
              <button
                type="button"
                onClick={() => {
                  setTarget(course);
                  setConfirmCode('');
                  drop.reset();
                }}
                className="text-muted hover:text-closed rounded-[var(--radius)] px-2 py-1 text-xs underline underline-offset-2"
              >
                Dar de baja
              </button>
            </li>
          ))}
        </ul>
      </section>

      {target && (
        <div
          className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/55 p-4 print:hidden"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !drop.isPending) setTarget(null);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="drop-title"
            className="border-line bg-surface w-full max-w-md rounded-[var(--radius)] border p-5"
          >
            <div className="border-closed mb-4 border-l-4 pl-3">
              <p className="text-closed text-xs font-medium tracking-wide uppercase">Acción irreversible</p>
              <h2 id="drop-title" className="font-display mt-0.5 text-xl font-semibold tracking-tight">
                Dar de baja {target.title}
              </h2>
            </div>
            <p className="text-muted text-sm">
              PeopleSoft quitará la materia y sus componentes de tu inscripción. Si el cupo se ocupa, no podrás
              recuperarlo desde mikampus.
            </p>
            <label className="mt-4 block text-sm">
              Escribí <span className="tabular font-mono font-medium">{target.code}</span> para continuar
              <input
                autoFocus
                value={confirmCode}
                onChange={(event) => setConfirmCode(event.target.value.toUpperCase())}
                disabled={drop.isPending}
                className="border-line bg-bg tabular mt-1.5 w-full rounded-[var(--radius)] border px-3 py-2 font-mono text-sm focus:outline-2 focus:outline-offset-2 focus:outline-[var(--color-accent)]"
              />
            </label>
            {drop.error && <p className="text-closed mt-3 text-sm">{(drop.error as Error).message}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setTarget(null)}
                disabled={drop.isPending}
                className="border-line hover:bg-surface-2 rounded-[var(--radius)] border px-3 py-2 text-sm"
              >
                Conservar materia
              </button>
              <button
                type="button"
                onClick={() => drop.mutate(target)}
                disabled={drop.isPending || confirmCode !== target.code}
                className="bg-closed rounded-[var(--radius)] px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
              >
                {drop.isPending ? 'Procesando baja…' : 'Dar de baja definitivamente'}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
