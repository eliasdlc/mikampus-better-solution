// El carril de lectura del MCP contra una base sembrada: que el sobre diga la
// verdad (freshness, warnings, unknown), que no invente lo que el portal no
// publica, y que nada identificatorio salga por ninguna herramienta.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-mcp-read-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.MIKAMPUS_DATA_DIR = dir;

const { db } = await import('../src/db.js');

db.exec("INSERT OR IGNORE INTO users (id, portal_username) VALUES (1, 'elias.delacruz')");
db.exec("INSERT INTO profile (user_id, career, pensum_no, cohort_start_term) VALUES (1, 'ICC', '2020', 'Septiembre de 2023')");
db.exec("INSERT INTO terms (code, label, start_date, end_date) VALUES ('1930', 'Septiembre de 2026', '2026-09-01', '2026-12-07')");

const lec = JSON.stringify([{ days: ['Sa'], start: '10:00', end: '13:00', room: 'A-101' }]);
const pra = JSON.stringify([{ days: ['Th'], start: '18:00', end: '21:00', room: 'LAB-2' }]);

const seg = db.prepare("INSERT INTO courses (code, subject, catalog_nbr, title, credits) VALUES ('ICC-233','ICC','233','Seg. en Tecnologia Informacion', 4) RETURNING id").get().id;
const compi = db.prepare("INSERT INTO courses (code, subject, catalog_nbr, title, credits) VALUES ('ICC-321','ICC','321','Compiladores', 4) RETURNING id").get().id;

const segLec = db.prepare("INSERT INTO sections (course_id, term, class_nbr, section, component, meetings) VALUES (?, '1930', '4567', '101', 'LEC', ?) RETURNING id").get(seg, lec).id;
const segPra = db.prepare("INSERT INTO sections (course_id, term, class_nbr, section, component, meetings) VALUES (?, '1930', '4568', '171', 'PRA', ?) RETURNING id").get(seg, pra).id;
db.prepare("INSERT INTO sections (course_id, term, class_nbr, section, component, meetings) VALUES (?, '1930', '4600', '101', 'LEC', ?)").run(compi, pra);

for (const sectionId of [segLec, segPra]) {
  db.prepare("INSERT INTO enrollments (user_id, term, course_id, section_id, status, units, start_date, end_date) VALUES (1, '1930', ?, ?, 'enrolled', 4, '2026-09-01', '2026-12-07')").run(seg, sectionId);
}

db.prepare("INSERT INTO grades (user_id, term, course_code, subject, grade, credits, status) VALUES (1, 'Enero de 2026', 'ICC-303', 'ICC', 'B', 4, 'taken')").run();
db.prepare("INSERT INTO enrollment_windows (term_code, session, starts_at, ends_at, precision, user_id) VALUES ('1930', 'Regular Academic Session', '2026-07-16', '2026-09-03', 'date', 1)").run();
db.prepare("INSERT INTO cart_rows (user_id, idx, class_label, course_code, title, section, class_nbr, campus, status) VALUES (1, 0, 'ICC-451-101', 'ICC-451', 'Sistemas Operativos', '101', '4700', 'Campus Santiago', 'closed')").run();
db.prepare("INSERT INTO sync_log (user_id, kind, status, finished_at) VALUES (1, 'mySchedule', 'ok', ?)").run(new Date('2026-09-01T09:00:00Z').toISOString());

const { READ_TOOLS } = await import('../src/mcp/tools.js');
const tool = (name) => READ_TOOLS.find((entry) => entry.name === name);
const now = new Date('2026-09-01T10:00:00');

try {
  // ── El sobre ────────────────────────────────────────────────────────────
  const overview = tool('get_overview').run({ now });
  assert.equal(overview.payload.data.enrolled.length, 1, 'una sola materia inscrita');
  assert.equal(overview.payload.data.enrolledCredits, 4);
  assert.equal(overview.payload.data.account.hasAccount, true);
  assert.equal(overview.payload.data.profile.career, 'ICC');

  const grades = overview.payload.freshness.find((item) => item.kind === 'grades');
  assert.equal(grades.neverSynced, true, 'notas nunca sincronizadas se distingue de notas vacías');
  const mySchedule = overview.payload.freshness.find((item) => item.kind === 'mySchedule');
  assert.equal(mySchedule.neverSynced, false);
  assert.equal(mySchedule.stale, false, 'una hora de antigüedad todavía no es viejo para el horario');

  // ── Ninguna herramienta filtra identidad ────────────────────────────────
  for (const entry of READ_TOOLS) {
    const { sanitize } = await import('../src/mcp/redact.js');
    const serialized = JSON.stringify(sanitize(entry.run({ now }).payload));
    assert.ok(!serialized.includes('elias.delacruz'), `${entry.name} no expone el username del portal`);
    assert.ok(!serialized.includes('portal_username'), `${entry.name} no expone la columna del username`);
  }

  // ── Lo que el portal no publica sale nombrado, no estimado ──────────────
  const cycle = tool('get_cycle').run({ now });
  assert.equal(cycle.payload.data.phase.open.includes('inscripcion-regular'), true, 'la inscripción está abierta hoy');
  const unknownKinds = cycle.payload.unknown.map((item) => item.kind);
  for (const missing of ['modificacion-inscripcion', 'retiro-parcial', 'retiro-total', 'notas']) {
    assert.ok(unknownKinds.includes(missing), `${missing} sale como ausencia explícita`);
  }
  assert.match(cycle.payload.unknown[0].reason, /calendario académico/, 'la ausencia dice por qué');

  // ── Horario expandido a fechas reales ───────────────────────────────────
  const schedule = tool('get_schedule').run({ now });
  const dates = schedule.payload.data.blocks.map((block) => `${block.date} ${block.start}`);
  assert.deepEqual(dates, ['2026-09-03 18:00', '2026-09-05 10:00'], 'jueves y sábado dentro de la semana');
  assert.equal(schedule.payload.data.nextClass.courseCode, 'ICC-233');

  // ── Catálogo: el campus no se deduce del número de sección ──────────────
  const found = tool('find_courses').run({ now, term: '1930' });
  const sections = found.payload.data.courses.flatMap((course) => course.sections);
  assert.ok(sections.length > 0);
  for (const section of sections) {
    assert.equal(section.campus, null, 'sin dato del portal, el campus es null');
    assert.equal(section.campusKnown, false, 'y se dice explícitamente que no se sabe');
  }
  const compiladores = found.payload.data.courses.find((course) => course.code === 'ICC-321');
  assert.deepEqual(compiladores.sections[0].conflictsWith, ['ICC-233'], 'el choque con lo inscrito se calcula acá');

  const soloLibres = tool('find_courses').run({ now, term: '1930', fitsSchedule: true });
  assert.ok(
    !soloLibres.payload.data.courses.some((course) => course.code === 'ICC-321'),
    'fitsSchedule descarta la sección que choca'
  );

  // ── El carrito cerrado frena ────────────────────────────────────────────
  const blockers = tool('get_blockers').run({ now });
  const kinds = blockers.payload.data.blockers.map((item) => item.kind);
  assert.ok(kinds.includes('cart_has_closed_sections'), 'una sección cerrada en el carrito es un freno');
  assert.ok(kinds.includes('enrollment_window_closing'), 'la ventana que cierra en dos días es un freno');
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ MCP lectura: sobre con freshness y ausencias explícitas, campus sin deducir, sin identidad filtrada');
