import type { ScheduleCourse } from '../../../src/shared/schemas.ts';
import type { DayCode } from '../../../src/shared/meetings.ts';

// Exporta el horario como .ics importable en Google Calendar. Se genera en el
// cliente: los datos ya están, no hace falta ni red ni una librería.
//
// Cada reunión es UN evento semanal recurrente (RRULE), no un evento por
// clase: es lo que hace que el calendario quede limpio y que la importación
// sea una sola entrada por materia.

// Los días de PeopleSoft (Mo/Tu…) coinciden en orden con los de iCalendar
// (MO/TU…), pero no en formato: RFC 5545 los quiere en mayúsculas.
const ICS_DAYS: Record<DayCode, string> = {
  Mo: 'MO',
  Tu: 'TU',
  We: 'WE',
  Th: 'TH',
  Fr: 'FR',
  Sa: 'SA',
  Su: 'SU',
};

const DAY_INDEX: Record<DayCode, number> = { Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 };

// RFC 5545 exige escapar coma, punto y coma, barra invertida y saltos de línea.
function escape(text: string): string {
  return text.replace(/([\\;,])/g, '\\$1').replace(/\n/g, '\\n');
}

const pad = (n: number) => String(n).padStart(2, '0');

function stamp(date: Date): string {
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

// Primera fecha en/después de `from` que caiga en `day`. El término empieza un
// día cualquiera, así que el DTSTART tiene que saltar al primer día de clase
// real; si no, la recurrencia arrancaría una semana antes o después.
function firstOccurrence(from: string, day: DayCode): Date {
  const [y, m, d] = from.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const shift = (DAY_INDEX[day] - date.getUTCDay() + 7) % 7;
  date.setUTCDate(date.getUTCDate() + shift);
  return date;
}

// Fecha local flotante (sin Z): la hora de la clase es 10:00 en Santo Domingo,
// no 10:00 UTC. Sin zona, el calendario la interpreta en la del usuario, que es
// justamente lo que queremos para un horario local.
function localStamp(date: Date, hhmm: string): string {
  const [h, min] = hhmm.split(':');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${h}${min}00`;
}

export function scheduleToICS(courses: ScheduleCourse[], term: string | null): string {
  const now = stamp(new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//mikampus//Horario//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escape(`Horario${term ? ` ${term}` : ''}`)}`,
  ];

  for (const course of courses) {
    for (const section of course.sections) {
      for (const [mi, meeting] of section.meetings.entries()) {
        if (!meeting.start || !meeting.end || !meeting.days.length) continue;
        // Sin fechas de término no se puede acotar la recurrencia: mejor no
        // exportar ese evento que exportar uno infinito.
        if (!section.startDate || !section.endDate) continue;

        const day = meeting.days[0] as DayCode;
        const first = firstOccurrence(section.startDate, day);
        const [ey, em, ed] = section.endDate.split('-').map(Number);
        const until = stamp(new Date(Date.UTC(ey, em - 1, ed, 23, 59, 59)));

        lines.push(
          'BEGIN:VEVENT',
          `UID:${section.classNbr}-${mi}-${day}-${term ?? 'x'}@mikampus`,
          `DTSTAMP:${now}`,
          `DTSTART:${localStamp(first, meeting.start)}`,
          `DTEND:${localStamp(first, meeting.end)}`,
          `RRULE:FREQ=WEEKLY;BYDAY=${meeting.days.map((d) => ICS_DAYS[d as DayCode]).join(',')};UNTIL=${until}`,
          `SUMMARY:${escape(course.title)}`,
          `DESCRIPTION:${escape(
            [
              `${course.code} · Clase ${section.classNbr}`,
              section.section ? `Sección ${section.section}${section.component ? ` (${section.component})` : ''}` : null,
              section.instructor,
              course.units ? `${course.units} créditos` : null,
            ]
              .filter(Boolean)
              .join('\n')
          )}`,
          ...(meeting.room ? [`LOCATION:${escape(meeting.room)}`] : []),
          'END:VEVENT'
        );
      }
    }
  }

  lines.push('END:VCALENDAR');
  // RFC 5545 pide CRLF.
  return lines.join('\r\n') + '\r\n';
}

export function downloadICS(courses: ScheduleCourse[], term: string | null) {
  const blob = new Blob([scheduleToICS(courses, term)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `horario-${term ?? 'mikampus'}.ics`;
  a.click();
  URL.revokeObjectURL(url);
}
