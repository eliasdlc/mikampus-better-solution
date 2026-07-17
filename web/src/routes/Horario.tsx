import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchMySchedule, syncMySchedule, fetchTermContext } from '../lib/api.ts';
import { WeeklyGrid } from '../components/WeeklyGrid.tsx';
import { CourseChip } from '../components/CourseChip.tsx';
import { StalenessTag } from '../components/StalenessTag.tsx';
import { TermBadge } from '../components/TermBadge.tsx';
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

  // El switcher lista todos los ciclos conocidos, del más reciente al más viejo:
  // el actual, el siguiente, y los pasados (que viven en el histórico de notas
  // aunque no tengan horario guardado). Elegir uno sin horario muestra el estado
  // vacío con la opción de traerlo del portal. `terms` viene cronológico
  // ascendente; se invierte para que el ciclo de hoy quede arriba.
  const termsQ = useQuery({ queryKey: ['term-context'], queryFn: fetchTermContext });
  const options = [...(termsQ.data?.terms ?? [])].reverse();

  // Por defecto, el ciclo actual. Su `term` sirve de valor aunque no tenga STRM
  // (entonces la query pide el default del server, que es también el actual).
  const defaultTerm = termsQ.data?.current?.term ?? termsQ.data?.next?.term ?? options[0]?.term ?? null;
  const [selectedTerm, setSelectedTerm] = useState<string | null>(null);
  useEffect(() => {
    if (selectedTerm == null && defaultTerm != null) setSelectedTerm(defaultTerm);
  }, [selectedTerm, defaultTerm]);

  const activeTerm = selectedTerm ?? defaultTerm;
  const activeOption = options.find((t) => t.term === activeTerm);
  const activeCode = activeOption?.code ?? null;

  const { data, isPending, error } = useQuery({
    queryKey: ['my-schedule', activeTerm],
    // Se pide SIEMPRE el ciclo que muestra el switcher, por su identificador: el
    // STRM si lo tiene, si no la etiqueta (`activeTerm` ya es code ?? label). Un
    // ciclo sin STRM (solo en notas, como el actual antes de sincronizarlo) no
    // matchea ningún enrollment y el server devuelve vacío — que es lo honesto.
    // Nunca se manda `undefined`: eso dejaba al server adivinar y servir otro
    // ciclo (el último sincronizado) bajo el badge del actual.
    queryFn: () => fetchMySchedule(activeTerm ?? undefined),
    enabled: activeTerm != null,
  });

  // El refresh es explícito y va en vivo contra PeopleSoft (tarda segundos).
  // Mientras corre, la pantalla sigue mostrando lo cacheado: nunca se bloquea.
  // El sync descubre el término real (con su STRM) y salta a mostrarlo.
  const sync = useMutation({
    // Refresca el ciclo que muestra el switcher, no el que el portal recuerde.
    // Sin STRM (arranque del ciclo actual) va sin término y el server descubre
    // el activo.
    mutationFn: () => syncMySchedule(activeCode ?? undefined),
    onSuccess: (fresh) => {
      if (fresh.term) {
        queryClient.setQueryData(['my-schedule', fresh.term], fresh);
        setSelectedTerm(fresh.term);
      }
      queryClient.invalidateQueries({ queryKey: ['term-context'] });
    },
  });

  const courses = data?.courses ?? [];
  const credits = courses.reduce((n, c) => n + (c.units ?? 0), 0);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-baseline gap-2">
            <h1 className="font-display text-2xl font-semibold tracking-tight">Mi horario</h1>
            {/* En el papel el ciclo sí va: un horario impreso sin decir de qué
                ciclo es no sirve de nada. */}
            <TermBadge label={activeOption?.label ?? null} />
          </div>
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
          {options.length > 1 && (
            <label className="text-muted flex items-center gap-1.5 text-xs">
              Ciclo
              <select
                value={activeTerm ?? ''}
                onChange={(e) => setSelectedTerm(e.target.value)}
                className="border-line bg-bg text-fg rounded-[var(--radius)] border px-2 py-1 text-xs"
              >
                {options.map((t) => (
                  <option key={t.term} value={t.term}>
                    {t.label ?? t.term}
                    {t.isCurrent ? ' · actual' : t.isNext ? ' · próximo' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}

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
        // El aviso nombra el ciclo: para el próximo dice que aún no inscribiste
        // nada; para el actual o uno pasado, que no hay horario guardado de él.
        <div className="border-line rounded-[var(--radius)] border border-dashed p-8 text-center">
          <p className="text-sm">
            {activeOption?.isNext
              ? `Aún no has inscrito materias para el próximo ciclo${activeOption.label ? ` (${activeOption.label})` : ''}.`
              : `No hay horario guardado${activeOption?.label ? ` de ${activeOption.label}` : ''}.`}
          </p>
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
