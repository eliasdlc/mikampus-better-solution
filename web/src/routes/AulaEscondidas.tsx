import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { fetchEscondidas, mostrarMateria } from '../lib/api.ts';
import type { EscondidasResponse } from '../../../src/shared/schemas.ts';

// El cajón de las escondidas (decisión 3A y 4A).
//
// Dos grupos que no se pueden mezclar: la copia sin usar de una materia que
// estás cursando, y las materias de un ciclo que terminó. Las de ciclos
// pasados son de solo lectura, pero su material se busca igual: es justo lo
// que uno busca cuando estudia el curso siguiente.

type Escondida = EscondidasResponse['copies'][number];

function Fila({ course, onMostrar, trabajando }: { course: Escondida; onMostrar: (id: number) => void; trabajando: boolean }) {
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <Link to={`/aula/${course.courseId}`} className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{course.name}</span>
        <span className="text-muted tabular mt-0.5 block font-mono text-[11px]">
          {course.shortname} · {course.cycle}
        </span>
        <span className="text-muted mt-0.5 block text-xs">
          {course.modules} módulos · {course.files} archivos
          {/* Quién la escondió importa: lo que se escondió en la plataforma se
              deshace allá, no acá. */}
          {course.hiddenRemote ? ' · escondida en la PVA' : ''}
        </span>
      </Link>
      {course.hiddenLocal && (
        <button
          type="button"
          disabled={trabajando}
          onClick={() => onMostrar(course.courseId)}
          className="border-line hover:bg-surface-2 min-h-9 shrink-0 rounded-full border px-3 text-xs font-medium disabled:opacity-40"
        >
          Mostrar
        </button>
      )}
    </li>
  );
}

export function AulaEscondidas() {
  const client = useQueryClient();
  const { data, isPending, error } = useQuery({ queryKey: ['escondidas'], queryFn: fetchEscondidas });
  const mostrar = useMutation({
    mutationFn: mostrarMateria,
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['escondidas'] });
      client.invalidateQueries({ queryKey: ['aula'] });
    },
  });

  return (
    <div className="space-y-4">
      <header>
        <Link to="/aula" className="text-muted hover:text-fg -ml-1 inline-flex min-h-8 items-center gap-1 text-sm">
          <ChevronLeft className="size-4" aria-hidden />
          Aula
        </Link>
        <h1 className="font-display mt-1 text-2xl leading-tight font-semibold">Escondidas</h1>
        <p className="text-muted text-sm">Su material sigue acá: se abre, se busca y se baja igual.</p>
      </header>

      {isPending ? (
        <p className="text-muted py-8 text-center text-sm">Cargando…</p>
      ) : error ? (
        <p className="text-closed text-sm">No se pudieron leer: {error.message}</p>
      ) : (
        <>
          {data.copies.length > 0 && (
            <section>
              <h2 className="text-muted text-[10px] font-semibold tracking-wide uppercase">Copias de este ciclo</h2>
              <p className="text-muted mt-1 mb-1 text-xs">
                La universidad crea dos clases por materia y el profesor usa una. Estas son las otras.
              </p>
              <ul className="border-line divide-line divide-y rounded-[var(--radius)] border">
                {data.copies.map((course) => (
                  <Fila key={course.courseId} course={course} onMostrar={mostrar.mutate} trabajando={mostrar.isPending} />
                ))}
              </ul>
            </section>
          )}

          {data.previous.length > 0 && (
            <section>
              <h2 className="text-muted text-[10px] font-semibold tracking-wide uppercase">Ciclos pasados</h2>
              <ul className="border-line divide-line divide-y mt-1 rounded-[var(--radius)] border">
                {data.previous.map((course) => (
                  <Fila key={course.courseId} course={course} onMostrar={mostrar.mutate} trabajando={mostrar.isPending} />
                ))}
              </ul>
            </section>
          )}

          {data.copies.length === 0 && data.previous.length === 0 && (
            <div className="border-line rounded-[var(--radius)] border border-dashed p-8 text-center">
              <p className="text-sm">No hay materias escondidas.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
