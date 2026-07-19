// El scheduler persistido contra una DB desechable: el disparo y el watcher
// viven en tablas (no solo en memoria), la restauración al arrancar rearma lo
// vigente y avisa de lo que se perdió, y el action_log guarda la respuesta
// literal del portal. No toca PeopleSoft: lo que se prueba es la persistencia.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-sched-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.MIKAMPUS_SILENT = '1';

const { db, logAction, readActions } = await import('../src/db.js');
const scheduler = await import('../src/scheduler.js');

const events = [];
const unsubscribe = scheduler.onEvent((e) => events.push(e));

try {
  // ── El disparo se persiste y se cancela en DB, no solo en memoria. ──
  const en2h = new Date(Date.now() + 2 * 3600_000).toISOString();
  scheduler.scheduleFixedTime(5, en2h);
  assert.equal(db.prepare('SELECT at_iso FROM schedules WHERE user_id = 5').get().at_iso, en2h);
  assert.equal(scheduler.getState(5).schedule.atISO, en2h);
  assert.equal(scheduler.getState(6).schedule, null, 'el disparo de un usuario no es de otro');

  assert.throws(() => scheduler.scheduleFixedTime(5, 'no-es-fecha'), /inválida/);
  assert.throws(() => scheduler.scheduleFixedTime(5, new Date(Date.now() - 1000).toISOString()), /futuro/);

  scheduler.cancelSchedule(5);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schedules').get().n, 0, 'cancelar borra la fila');
  assert.equal(scheduler.getState(5).schedule, null);

  // ── Restauración: lo vigente se rearma; lo vencido avisa en vez de disparar. ──
  const futuro = new Date(Date.now() + 3600_000).toISOString();
  const reciente = new Date(Date.now() - 5 * 60_000).toISOString(); // 5 min tarde: se ejecuta igual
  const viejo = new Date(Date.now() - 2 * 3600_000).toISOString(); // 2 horas tarde: aviso

  db.prepare('INSERT INTO schedules (user_id, at_iso) VALUES (7, ?)').run(futuro);
  db.prepare('INSERT INTO schedules (user_id, at_iso) VALUES (8, ?)').run(viejo);
  db.prepare('INSERT INTO watchers (user_id, interval_ms) VALUES (9, 3600000)').run();

  const restored = scheduler.restoreTimers();
  assert.equal(restored.schedules, 1, 'el disparo futuro se rearma');
  assert.equal(restored.dropped, 1, 'el disparo de hace 2 horas no se ejecuta a ciegas');
  assert.equal(restored.watchers, 1, 'el watcher persiste el reinicio');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schedules WHERE user_id = 8').get().n, 0, 'lo vencido se limpia');
  assert.ok(
    events.some((e) => e.type === 'notice' && e.userId === 8 && /no se ejecutó/.test(e.title)),
    'el dueño del disparo perdido recibe el aviso'
  );
  assert.equal(scheduler.getState(7).schedule.atISO, futuro, 'el rearmado queda en memoria');
  assert.ok(scheduler.getState(9).watcher, 'el watcher restaurado queda activo');

  // El aviso del disparo perdido lleva userId: el SSE de otro usuario no lo ve.
  const aviso = events.find((e) => e.type === 'notice' && /no se ejecutó/.test(e.title));
  assert.equal(aviso.userId, 8);

  // ── action_log: la respuesta literal del portal, por usuario. ──
  logAction({ userId: 5, action: 'enroll', detail: 'ICC ICC301-101 (4521)', response: 'Error: Class 4521 is full', ok: false });
  logAction({ userId: 5, action: 'drop', detail: 'FIS-139 (1930)', response: 'baja confirmada', ok: true });
  logAction({ userId: 6, action: 'enroll', detail: 'MAT-241', response: 'Success: enrolled', ok: true });

  const mias = readActions(5);
  assert.equal(mias.length, 2, 'cada usuario ve solo sus acciones');
  assert.equal(mias[0].action, 'drop', 'la más reciente primero');
  assert.equal(mias[1].portalResponse, 'Error: Class 4521 is full', 'la respuesta del portal va literal');
  assert.equal(mias[1].ok, false);
  assert.equal(readActions(6).length, 1);
} finally {
  scheduler.cancelSchedule(7);
  scheduler.stopWatcher(9);
  unsubscribe();
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ scheduler persistido: disparo/watcher por usuario sobreviven reinicios, action_log con respuesta literal');
