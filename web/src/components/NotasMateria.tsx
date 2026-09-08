import { useQuery } from '@tanstack/react-query';
import { fetchNotasAula } from '../lib/api.ts';
import { decodeGrade } from '../lib/aula.ts';

// Las notas del AULA, item por item.
//
// No son las del expediente: son las que el profesor puso en su libro, y no
// tienen por qué coincidir con las oficiales de micampus. Esa confusión es la
// más cara del dominio, así que la pantalla lo dice en vez de suponerlo.

export function NotasMateria({ courseId }: { courseId: number }) {
  const { data, isPending, error } = useQuery({ queryKey: ['notas-aula', courseId], queryFn: () => fetchNotasAula(courseId) });

  if (isPending) return <p className="text-muted py-8 text-center text-sm">Cargando el libro…</p>;
  if (error) return <p className="text-closed text-sm">No se pudo leer el libro guardado: {error.message}</p>;

  const cerrado = data.access?.reachable === 0;
  const deshabilitado = data.access?.showGrades === 0;
  // El total del curso y los subtotales viven en el libro pero no son cosas que
  // se entregan: van aparte del listado.
  const items = data.items.filter((item) => item.itemtype === 'mod' || item.itemtype === 'manual');

  if (deshabilitado || cerrado) {
    return (
      <div className="border-line rounded-[var(--radius)] border border-dashed p-6 text-center">
        <p className="text-sm">{deshabilitado ? 'La PVA tiene el libro deshabilitado en esta materia.' : 'El profesor tiene su libro oculto.'}</p>
        <p className="text-muted mt-1 text-xs">
          {deshabilitado
            ? 'No hay nada que leer mientras siga así.'
            : 'La nota puede existir igual: se ve tarea por tarea en la entrega de cada una.'}
        </p>
      </div>
    );
  }

  if (!items.length) {
    return (
      <div className="border-line rounded-[var(--radius)] border border-dashed p-6 text-center">
        <p className="text-sm">El libro de esta materia todavía no tiene items.</p>
        <p className="text-muted mt-1 text-xs">Aparecen cuando el profesor los crea, aunque no tengan nota.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {data.total?.display && (
        <div className="border-line bg-surface flex items-baseline justify-between rounded-[var(--radius)] border p-3">
          <span className="text-muted text-[10px] font-semibold tracking-wide uppercase">Total del aula</span>
          <span className="font-display text-xl font-semibold">{decodeGrade(data.total.display)}</span>
        </div>
      )}
      <ul className="border-line divide-line divide-y rounded-[var(--radius)] border">
        {items.map((item) => (
          <li key={item.itemId} className="flex items-center gap-3 px-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{item.name ?? 'Item sin nombre'}</span>
              <span className="text-muted mt-0.5 block text-xs">
                {item.isHidden === 1
                  ? 'El profesor tiene esta nota oculta'
                  : item.gradedAt
                    ? `Calificada el ${new Date(item.gradedAt * 1000).toLocaleDateString()}`
                    : 'Sin calificar todavía'}
              </span>
            </span>
            <span className="tabular shrink-0 font-mono text-sm">
              {/* Una nota que no está es un guion bajo, no un cero: el cero es
                  una nota real y decirlo mal cambia el promedio en la cabeza. */}
              {item.display && item.rawText != null ? decodeGrade(item.display) : <span className="text-muted">sin nota</span>}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-muted text-xs">
        Es el libro del profesor en la PVA, no tu expediente. La nota oficial vive en Notas y avance.
      </p>
    </div>
  );
}
