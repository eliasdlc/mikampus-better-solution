// El gancho de Kino: la forma con la que un gestor de tareas puede crear
// recordatorios sin inventar una hora que el portal nunca publicó.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-mcp-kino-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.MIKAMPUS_DATA_DIR = dir;

const { db } = await import('../src/db.js');

db.exec("INSERT OR IGNORE INTO users (id) VALUES (1)");
db.exec("INSERT INTO terms (code, label, start_date, end_date) VALUES ('1930', 'Septiembre de 2026', '2026-09-01', '2026-12-07')");
const meetings = JSON.stringify([{ days: ['Th'], start: '18:00', end: '21:00', room: 'LAB-2' }]);
const course = db.prepare("INSERT INTO courses (code, subject, catalog_nbr, title, credits) VALUES ('ICC-233','ICC','233','Seg. en Tecnologia Informacion', 4) RETURNING id").get().id;
const section = db.prepare("INSERT INTO sections (course_id, term, class_nbr, section, component, meetings) VALUES (?, '1930', '4568', '171', 'PRA', ?) RETURNING id").get(course, meetings).id;
db.prepare("INSERT INTO enrollments (user_id, term, course_id, section_id, status, units, start_date, end_date) VALUES (1, '1930', ?, ?, 'enrolled', 4, '2026-09-01', '2026-12-07')").run(course, section);
db.prepare("INSERT INTO enrollment_windows (term_code, session, starts_at, ends_at, precision, user_id) VALUES ('1930', 'Regular Academic Session', '2026-07-16', '2026-09-03', 'date', 1)").run();

const { getBlockers, getUpcoming } = await import('../src/mcp/kino.js');
const { blockersEnvelopeSchema, upcomingEnvelopeSchema } = await import('../src/shared/mcp.ts');
const { READ_TOOLS } = await import('../src/mcp/tools.js');
const now = new Date('2026-09-01T10:00:00');

try {
  const first = getUpcoming({ horizonDays: 14, now });
  const second = getUpcoming({ horizonDays: 14, now });

  // El id es la llave de dedupe de Kino: si cambiara entre corridas, cada poll
  // duplicaría tareas.
  assert.deepEqual(first.items.map((item) => item.id), second.items.map((item) => item.id), 'los ids son estables');
  assert.equal(first.revision, second.revision, 'la revisión no cambia si el conjunto no cambió');

  const close = first.items.find((item) => item.kind === 'enrollment_window_close');
  assert.ok(close, 'el cierre de la ventana entra en el horizonte');
  assert.equal(close.id, 'window:1930:close', 'el id es determinístico');
  assert.equal(close.precision, 'date', 'el portal publicó fecha sin hora');
  assert.equal(close.allDay, true, 'y por eso no se puede poner un recordatorio a hora fija encima');
  assert.equal(close.certainty, 'published');
  assert.equal(close.blocking, true, 'cierra en dos días, así que además frena');

  const clase = first.items.find((item) => item.kind === 'class');
  assert.ok(clase, 'las clases entran en el horizonte');
  assert.equal(clase.allDay, false, 'una clase sí tiene hora publicada');
  assert.equal(clase.id, 'class:1930:ICC-233:171:2026-09-03');
  assert.equal(clase.startsAt, '2026-09-03T18:00:00');

  const termEnd = first.items.find((item) => item.kind === 'term_end');
  assert.equal(termEnd, undefined, 'el fin del ciclo está fuera de un horizonte de 14 días');

  // Las dos herramientas que Kino llama validan contra su contrato publicado.
  const upcomingTool = READ_TOOLS.find((tool) => tool.name === 'get_upcoming');
  const blockersTool = READ_TOOLS.find((tool) => tool.name === 'get_blockers');
  upcomingEnvelopeSchema.parse(upcomingTool.run({ now }).payload);
  blockersEnvelopeSchema.parse(blockersTool.run({ now }).payload);

  const blockers = getBlockers({ now });
  const closing = blockers.find((item) => item.kind === 'enrollment_window_closing');
  assert.equal(closing.severity, 'alta');
  assert.ok(blockers.every((item) => item.title && item.detail), 'todo freno explica qué es');
  assert.deepEqual(
    [...blockers].sort((a, b) => ({ alta: 0, media: 1, baja: 2 })[a.severity] - ({ alta: 0, media: 1, baja: 2 })[b.severity]),
    blockers,
    'la lista viene rankeada por severidad'
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ MCP para Kino: ids estables, revisión reproducible, allDay honesto y contratos validados');
