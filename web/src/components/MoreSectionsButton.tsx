import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { syncCourseSections } from '../lib/api.ts';
import type { CatalogCourse } from '../../../src/shared/schemas.ts';

// El catálogo local se llena por barridos de subject: caros (minutos por
// subject) y por eso espaciados. Durante una inscripción eso significa que la
// lista de grupos que ves es una foto vieja — y los grupos que abren a última
// hora, que son los que quedan libres, no están ahí.
//
// Este botón es la salida: una sola navegación al portal para UNA materia, que
// persiste lo que encuentre en el catálogo local. No es un refresh de la
// pantalla: es el catálogo el que aprende, así que Buscar, el Builder y el
// recomendador ven los grupos nuevos sin volver a pedir nada.
export function MoreSectionsButton({
  course,
  term,
  known,
  className = '',
}: {
  course: Pick<CatalogCourse, 'code' | 'career'>;
  // El STRM del ciclo. Sin él PeopleSoft no acepta la consulta, así que el
  // botón no se ofrece: prometer una búsqueda que no puede correr es peor que
  // no ofrecerla.
  term: string | null;
  // Cuántos grupos hay ahora mismo en el catálogo local, para poder decir si la
  // consulta trajo algo nuevo o confirmó lo que ya había.
  known: number;
  className?: string;
}) {
  const qc = useQueryClient();
  const sync = useMutation({
    mutationFn: () => syncCourseSections({ term: term!, courseCode: course.code, career: course.career }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['catalog'] }),
  });

  if (!term) return null;

  const found = sync.data?.course?.sections.length ?? null;
  const nuevos = found == null ? null : found - known;

  return (
    <span className={`inline-flex flex-wrap items-center gap-2 ${className}`}>
      <button
        type="button"
        onClick={() => sync.mutate()}
        disabled={sync.isPending}
        title="Consulta el portal en vivo y guarda todos los grupos de esta materia"
        className="border-line hover:bg-surface-2 inline-flex min-h-8 items-center gap-1.5 rounded-[var(--radius)] border px-2.5 py-1 text-xs disabled:opacity-50"
      >
        <RefreshCw className={`size-3.5 ${sync.isPending ? 'animate-spin' : ''}`} aria-hidden />
        {sync.isPending ? 'Consultando el portal…' : 'Ver más grupos'}
      </button>
      {/* Que la consulta no haya traído nada nuevo es información, no un
          fracaso: confirma que la lista que estás mirando es la real. */}
      {sync.isSuccess && (
        <span className="text-muted text-xs">
          {nuevos != null && nuevos > 0
            ? `+${nuevos} grupo(s) nuevo(s) · ${found} en total`
            : `sin grupos nuevos · ${found ?? known} en total`}
        </span>
      )}
      {sync.isError && <span className="text-closed text-xs">{(sync.error as Error).message}</span>}
    </span>
  );
}
