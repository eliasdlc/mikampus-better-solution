import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { fetchAcademicCalendar } from '../lib/api.ts';
import { todayInSantoDomingo } from '../../../src/shared/academicCalendar.ts';
import { ago } from '../lib/time.ts';

// Las próximas fechas institucionales (P3). Salen del calendario oficial de
// PUCMM, no de PeopleSoft: son públicas y las ve cualquiera.
//
// Dos reglas de honestidad. Primera: las fechas se formatean desde el texto
// YYYY-MM-DD, sin pasar por `new Date(iso)` — eso las interpretaría en UTC y en
// Santo Domingo (UTC-4) correría cada fecha un día hacia atrás. Segunda: si el
// último intento falló, se muestra la caché con su antigüedad; una fecha de
// hace una semana sirve más que una pantalla vacía.

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function parts(iso: string) {
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month, day };
}

function shortDate(iso: string) {
  const { month, day } = parts(iso);
  return `${day} ${MONTHS[month - 1] ?? '?'}`;
}

function rangeLabel(startsOn: string, endsOn: string) {
  if (startsOn === endsOn) return shortDate(startsOn);
  const a = parts(startsOn);
  const b = parts(endsOn);
  // "11–13 nov" cuando es el mismo mes; "30 nov – 2 dic" cuando cruza.
  return a.month === b.month ? `${a.day}–${b.day} ${MONTHS[a.month - 1]}` : `${shortDate(startsOn)} – ${shortDate(endsOn)}`;
}

function daysUntil(iso: string, today: string) {
  const toUTC = (value: string) => {
    const { year, month, day } = parts(value);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((toUTC(iso) - toUTC(today)) / 86_400_000);
}

function whenLabel(startsOn: string, endsOn: string, today: string) {
  if (startsOn <= today && endsOn >= today) return 'hoy';
  const days = daysUntil(startsOn, today);
  if (days === 1) return 'mañana';
  if (days <= 7) return `en ${days} días`;
  return null;
}

export function UpcomingDates({ limit = 4 }: { limit?: number }) {
  const calendar = useQuery({ queryKey: ['academic-calendar'], queryFn: () => fetchAcademicCalendar(limit) });
  const today = todayInSantoDomingo();
  const events = calendar.data?.events ?? [];

  return (
    <section className="border-line bg-surface rounded-[var(--radius)] border">
      <header className="border-line flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-2.5">
        <h2 className="text-sm font-medium">Próximas fechas</h2>
        <span className="text-muted text-xs">
          {calendar.data?.syncedAt ? `calendario PUCMM · ${ago(calendar.data.syncedAt)}` : 'calendario PUCMM'}
        </span>
      </header>

      {calendar.isPending ? (
        <p className="text-muted p-4 text-sm">Leyendo el calendario…</p>
      ) : events.length === 0 ? (
        <p className="text-muted p-4 text-sm">
          {calendar.data?.total
            ? 'No quedan fechas próximas en el calendario publicado.'
            : 'Todavía no se leyó el calendario académico.'}
        </p>
      ) : (
        <ul className="divide-line divide-y">
          {events.map((event) => {
            const when = whenLabel(event.startsOn, event.endsOn, today);
            return (
              <li key={event.id} className="flex items-baseline gap-3 px-4 py-2.5">
                <span className="tabular text-muted w-20 shrink-0 font-mono text-xs">
                  {rangeLabel(event.startsOn, event.endsOn)}
                </span>
                <span className="min-w-0 flex-1">
                  {event.url ? (
                    <a
                      href={event.url}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:text-accent inline-flex items-start gap-1 text-sm underline-offset-2 hover:underline"
                    >
                      <span className="min-w-0">{event.title}</span>
                      <ExternalLink className="mt-0.5 size-3 shrink-0 opacity-60" aria-hidden />
                    </a>
                  ) : (
                    <span className="text-sm">{event.title}</span>
                  )}
                </span>
                {when && <span className="text-muted shrink-0 text-xs whitespace-nowrap">{when}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
