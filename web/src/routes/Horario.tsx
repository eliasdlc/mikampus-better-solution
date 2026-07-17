import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchMySchedule, syncMySchedule } from '../lib/api.ts';
import { WeeklyGrid } from '../components/WeeklyGrid.tsx';
import { CourseChip } from '../components/CourseChip.tsx';
import { StalenessTag } from '../components/StalenessTag.tsx';
import { toBlocks } from '../lib/grid.ts';
import { downloadICS } from '../lib/ics.ts';
import { DAY_LABELS, WEEK_DAYS, toMinutes, type DayCode } from '../../../src/shared/meetings.ts';
import type { ScheduleResponse } from '../../../src/shared/schemas.ts';

// Mi horario (plan §5.5): el WeeklyGrid a pantalla completa, con toggle a vista
// de lista (la default en mobile) y exportar ICS.

function Agenda({ data }: { data: ScheduleResponse }) {
  const blocks = toBlocks(data.courses);
  const byDay = new Map<DayCode, typeof blocks>(WEEK_DAYS.map((d) => [d, []]));
  for (const b of blocks) byDay.get(b.day)?.push(b);
  const days = WEEK_DAYS.filter((d) => (byDay.get(d)?.length ?? 0) > 0);

  if (!days.length) return <p className="text-muted text-sm">Ninguna de tus materias tiene horario asignado todavía.</p>;

  return (
    <div className="space-y-5">
      {days.map((day) => (
        <section key={day}>
          <h2 className="text-muted mb-2 text-xs font-medium tracking-wide uppercase">{DAY_LABELS[day]}</h2>
          <ul className="border-line divide-line divide-y rounded-[var(--radius)] border">
            {byDay
              .get(day)!
              .sort((a, b) => toMinutes(a.start) - toMinutes(b.start))
              .map((b) => (
                <li key={b.id} className="flex min-h-11 items-center justify-between gap-3 px-3 py-2">
                  <CourseChip code={b.code} title={b.title} classNbr={b.classNbr} size="sm" />
                  <div className="text-right">
                    <div className="tabular font-mono text-xs">
                      {b.start}–{b.end}
                    </div>
                    <div className="text-muted text-xs">{b.room ?? 'Aula por definir'}</div>
                  </div>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function Horario() {
  // Lista por defecto en mobile: una grilla de seis días no se lee en 390px,
  // aunque el grid sepa hacer carrusel.
  const [view, setView] = useState<'grid' | 'list'>(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches ? 'list' : 'grid'
  );
  const queryClient = useQueryClient();

  const { data, isPending, error } = useQuery({
    queryKey: ['my-schedule'],
    queryFn: () => fetchMySchedule(),
  });

  // El refresh es explícito y va en vivo contra PeopleSoft (tarda segundos).
  // Mientras corre, la pantalla sigue mostrando lo cacheado: nunca se bloquea.
  const sync = useMutation({
    mutationFn: syncMySchedule,
    onSuccess: (fresh) => queryClient.setQueryData(['my-schedule'], fresh),
  });

  const courses = data?.courses ?? [];
  const credits = courses.reduce((n, c) => n + (c.units ?? 0), 0);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Mi horario</h1>
          {courses.length > 0 && (
            <p className="text-muted tabular mt-0.5 text-sm">
              {courses.length} {courses.length === 1 ? 'materia' : 'materias'} · {credits} créditos
            </p>
          )}
        </div>

        {/* Los controles no van al papel: la hoja es el horario, no la app.
            flex-wrap: con el botón de imprimir ya son cuatro y no entran en una
            línea de 390px. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 print:hidden">
          <StalenessTag at={data?.syncedAt ?? null} onRefresh={() => sync.mutate()} refreshing={sync.isPending} />

          <div className="border-line flex rounded-[var(--radius)] border p-0.5" role="group" aria-label="Vista">
            {(['grid', 'list'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                aria-pressed={view === v}
                className={`rounded-[4px] px-2.5 py-1 text-xs transition-colors duration-100 ${
                  view === v ? 'bg-accent text-accent-fg font-medium' : 'text-muted hover:text-fg'
                }`}
              >
                {v === 'grid' ? 'Semana' : 'Lista'}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => downloadICS(courses, data?.term ?? null)}
            disabled={!courses.length}
            className="border-line hover:bg-surface-2 rounded-[var(--radius)] border px-2.5 py-1 text-xs transition-colors duration-100 disabled:opacity-40"
          >
            Exportar .ics
          </button>

          {/* Imprime lo que estás viendo (semana o lista): el papel no puede
              contradecir la pantalla desde la que apretaste el botón. */}
          <button
            type="button"
            onClick={() => window.print()}
            disabled={!courses.length}
            className="border-line hover:bg-surface-2 rounded-[var(--radius)] border px-2.5 py-1 text-xs transition-colors duration-100 disabled:opacity-40"
          >
            Imprimir
          </button>
        </div>
      </header>

      {sync.error && (
        <p className="text-closed text-sm">
          PeopleSoft no respondió al leer el horario ({sync.error.message}). Reintentar con "refrescar".
        </p>
      )}

      {isPending ? (
        <div className="border-line h-96 animate-pulse rounded-[var(--radius)] border" />
      ) : error ? (
        <p className="text-closed text-sm">No se pudo leer el horario guardado: {error.message}</p>
      ) : !courses.length ? (
        // Los vacíos invitan a la acción (regla de copy del sistema de diseño).
        <div className="border-line rounded-[var(--radius)] border border-dashed p-8 text-center">
          <p className="text-sm">Todavía no hay horario guardado.</p>
          <button
            type="button"
            onClick={() => sync.mutate()}
            disabled={sync.isPending}
            className="bg-accent text-accent-fg mt-3 rounded-[var(--radius)] px-3 py-2 text-sm font-medium disabled:opacity-50"
          >
            {sync.isPending ? 'Leyendo PeopleSoft…' : 'Traerlo de PeopleSoft'}
          </button>
        </div>
      ) : view === 'grid' ? (
        <WeeklyGrid blocks={toBlocks(courses)} />
      ) : (
        <Agenda data={data} />
      )}
    </div>
  );
}
