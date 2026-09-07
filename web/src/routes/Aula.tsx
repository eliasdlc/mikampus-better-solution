import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { BookOpen, ChevronRight, ExternalLink } from 'lucide-react';
import { fetchAula } from '../lib/api.ts';
import { StalenessTag } from '../components/StalenessTag.tsx';
import type { AulaFeedItem } from '../lib/aula.ts';
import { feedLabel, whenLabel } from '../lib/aula.ts';

// El Aula (fase 7, decisión 2B): la pantalla raíz es TODO JUNTO y la materia es
// un filtro, no una carpeta.
//
// Con doce materias del ciclo, una lista de materias obliga a un toque extra
// para la pregunta que uno hace todos los días, que es "qué tengo que hacer".
// Acá esa pregunta se contesta sin elegir nada; tocar una materia filtra esta
// misma pantalla, y su nombre abre la suya.

function FeedRow({ item }: { item: AulaFeedItem }) {
  const { texto, tono } = feedLabel(item);
  const contenido = (
    <>
      <span
        className={`mt-1.5 size-2 shrink-0 rounded-full ${
          tono === 'urgente' ? 'bg-closed' : tono === 'hecho' ? 'bg-open' : 'bg-accent'
        }`}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{item.title}</span>
        <span className="text-muted mt-0.5 block text-xs">
          {item.courseShortname ? `${item.courseShortname} · ` : ''}
          {texto}
        </span>
      </span>
      <span className={`tabular shrink-0 pt-0.5 font-mono text-[11px] ${tono === 'urgente' ? 'text-closed' : 'text-muted'}`}>
        {whenLabel(item.at)}
      </span>
      {item.url && <ExternalLink className="text-muted mt-0.5 size-3.5 shrink-0" aria-hidden />}
    </>
  );

  return (
    <li>
      {item.url ? (
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          className="hover:bg-surface-2 focus-visible:outline-accent flex min-h-11 w-full items-start gap-3 px-3 py-2.5 text-left transition-colors duration-100 focus-visible:outline-2 focus-visible:-outline-offset-2"
        >
          {contenido}
        </a>
      ) : (
        <div className="flex min-h-11 w-full items-start gap-3 px-3 py-2.5 text-left">{contenido}</div>
      )}
    </li>
  );
}

export function Aula() {
  const [materia, setMateria] = useState<number | null>(null);
  const { data, isPending, error } = useQuery({ queryKey: ['aula'], queryFn: () => fetchAula(7) });

  const items = useMemo(
    () => (data?.items ?? []).filter((item) => materia == null || item.courseId === materia),
    [data, materia]
  );
  const activa = data?.courses.find((course) => course.courseId === materia) ?? null;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div>
          <h1 className="font-display text-2xl font-semibold">Aula</h1>
          <p className="text-muted text-sm">
            {data?.courses.length
              ? `${data.courses.length} materia${data.courses.length === 1 ? '' : 's'} del ciclo en la PVA`
              : 'El Moodle de PUCMM'}
          </p>
        </div>
        <StalenessTag at={data?.syncedAt ?? null} />
      </header>

      {isPending ? (
        <div className="border-line text-muted grid h-40 place-items-center rounded-[var(--radius)] border text-sm">Cargando…</div>
      ) : error ? (
        <p className="text-closed text-sm">No se pudo leer el aula guardada: {error.message}</p>
      ) : !data?.linked ? (
        // Sin vincular no hay nada que mostrar, y el vacío tiene que decir por
        // qué: si no, se lee como "no tenés nada que entregar".
        <div className="border-line rounded-[var(--radius)] border border-dashed p-8 text-center">
          <BookOpen className="text-muted mx-auto size-6" aria-hidden />
          <p className="mt-2 text-sm">La PVA no está vinculada todavía.</p>
          <p className="text-muted mt-1 text-sm">
            Agregá su contraseña en el archivo de credencial para que mikampus pueda leer tu aula.
          </p>
        </div>
      ) : (
        <>
          {/* La materia filtra esta misma pantalla. El chip activo es el filtro;
              su nombre completo, abajo, es el que abre la materia. */}
          <div className="flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Filtrar por materia">
            <button
              type="button"
              onClick={() => setMateria(null)}
              aria-pressed={materia == null}
              className={`min-h-8 shrink-0 rounded-full border px-3 py-1 text-xs transition-colors duration-100 ${
                materia == null ? 'border-fg bg-fg text-bg font-medium' : 'border-line text-muted hover:text-fg'
              }`}
            >
              Todas
            </button>
            {data.courses.map((course) => (
              <button
                key={course.courseId}
                type="button"
                onClick={() => setMateria(course.courseId)}
                aria-pressed={materia === course.courseId}
                className={`min-h-8 shrink-0 rounded-full border px-3 py-1 text-xs transition-colors duration-100 ${
                  materia === course.courseId ? 'border-fg bg-fg text-bg font-medium' : 'border-line text-muted hover:text-fg'
                }`}
              >
                {course.shortname}
                {course.pending > 0 && (
                  <span className={`ml-1.5 ${materia === course.courseId ? 'opacity-80' : 'text-accent'}`}>{course.pending}</span>
                )}
              </button>
            ))}
          </div>

          {activa && (
            <Link
              to={`/aula/${activa.courseId}`}
              className="border-line hover:bg-surface-2 focus-visible:outline-accent flex min-h-11 items-center gap-2 rounded-[var(--radius)] border px-3 py-2.5 transition-colors duration-100 focus-visible:outline-2"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{activa.fullname}</span>
                <span className="text-muted mt-0.5 block text-xs">
                  {activa.grade.hidden
                    ? 'Libro oculto por el profesor'
                    : activa.grade.total
                      ? `Nota del aula ${activa.grade.total} · ${activa.grade.gradedItems} de ${activa.grade.gradableItems} items calificados`
                      : 'Sin nota publicada todavía'}
                </span>
              </span>
              <ChevronRight className="text-muted size-4 shrink-0" aria-hidden />
            </Link>
          )}

          {items.length ? (
            <ul className="border-line divide-line divide-y rounded-[var(--radius)] border">
              {items.map((item) => (
                <FeedRow key={item.id} item={item} />
              ))}
            </ul>
          ) : (
            <div className="border-line rounded-[var(--radius)] border border-dashed p-6 text-center">
              <p className="text-sm">
                {materia == null ? 'No hay nada pendiente ni novedades esta semana.' : 'Esa materia no tiene nada esta semana.'}
              </p>
              <p className="text-muted mt-1 text-xs">
                Es lo último que se leyó del aula, no una consulta en vivo.
              </p>
            </div>
          )}

          {materia == null && data.courses.length > 0 && (
            <p className="text-muted text-xs">
              Tocá una materia para filtrar, y su nombre para abrirla entera.
            </p>
          )}
        </>
      )}
    </div>
  );
}
