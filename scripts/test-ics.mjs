// Verifica el .ics contra el horario real del recon. Lo que más se rompe acá
// es el DTSTART: el término empieza el 01/09/2026 (martes) pero la clase es
// sábado, así que la primera ocurrencia NO es el día que arranca el término.
import assert from 'node:assert/strict';
import { scheduleToICS } from '../web/src/lib/ics.ts';

// Caso de regresión de ICC-233: el término inicia martes y la clase es sábado.
const courses = [
  {
    id: 1,
    code: 'ICC-233',
    subject: 'ICC',
    catalogNbr: '233',
    title: 'Seg. en Tecnología Información',
    status: 'enrolled',
    units: 4,
    grading: 'Calificación Ordinaria',
    grade: null,
    sections: [
      {
        id: 10,
        classNbr: '5225',
        section: '101',
        component: 'LEC',
        instructor: 'Rafael Miguel Dorville Collado',
        startDate: '2026-09-01',
        endDate: '2026-12-07',
        meetings: [{ days: ['Sa'], start: '10:00', end: '13:00', room: 'A-201' }],
      },
    ],
  },
];

const ics = scheduleToICS(courses, '1930');
const line = (prefix) => ics.split('\r\n').find((l) => l.startsWith(prefix));

assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'), 'cabecera VCALENDAR');
assert.ok(ics.endsWith('END:VCALENDAR\r\n'), 'cierre VCALENDAR');
assert.ok(ics.includes('\r\n'), 'RFC 5545 pide CRLF');

// El término arranca el martes 01/09/2026, pero la clase es sábado: el primer
// sábado en/después de esa fecha es el 05/09/2026. Si esto dijera 20260901,
// el calendario mostraría la clase el día equivocado toda la recurrencia.
assert.equal(line('DTSTART:'), 'DTSTART:20260905T100000', 'salta al primer sábado del término');
assert.equal(line('DTEND:'), 'DTEND:20260905T130000');

// Sin Z ni zona: hora flotante. 10:00 es 10:00 en Santo Domingo, no en UTC.
assert.ok(!line('DTSTART:').endsWith('Z'), 'la hora de clase es local, no UTC');

assert.equal(line('RRULE:'), 'RRULE:FREQ=WEEKLY;BYDAY=SA;UNTIL=20261207T235959Z', 'recurre hasta el fin del término');
assert.equal(line('SUMMARY:'), 'SUMMARY:Seg. en Tecnología Información', 'el nombre real, no el código');
assert.equal(line('LOCATION:'), 'LOCATION:A-201');
assert.ok(line('DESCRIPTION:').includes('ICC-233 · Clase 5225'));
assert.ok(line('DESCRIPTION:').includes('4 créditos'));
assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 1, 'un evento recurrente, no uno por clase');

// Una reunión MoWe es un solo evento con dos BYDAY.
{
  const multi = structuredClone(courses);
  multi[0].sections[0].meetings = [{ days: ['Mo', 'We'], start: '10:00', end: '13:00', room: null }];
  const out = scheduleToICS(multi, '1930');
  assert.equal((out.match(/BEGIN:VEVENT/g) ?? []).length, 1, 'MoWe es un evento, no dos');
  assert.ok(out.includes('BYDAY=MO,WE'));
  // 01/09/2026 es martes → el primer lunes es el 07/09.
  assert.ok(out.includes('DTSTART:20260907T100000'), 'primera ocurrencia = primer lunes');
}

// Una sección sin horario (TBA) o sin fechas no puede exportarse: un evento sin
// UNTIL recurriría para siempre en el calendario del usuario.
{
  const tba = structuredClone(courses);
  tba[0].sections[0].meetings = [{ days: ['Sa'], start: null, end: null, room: null }];
  assert.equal((scheduleToICS(tba, '1930').match(/BEGIN:VEVENT/g) ?? []).length, 0, 'TBA no genera evento');

  const noDates = structuredClone(courses);
  noDates[0].sections[0].startDate = null;
  noDates[0].sections[0].endDate = null;
  assert.equal((scheduleToICS(noDates, '1930').match(/BEGIN:VEVENT/g) ?? []).length, 0, 'sin fechas no hay evento');
}

// Los caracteres que RFC 5545 reserva se escapan.
{
  const tricky = structuredClone(courses);
  tricky[0].title = 'Cálculo I, II; avanzado';
  const out = scheduleToICS(tricky, '1930');
  assert.ok(out.includes('SUMMARY:Cálculo I\\, II\\; avanzado'), 'coma y punto y coma escapados');
}

console.log('✓ Export ICS OK (primera ocurrencia, recurrencia, escapes, TBA).');
