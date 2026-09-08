import { useMutation, useQueryClient } from '@tanstack/react-query';
import { conservarPar, esconderMateria } from '../lib/api.ts';
import type { AulaOverviewResponse } from '../../../src/shared/schemas.ts';

// Las dos clases de la misma materia (decisión 2A).
//
// La universidad crea dos y el profesor usa una. mikampus lo reconoce con dos
// señales que ya tiene (mismo nombre, y una con contenido y la otra sin) y lo
// PROPONE con esa evidencia a la vista. No lo decide solo a propósito: "sin
// contenido" no prueba que sea la copia, porque un profesor puede empezar a
// usar la otra clase en la semana cinco.

type Par = AulaOverviewResponse['pairs'][number];

export function ParDeMaterias({ par }: { par: Par }) {
  const client = useQueryClient();
  const refrescar = () => client.invalidateQueries({ queryKey: ['aula'] });

  const esconder = useMutation({
    mutationFn: (courseId: number) => esconderMateria(courseId, par.key),
    onSuccess: refrescar,
  });
  const conservar = useMutation({
    mutationFn: () => conservarPar(par.key, par.courses.map((course) => course.courseId)),
    onSuccess: refrescar,
  });

  const sobra = par.suggested[0] ?? null;

  return (
    <section className="border-accent bg-surface rounded-[var(--radius)] border p-3">
      <h2 className="text-accent text-sm font-semibold">Dos clases de la misma materia</h2>
      <p className="text-muted mt-0.5 text-xs">{par.name}</p>

      <ul className="divide-line mt-2 divide-y">
        {par.courses.map((course) => (
          <li key={course.courseId} className="flex items-center gap-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="text-muted tabular block font-mono text-[11px]">{course.shortname}</span>
              <span className="text-muted mt-0.5 block text-xs">
                {course.modules} módulos · {course.assignments} tareas · {course.files} archivos
              </span>
            </span>
            {sobra === course.courseId ? (
              <span className="bg-surface-2 text-muted shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold">vacía</span>
            ) : (
              <span className="bg-open/15 text-open shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold">la usan</span>
            )}
          </li>
        ))}
      </ul>

      {sobra ? (
        <button
          type="button"
          disabled={esconder.isPending}
          onClick={() => esconder.mutate(sobra)}
          className="bg-accent text-accent-fg mt-2 min-h-11 w-full rounded-full text-sm font-semibold disabled:opacity-40"
        >
          Esconder la vacía
        </button>
      ) : (
        // Las dos tienen contenido, o las dos están vacías: mikampus no sabe
        // cuál sobra y no va a adivinar.
        <p className="text-muted mt-2 text-xs">
          Las dos tienen contenido, así que no se cuál usa el profesor. Escondé la que quieras desde su pantalla.
        </p>
      )}
      <button
        type="button"
        disabled={conservar.isPending}
        onClick={() => conservar.mutate()}
        className="border-line hover:bg-surface-2 mt-2 min-h-11 w-full rounded-full border text-sm font-medium disabled:opacity-40"
      >
        Dejar las dos
      </button>
    </section>
  );
}
