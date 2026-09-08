import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Lock, MessageSquare, X } from 'lucide-react';
import { fetchDiscusiones } from '../lib/api.ts';
import { whenLabel } from '../lib/aula.ts';

// Un foro del aula (decisión 3A): se leen sus discusiones en el momento y no
// se guarda nada.
//
// mikampus solo guarda el contador de anuncios, así que no hay copia local que
// mostrar; y la función que las lista está declarada en la instancia pero
// nunca se llamó, así que su forma no está verificada. Por eso esta pantalla
// lee y no escribe: responder llega cuando esta lectura se haya visto contra
// el aula real una vez.

export function ForoSheet({ forumId, name, url, onClose }: { forumId: number; name: string; url: string | null; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const { data, isPending, error } = useQuery({
    queryKey: ['foro', forumId],
    queryFn: () => fetchDiscusiones(forumId),
    // Es una llamada a la PVA en vivo: no se repite sola al volver a la ventana.
    refetchOnWindowFocus: false,
    retry: false,
  });

  return (
    <div className="fixed inset-0 z-[60] flex items-end bg-black/40 sm:items-center sm:justify-center sm:p-4" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="foro-title"
        onMouseDown={(event) => event.stopPropagation()}
        className="border-line bg-surface max-h-[92vh] w-full overflow-y-auto rounded-t-[var(--radius)] border p-4 shadow-2xl sm:max-w-lg sm:rounded-[var(--radius)]"
      >
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="foro-title" className="font-display text-lg leading-tight font-semibold">
              {name}
            </h2>
            <p className="text-muted mt-1 text-xs">Se lee al abrir esta hoja, no se guarda nada.</p>
          </div>
          <button type="button" onClick={onClose} className="text-muted hover:text-fg -mt-1 -mr-1 p-2" aria-label="Cerrar">
            <X className="size-5" aria-hidden />
          </button>
        </header>

        {isPending ? (
          <p className="text-muted py-8 text-center text-sm">Preguntándole a la PVA…</p>
        ) : error ? (
          <p className="text-closed mt-3 text-sm">No se pudieron leer las discusiones: {error.message}</p>
        ) : !data?.discussions.length ? (
          <div className="border-line mt-3 rounded-[var(--radius)] border border-dashed p-6 text-center">
            <MessageSquare className="text-muted mx-auto size-5" aria-hidden />
            <p className="mt-2 text-sm">Este foro no tiene discusiones.</p>
          </div>
        ) : (
          <ul className="border-line divide-line mt-3 divide-y rounded-[var(--radius)] border">
            {data.discussions.map((hilo) => (
              <li key={hilo.discussionId} className="flex items-start gap-3 px-3 py-2.5">
                <MessageSquare className="text-muted mt-0.5 size-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm leading-snug font-medium">{hilo.subject}</span>
                  <span className="text-muted mt-0.5 flex items-center gap-1.5 text-xs">
                    {hilo.author || 'sin autor'}
                    {hilo.locked && (
                      <>
                        <Lock className="size-3" aria-hidden />
                        cerrada
                      </>
                    )}
                  </span>
                </span>
                {hilo.lastPostAt && <span className="text-muted tabular shrink-0 font-mono text-[11px]">{whenLabel(hilo.lastPostAt)}</span>}
              </li>
            ))}
          </ul>
        )}

        <p className="border-line text-muted mt-3 border-t pt-3 text-xs leading-relaxed">
          Responder desde mikampus llega cuando esta lectura se haya visto contra tu aula una vez: la función existe en la instancia,
          pero nunca se llamó y su forma no está verificada.
        </p>

        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="text-muted hover:text-fg mt-2 flex min-h-8 items-center justify-center gap-1.5 text-xs"
          >
            Abrir el foro en la PVA
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        )}
      </section>
    </div>
  );
}
