import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';
import { fetchAcademicCalendar } from '../lib/api.ts';
import { todayInSantoDomingo } from '../../../src/shared/academicCalendar.ts';
import { ago } from '../lib/time.ts';

// El calendario académico como una línea de tiempo: lo que pasó, lo que está
// pasando y lo que viene.
//
// Antes esto era solo "Próximas fechas" y el filtro que descartaba el pasado
// vivía en el shared, aplicado al leer. De cincuenta y siete fechas guardadas,
// catorce se tiraban en el servidor. El problema no era de datos: una lista de
// futuro no ubica a nadie. Ver que la modificación de inscripción cerró ayer es
// lo que explica por qué el carrito está en solo lectura hoy.
//
// Dos reglas de honestidad que se conservan. Primera: las fechas se formatean
// desde el texto YYYY-MM-DD, sin pasar por `new Date(iso)` — eso las
// interpretaría en UTC y en Santo Domingo (UTC-4) correría cada fecha un día
// hacia atrás. Segunda: si el último intento falló, se muestra la caché con su
// antigüedad; una fecha de hace una semana sirve más que una pantalla vacía.

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MONTHS_LONG = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

type CalendarEvent = { id: string; title: string; startsOn: string; endsOn: string; url: string | null };

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

function daysBetween(from: string, to: string) {
  const toUTC = (value: string) => {
    const { year, month, day } = parts(value);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((toUTC(to) - toUTC(from)) / 86_400_000);
}

function longToday(iso: string) {
  const { month, day } = parts(iso);
  return `Hoy · ${day} de ${MONTHS_LONG[month - 1] ?? '?'}`;
}

// Cuánto hace o cuánto falta, en la misma columna de la derecha para las tres
// zonas. Lo que ya pasó también lleva su distancia: "hace 2 días" es lo que
// convierte una fila apagada en una explicación.
function whenLabel(event: CalendarEvent, today: string): string | null {
  if (event.endsOn < today) {
    const days = daysBetween(event.endsOn, today);
    if (days === 0) return 'terminó hoy';
    return days === 1 ? 'ayer' : `hace ${days} días`;
  }
  if (event.startsOn <= today) return event.endsOn === today ? 'termina hoy' : 'en curso';
  const days = daysBetween(today, event.startsOn);
  if (days === 1) return 'mañana';
  return days <= 30 ? `en ${days} días` : null;
}

function Fila({ event, today, dim }: { event: CalendarEvent; today: string; dim?: boolean }) {
  const when = whenLabel(event, today);
  return (
    <li className={`flex items-baseline gap-3 px-4 py-2 ${dim ? 'opacity-45' : ''}`}>
      <span className="tabular text-muted w-24 shrink-0 font-mono text-xs">{rangeLabel(event.startsOn, event.endsOn)}</span>
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
}

export function UpcomingDates({ limit = 6, past = 3 }: { limit?: number; past?: number }) {
  const calendar = useQuery({
    queryKey: ['academic-calendar', limit, past],
    queryFn: () => fetchAcademicCalendar(limit, past),
  });
  const timeline = calendar.data?.timeline;
  const today = timeline?.today || todayInSantoDomingo();
  const vacio = Boolean(timeline) && !timeline!.past.length && !timeline!.current.length && !timeline!.future.length;

  return (
    <section className="border-line bg-surface rounded-[var(--radius)] border">
      <header className="border-line flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-2.5">
        <h2 className="text-sm font-medium">El calendario</h2>
        <span className="text-muted text-xs">
          {calendar.data?.syncedAt ? `PUCMM · ${ago(calendar.data.syncedAt)}` : 'calendario PUCMM'}
        </span>
      </header>

      {calendar.isPending ? (
        <p className="text-muted p-4 text-sm">Leyendo el calendario…</p>
      ) : !timeline || vacio ? (
        <p className="text-muted p-4 text-sm">
          {calendar.data?.total
            ? 'El calendario publicado no tiene fechas cerca de hoy.'
            : 'Todavía no se leyó el calendario académico.'}
        </p>
      ) : (
        <>
          {timeline.past.length > 0 && (
            <ul className="divide-line divide-y">
              {timeline.past.map((event) => (
                <Fila key={event.id} event={event} today={today} dim />
              ))}
            </ul>
          )}

          {/* El divisor se dibuja siempre, aunque hoy no tenga nada: "hoy no hay
              ninguna fecha" también es información, y sin la marca no se sabría
              dónde termina el pasado y empieza lo que viene. */}
          <div className="border-line flex items-center gap-3 border-y px-4 py-1.5">
            <span className="text-accent text-xs font-medium whitespace-nowrap">{longToday(today)}</span>
            <span className="bg-accent/40 h-px flex-1" aria-hidden />
          </div>

          {timeline.current.length > 0 ? (
            <ul className="divide-line border-accent divide-y border-l-2">
              {timeline.current.map((event) => (
                <Fila key={event.id} event={event} today={today} />
              ))}
            </ul>
          ) : (
            <p className="text-muted px-4 py-2 text-xs">Hoy no hay ninguna fecha del calendario.</p>
          )}

          {timeline.future.length > 0 && (
            <ul className="divide-line divide-y border-t">
              {timeline.future.map((event) => (
                <Fila key={event.id} event={event} today={today} />
              ))}
            </ul>
          )}

          <div className="border-line border-t px-4 py-2">
            <Link to="/ciclo" className="text-muted hover:text-fg text-xs underline underline-offset-2">
              En qué etapa está el ciclo
            </Link>
          </div>
        </>
      )}
    </section>
  );
}
