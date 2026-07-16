import type { Meeting } from './schemas.ts';

// Traduce el formato de horario de PeopleSoft ("Mo 10:00AM - 1:00PM") a datos
// que el WeeklyGrid pueda posicionar sin volver a parsear en el cliente.
//
// Los días se guardan con el código de dos letras del portal (Mo/Tu/We…), no
// traducidos: es el dato tal como sale de la fuente, estable y sin ambigüedad
// ("Mi" sería miércoles pero "Ma" es martes o marzo según quién lo lea). La
// traducción a español es cosa de la UI, no del dato — ver DAY_LABELS.

export const DAY_CODES = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const;
export type DayCode = (typeof DAY_CODES)[number];

export const DAY_LABELS: Record<DayCode, string> = {
  Mo: 'Lun',
  Tu: 'Mar',
  We: 'Mié',
  Th: 'Jue',
  Fr: 'Vie',
  Sa: 'Sáb',
  Su: 'Dom',
};

// La semana académica de PUCMM: no hay clases el domingo, así que el grid llega
// hasta el sábado. Si alguna vez aparece una sección en domingo, el parser la
// devuelve igual y es la UI la que decide si mostrarla.
export const WEEK_DAYS: DayCode[] = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

const TIME_RE = /^(\d{1,2}):(\d{2})\s*([AP])M$/i;

// "1:00PM" → "13:00". Devuelve null si no matchea (el portal escribe "TBA" y
// otras variantes cuando el horario no está definido).
export function parseTime(raw: string): string | null {
  const m = raw.trim().match(TIME_RE);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const isPM = m[3].toUpperCase() === 'P';
  // 12AM es medianoche y 12PM es mediodía: el 12 es el caso que rompe la
  // regla de "+12 si es PM".
  if (hour === 12) hour = isPM ? 12 : 0;
  else if (isPM) hour += 12;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// "MoWe" → ["Mo", "We"]. El portal concatena los días sin separador.
export function parseDays(raw: string): DayCode[] {
  const days: DayCode[] = [];
  for (const code of raw.match(/[A-Z][a-z]/g) ?? []) {
    if ((DAY_CODES as readonly string[]).includes(code)) days.push(code as DayCode);
  }
  return days;
}

// Parsea una celda "Days & Times" completa. El portal puede meter varios
// patrones en una misma celda separados por salto de línea (una sección que se
// reúne en horarios distintos según el día).
export function parseMeetings(rawDayTime: string, room: string | null = null): Meeting[] {
  const cell = (rawDayTime ?? '').replace(/ /g, ' ').trim();
  if (!cell || /^TBA$/i.test(cell)) return [];

  const meetings: Meeting[] = [];
  for (const line of cell.split(/\n+/)) {
    const m = line.trim().match(/^([A-Za-z]+)\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)$/i);
    if (!m) continue;
    const days = parseDays(m[1]);
    const start = parseTime(m[2]);
    const end = parseTime(m[3]);
    if (!days.length || !start || !end) continue;
    meetings.push({ days, start, end, room: room && !/^TBA$/i.test(room) ? room : null });
  }
  return meetings;
}

// El class search escribe el componente abreviado ("101-LEC") y Mi Horario lo
// escribe completo ("Lecture"). Las dos fuentes escriben la MISMA sección
// (mismo class_nbr), así que sin normalizar se pisarían entre sí en cada sync.
const COMPONENTS: Record<string, string> = {
  lecture: 'LEC',
  lec: 'LEC',
  practicum: 'PRA',
  pra: 'PRA',
  laboratory: 'LAB',
  lab: 'LAB',
  seminar: 'SEM',
  sem: 'SEM',
};

export function normalizeComponent(raw: string | null | undefined): string | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  return COMPONENTS[t.toLowerCase()] ?? t.slice(0, 3).toUpperCase();
}

// "09/01/2026 - 12/07/2026" → { start: "2026-09-01", end: "2026-12-07" }.
// El portal corre en inglés (languageCd=ENG), así que las fechas son
// MM/DD/YYYY. El ICS las necesita para acotar la recurrencia semanal.
export function parseDateRange(raw: string | null | undefined): { start: string | null; end: string | null } {
  const m = (raw ?? '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return { start: null, end: null };
  return {
    start: `${m[3]}-${m[1]}-${m[2]}`,
    end: `${m[6]}-${m[4]}-${m[5]}`,
  };
}

// Minutos desde medianoche — el WeeklyGrid posiciona bloques con esto.
export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Dos reuniones chocan si comparten día y se solapan en el tiempo. Bordes
// tocándose (una termina 10:00 y la otra empieza 10:00) no es choque.
export function meetingsOverlap(a: Meeting, b: Meeting): boolean {
  if (!a.start || !a.end || !b.start || !b.end) return false;
  if (!a.days.some((d) => b.days.includes(d))) return false;
  return toMinutes(a.start) < toMinutes(b.end) && toMinutes(b.start) < toMinutes(a.end);
}
