// El alcance del watcher: qué te interrumpe y qué no.
//
// Son dos hechos distintos del portal y se confunden fácil, así que la prueba
// los hace ocurrir EN EL MISMO tick para que ninguno pueda pasar por el otro:
// se abre un asiento en la sección que la persona ya eligió y, a la vez,
// aparece un NRC que antes no existía. Cada usuario tiene un alcance distinto y
// debe recibir exactamente lo suyo.
//
// Lo que protege: que acotar el alcance de verdad silencie, y que no silencie
// de más. Un watcher que igual te notifica todo no sirve; uno que se calla lo
// que pediste te cuesta el cupo.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-watcher-scope-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.MIKAMPUS_CRED_DB = path.join(dir, 'credentials.db');
process.env.MIKAMPUS_CRED_KEY = crypto.randomBytes(32).toString('hex');
process.env.MIKAMPUS_BACKUP_DIR = path.join(dir, 'backups');
process.env.MIKAMPUS_RUNTIME_DIR = path.join(dir, 'runtime');
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(dir, 'browsers');
process.env.MIKAMPUS_SILENT = '1';
process.env.SYNC_TERM = '1930';

const { db } = await import('../src/db.js');
const { storeCredential } = await import('../src/credentialVault.js');
const { saveSection } = await import('../src/peoplesoft/catalog.js');
const { scrapedSectionSchema } = await import('../src/shared/schemas.ts');
const scheduler = await import('../src/scheduler.js');

const section = (courseCode, classNbr, status) => {
  const [subject, catalogNbr] = courseCode.split('-', 2);
  return scrapedSectionSchema.parse({
    courseCode,
    subject,
    catalogNbr,
    title: courseCode,
    career: 'GRDO',
    term: '1930',
    classNbr,
    section: `0${classNbr}`,
    component: 'LEC',
    meetings: [],
    seats: { status, open: status === 'open' ? 1 : 0, capacity: 30, waitTotal: 0 },
  });
};

const addCart = (userId, courseCode, classNbr) => {
  db.prepare(
    `INSERT INTO cart_rows (user_id, idx, class_label, course_code, title, class_nbr, status)
     VALUES (?, 0, ?, ?, ?, ?, 'closed')`
  ).run(userId, `${courseCode} (${classNbr})`, courseCode, courseCode, classNbr);
};

const events = [];
const unsubscribe = scheduler.onEvent((event) => events.push(event));

const noticesFor = (userId, pattern) =>
  events.filter((event) => event.type === 'notice' && event.userId === userId && pattern.test(event.title));

try {
  // ── El default no cambia el comportamiento de una base existente. ──
  assert.equal(scheduler.DEFAULT_WATCHER_SCOPE, 'both', 'por defecto vigila las dos cosas, como antes de poder elegir');
  db.exec('INSERT INTO watchers (user_id, interval_ms) VALUES (99, 45000)');
  assert.equal(
    db.prepare('SELECT scope FROM watchers WHERE user_id = 99').get().scope,
    'both',
    'una fila escrita sin alcance —como las que ya existen en disco— queda en "both"'
  );
  db.exec('DELETE FROM watchers WHERE user_id = 99');

  // ── Auto-inscribir vigilando solo grupos nuevos no significa nada. ──
  assert.throws(
    () => scheduler.startWatcher(1, { autoEnroll: true, scope: 'groups' }),
    /auto-inscripción necesita vigilar el cupo/i,
    'se rechaza en vez de aceptarse y no cumplirse en silencio'
  );
  assert.throws(() => scheduler.startWatcher(1, { scope: 'inventado' }), /desconocido/i, 'un alcance inventado no pasa');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM watchers').get().n, 0, 'un rechazo no deja el watcher a medio encender');

  // ── El escenario: mismo tick, los dos hechos a la vez. ──
  saveSection(section('ICC-321', '1000', 'closed'));
  for (const userId of [1, 2, 3]) addCart(userId, 'ICC-321', '1000');
  db.exec(`
    INSERT INTO watchers (user_id, interval_ms, scope) VALUES
      (1, 45000, 'seats'),
      (2, 45000, 'groups'),
      (3, 45000, 'both');
  `);
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  for (const userId of [1, 2, 3]) {
    storeCredential(userId, { username: `operator-${userId}`, password: 'test-only' }, { expiresAt, reason: 'scope test' });
  }

  const restoreScanner = scheduler.setSharedWatcherScanner(async () => {
    saveSection(section('ICC-321', '1000', 'open')); // se liberó TU asiento
    saveSection(section('ICC-321', '1001', 'open')); // y abrió un grupo nuevo
  });
  try {
    await scheduler.runSharedWatcherTick();
  } finally {
    restoreScanner();
  }

  // Una sola consulta al portal sirvió a los tres: el alcance filtra a quién se
  // le habla, no cuánto se scrapea. Es la propiedad que hace que elegir alcance
  // sea gratis para el portal.
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM seats_snapshot ss JOIN sections s ON s.id = ss.section_id WHERE s.class_nbr = '1001'`).get().n,
    1,
    'el grupo nuevo se registró una sola vez pese a tres watchers'
  );

  assert.equal(noticesFor(1, /Apareció cupo/).length, 1, 'seats: recibe el cupo de su sección');
  assert.equal(noticesFor(1, /grupo nuevo/).length, 0, 'seats: NO recibe el grupo nuevo');

  assert.equal(noticesFor(2, /grupo nuevo/).length, 1, 'groups: recibe el grupo nuevo');
  assert.equal(noticesFor(2, /Apareció cupo/).length, 0, 'groups: NO recibe el cupo de su sección');

  assert.equal(noticesFor(3, /Apareció cupo/).length, 1, 'both: recibe el cupo');
  assert.equal(noticesFor(3, /grupo nuevo/).length, 1, 'both: y también el grupo nuevo');

  console.log('✓ alcance del watcher: cupos y grupos nuevos se filtran por usuario sin duplicar consultas al portal');
} finally {
  unsubscribe();
  scheduler.stopWatcher(1);
  scheduler.stopWatcher(2);
  scheduler.stopWatcher(3);
  await rm(dir, { recursive: true, force: true });
}
