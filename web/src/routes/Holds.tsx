import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchHolds, syncHolds } from '../lib/api.ts';
import { StalenessTag } from '../components/StalenessTag.tsx';

// Holds y pendientes (plan §5.8), en su versión honesta.
//
// El plan quería severidad: rojo si el hold bloquea la inscripción. El portal
// no la publica —o al menos no se pudo confirmar, porque el estudiante no
// tiene ningún hold que mirar (ver peoplesoft/holds.js)—, así que la pantalla
// no la inventa: lista lo que hay y manda a micampus para el detalle.

const PORTAL_HOLDS_URL =
  'https://micampus.pucmm.edu.do/psp/cs92pro/EMPLOYEE/SA/c/SA_LEARNER_SERVICES.SSS_STUDENT_CENTER.GBL?Page=SSS_STUDENT_CENTER&Action=U';

export function Holds() {
  const queryClient = useQueryClient();
  const { data, isPending, error } = useQuery({ queryKey: ['holds'], queryFn: fetchHolds });
  const sync = useMutation({
    mutationFn: syncHolds,
    onSuccess: (fresh) => queryClient.setQueryData(['holds'], fresh),
  });

  const holds = data?.holds ?? [];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-display text-2xl font-semibold tracking-tight">Holds y pendientes</h1>
        <StalenessTag at={data?.syncedAt ?? null} onRefresh={() => sync.mutate()} refreshing={sync.isPending} />
      </header>

      {sync.error && (
        <p className="text-closed text-sm">PeopleSoft no respondió ({sync.error.message}). Reintentar con "refrescar".</p>
      )}

      {isPending ? (
        <div className="border-line h-32 animate-pulse rounded-[var(--radius)] border" />
      ) : error ? (
        <p className="text-closed text-sm">No se pudo leer lo guardado: {error.message}</p>
      ) : !data?.syncedAt ? (
        <div className="border-line rounded-[var(--radius)] border border-dashed p-8 text-center">
          <p className="text-sm">Todavía no se consultaron tus holds.</p>
          <button
            type="button"
            onClick={() => sync.mutate()}
            disabled={sync.isPending}
            className="bg-accent text-accent-fg mt-3 rounded-[var(--radius)] px-3 py-2 text-sm font-medium disabled:opacity-50"
          >
            {sync.isPending ? 'Leyendo PeopleSoft…' : 'Consultar en PeopleSoft'}
          </button>
        </div>
      ) : !holds.length ? (
        // Un vacío verificado no es lo mismo que un vacío por no haber mirado:
        // acá ya se miró, y por eso el estado se afirma en vez de invitar.
        <div className="border-line rounded-[var(--radius)] border p-8 text-center">
          <p className="text-open text-sm font-medium">No tenés holds ni pendientes.</p>
          <p className="text-muted mt-1 text-xs">Nada que trabar tu inscripción.</p>
        </div>
      ) : (
        <ul className="border-line divide-line divide-y rounded-[var(--radius)] border">
          {holds.map((h, i) => (
            <li key={`${h.title}-${i}`} className="flex items-start justify-between gap-3 px-3 py-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">{h.title}</div>
                {h.description && <p className="text-muted mt-0.5 text-xs">{h.description}</p>}
              </div>
              <a
                href={h.link ?? PORTAL_HOLDS_URL}
                target="_blank"
                rel="noreferrer"
                className="text-muted hover:text-fg shrink-0 text-xs underline underline-offset-2"
              >
                ver en micampus
              </a>
            </li>
          ))}
        </ul>
      )}

      {holds.length > 0 && (
        <p className="text-muted text-xs">
          mikampus no puede decir cuáles de estos bloquean tu inscripción: el portal no publica esa severidad. El
          detalle está en micampus.
        </p>
      )}
    </div>
  );
}
