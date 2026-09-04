// El calendario académico oficial (P3). Es la única fuente del producto que no
// es PeopleSoft: páginas públicas de pucmm.edu.do, sin credenciales.
//
// El HTML de este test es sintético y mínimo — reproduce la forma real del
// JSON-LD observada en el recon, no una copia de la página. Ningún fixture
// contiene datos académicos de una persona.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-cal-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.MIKAMPUS_SILENT = '1';

const shared = await import('../src/shared/academicCalendar.ts');
const { parseCalendarEvents, dedupeEvents, upcomingEvents, normalizeOfficialDate, todayInSantoDomingo } = shared;
const calendar = await import('../src/academicCalendar.js');
const { db } = await import('../src/db.js');

const SOURCE = 'https://pucmm.edu.do/calendarios/calendario-academico/';

function page(events) {
  const blocks = events
    .map((event) => `<script type="application/ld+json">${JSON.stringify({ '@context': 'http://schema.org', '@type': 'Event', ...event })}</script>`)
    .join('\n');
  return `<!doctype html><html><head>${blocks}</head><body><h1>Calendario</h1></body></html>`;
}

try {
  // ── Fechas: PUCMM publica "2026-8-10", no ISO ────────────────────────────
  assert.equal(normalizeOfficialDate('2026-8-10'), '2026-08-10', 'se zero-padea el mes y el día');
  assert.equal(normalizeOfficialDate('2026-12-07'), '2026-12-07');
  assert.equal(normalizeOfficialDate('2026-8-10T00:00:00'), '2026-08-10', 'una hora pegada no rompe la fecha');
  assert.equal(normalizeOfficialDate('10/8/2026'), null, 'otro formato no se adivina');
  assert.equal(normalizeOfficialDate('2026-13-01'), null, 'un mes imposible es null, no diciembre+1');
  assert.equal(normalizeOfficialDate(undefined), null);

  // Una fecha sin hora no puede correrse de día por UTC. A las 21:00 de Santo
  // Domingo ya es el día siguiente en UTC: el calendario tiene que decir hoy.
  assert.equal(
    todayInSantoDomingo(new Date('2026-08-10T01:30:00Z')),
    '2026-08-09',
    'la 1:30 UTC todavía es el 9 en Santo Domingo'
  );
  assert.equal(todayInSantoDomingo(new Date('2026-08-10T04:00:00Z')), '2026-08-10');

  // ── Parseo del JSON-LD real ──────────────────────────────────────────────
  const html = page([
    { '@id': 'event_1577_0', name: 'Inicio de Ciclo 1930', startDate: '2026-8-17', endDate: '2026-8-17', url: 'https://pucmm.edu.do/events/inicio-1930/' },
    { '@id': 'event_1581_0', name: 'Primer pago de matrícula', startDate: '2026-8-25', endDate: '2026-8-26', url: '' },
    { '@id': 'event_5754_0', name: 'Período de preinscripción para el Ciclo 1940', startDate: '2026-11-11', endDate: '2026-11-13', url: null },
  ]);
  const parsed = parseCalendarEvents(html, { sourceUrl: SOURCE });
  assert.equal(parsed.length, 3);
  assert.deepEqual(
    parsed.map((event) => event.startsOn),
    ['2026-08-17', '2026-08-25', '2026-11-11'],
    'salen ordenados cronológicamente'
  );
  assert.equal(parsed[1].endsOn, '2026-08-26', 'un evento de varios días conserva su rango');
  assert.equal(parsed[0].url, 'https://pucmm.edu.do/events/inicio-1930/');
  assert.equal(parsed[1].url, null, 'una url vacía es null, no cadena vacía');
  assert.equal(parsed[0].sourceUrl, SOURCE, 'cada evento recuerda de qué página salió');

  // Un bloque roto no invalida la página entera.
  const conBasura = `<script type="application/ld+json">{ esto no es json </script>${html}`;
  assert.equal(parseCalendarEvents(conBasura, { sourceUrl: SOURCE }).length, 3, 'un bloque roto se salta');

  // Un evento sin nombre o sin fecha no entra: media fila es peor que ninguna.
  const incompletos = page([
    { '@id': 'a', name: '', startDate: '2026-8-17' },
    { '@id': 'b', name: 'Sin fecha' },
    { '@id': 'c', '@type': 'WebPage', name: 'No es evento', startDate: '2026-8-17' },
  ]);
  assert.equal(parseCalendarEvents(incompletos, { sourceUrl: SOURCE }).length, 0);

  // Un markup sin JSON-LD devuelve vacío: es la señal de que PUCMM cambió algo.
  assert.equal(parseCalendarEvents('<html><body>otra cosa</body></html>', { sourceUrl: SOURCE }).length, 0);

  // Un fin anterior al inicio se colapsa en vez de dibujarse al revés.
  const alReves = parseCalendarEvents(
    page([{ '@id': 'x', name: 'Dato malo', startDate: '2026-9-10', endDate: '2026-9-1' }]),
    { sourceUrl: SOURCE }
  );
  assert.equal(alReves[0].endsOn, '2026-09-10');

  // ── Dedupe: el caso real de "Último día de docencia" duplicado ───────────
  const duplicados = parseCalendarEvents(
    page([
      { '@id': 'event_1594_0', name: 'Último día de docencia', startDate: '2026-12-7', endDate: '2026-12-7' },
      { '@id': 'event_5770_0', name: 'Último día de docencia', startDate: '2026-12-7', endDate: '2026-12-7', url: 'https://pucmm.edu.do/events/ultimo-dia/' },
    ]),
    { sourceUrl: SOURCE }
  );
  assert.equal(duplicados.length, 1, 'mismo título y rango con @id distinto se colapsa');
  assert.equal(duplicados[0].url, 'https://pucmm.edu.do/events/ultimo-dia/', 'gana el que trae enlace');

  // El mismo @id repetido tampoco se duplica.
  assert.equal(dedupeEvents([...parsed, ...parsed]).length, 3);

  // Dos eventos con el mismo nombre en fechas distintas NO son el mismo.
  assert.equal(
    dedupeEvents([
      { id: '1', title: 'Pago de matrícula', startsOn: '2026-09-25', endsOn: '2026-09-25', url: null, sourceUrl: SOURCE },
      { id: '2', title: 'Pago de matrícula', startsOn: '2026-10-23', endsOn: '2026-10-23', url: null, sourceUrl: SOURCE },
    ]).length,
    2
  );

  // ── Próximas fechas ──────────────────────────────────────────────────────
  const proximas = upcomingEvents(parsed, { today: '2026-08-26', limit: 5 });
  assert.deepEqual(
    proximas.map((event) => event.title),
    ['Primer pago de matrícula', 'Período de preinscripción para el Ciclo 1940'],
    'un rango que todavía no termina sigue siendo próximo; el pasado no aparece'
  );
  assert.equal(upcomingEvents(parsed, { today: '2026-08-17' })[0].title, 'Inicio de Ciclo 1930', 'el evento de hoy cuenta');
  assert.equal(upcomingEvents(parsed, { today: '2027-01-01' }).length, 0, 'después de todo, nada');
  assert.equal(upcomingEvents(parsed, { today: '2026-01-01', limit: 2 }).length, 2, 'el límite se respeta');

  // ── El adaptador: caché, fallo parcial y fallo total ─────────────────────
  let restore = calendar.setCalendarFetcher(async () => html);
  const ok = await calendar.syncAcademicCalendar();
  restore();
  assert.equal(ok.saved, 3, 'guarda los eventos del calendario general');
  assert.deepEqual(ok.failures, []);

  const cached = calendar.readCalendar({ today: '2026-08-01', limit: 10 });
  assert.equal(cached.total, 3);
  assert.ok(cached.syncedAt, 'la caché sabe cuándo se llenó');
  assert.equal(cached.events[0].title, 'Inicio de Ciclo 1930', 'lo más próximo primero');

  // El calendario de preinscripción se enlaza, no se parsea: no publica datos
  // estructurados y sus horas son por facultad, no personales.
  assert.equal(calendar.CALENDAR_SOURCES.length, 1, 'una sola página se parsea');
  assert.match(calendar.PREINSCRIPTION_URL, /calendario-de-preinscripcion/);

  // Un evento nuevo entra sin borrar lo anterior.
  restore = calendar.setCalendarFetcher(async () =>
    page([{ '@id': 'event_nuevo', name: 'Fecha nueva', startDate: '2026-9-30', endDate: '2026-9-30' }])
  );
  await calendar.syncAcademicCalendar();
  restore();
  assert.ok(
    calendar.readCalendar({ today: '2026-01-01', limit: 20 }).events.some((event) => event.title === 'Fecha nueva'),
    'lo que respondió entró igual'
  );

  // Fallo total (offline, o markup cambiado): la caché anterior se conserva.
  const antes = calendar.readCalendar({ today: '2026-01-01', limit: 20 }).total;
  restore = calendar.setCalendarFetcher(async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  });
  await assert.rejects(() => calendar.syncAcademicCalendar(), /No se pudo leer el calendario/);
  restore();
  assert.equal(calendar.readCalendar({ today: '2026-01-01', limit: 20 }).total, antes, 'offline no vacía la caché');

  // Un cambio de markup (200 pero sin eventos) es fallo visible, no éxito mudo.
  restore = calendar.setCalendarFetcher(async () => '<html><body>rediseñamos el sitio</body></html>');
  await assert.rejects(() => calendar.syncAcademicCalendar(), /No se pudo leer el calendario/);
  restore();
  assert.equal(
    db.prepare("SELECT status FROM sync_log WHERE kind = 'academicCalendar' ORDER BY id DESC LIMIT 1").get().status,
    'error',
    'el fallo queda registrado para diagnostics'
  );

  // Re-sincronizar es idempotente: el mismo evento actualiza, no duplica.
  restore = calendar.setCalendarFetcher(async () => html);
  await calendar.syncAcademicCalendar();
  await calendar.syncAcademicCalendar();
  restore();
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM academic_calendar WHERE event_id = 'event_1577_0'").get().n,
    1,
    'el @id oficial es la clave: sincronizar dos veces no duplica'
  );

  console.log('✓ calendario académico: JSON-LD oficial, fechas sin correrse de día, dedupe real y caché que sobrevive al offline');
} finally {
  await rm(dir, { recursive: true, force: true });
}
