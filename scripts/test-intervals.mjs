// Los dos ritmos configurables, contra SQLite desechable y sin abrir Chromium.
//
// Lo que protege:
//   1. Que "nunca lo configuré" signifique el default y no cero. Number(null)
//      es 0 y es finito: sin una guarda explícita, el watcher quedaba pegado a
//      su piso de 30s y el techo de sincronización de una hora se apagaba solo.
//   2. Que el techo global de frescura sea un TECHO y no un piso: el carrito
//      tiene que seguir venciendo a los diez minutos aunque el techo sea 24h.
//   3. Que los límites se validen en el borde y no en la UI, que es lo único
//      que impide pedirle al portal una consulta por segundo.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-intervals-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.MIKAMPUS_SILENT = '1';
// El default del despliegue queda explícito: el test comprueba la preferencia
// guardada, no el valor que traiga el entorno de quien lo corre.
process.env.WATCHER_INTERVAL_MS = '45000';

const { db } = await import('../src/db.js');
const scheduler = await import('../src/scheduler.js');
const sync = await import('../src/syncOrchestrator.js');

try {
  // ── 1. Sin preferencia guardada, manda el default ─────────────────────────
  assert.equal(scheduler.watcherTickMs(), 45_000, 'sin preferencia, el watcher usa el default del entorno');
  assert.equal(sync.syncIntervalMs(), 3_600_000, 'sin preferencia, la sincronización se refresca cada hora');

  // Una fila vacía en app_meta no es una preferencia: tiene que caer al default
  // igual que la ausencia, no leerse como cero.
  db.prepare("INSERT INTO app_meta (key, value) VALUES ('sync.intervalMs', '')").run();
  assert.equal(sync.syncIntervalMs(), 3_600_000, 'un valor vacío cae al default, no a cero');
  db.prepare("DELETE FROM app_meta WHERE key = 'sync.intervalMs'").run();

  // ── 2. El watcher: se guarda, se aplica y se valida ───────────────────────
  assert.equal(scheduler.setWatcherTickMs(300_000), 300_000, 'se guarda el ritmo elegido');
  assert.equal(scheduler.watcherTickMs(), 300_000, 'y sobrevive a la siguiente lectura');

  assert.throws(
    () => scheduler.setWatcherTickMs(1_000),
    /entre 30s/,
    'por debajo del piso se rechaza en el backend, no solo en la UI'
  );
  assert.throws(() => scheduler.setWatcherTickMs(7_200_000), /entre 30s/, 'por encima del techo también');
  assert.throws(() => scheduler.setWatcherTickMs('rápido'), /entre 30s/, 'un valor no numérico no pasa');
  assert.equal(scheduler.watcherTickMs(), 300_000, 'un intento rechazado no pisa lo guardado');

  // El estado servido a la UI expone el ritmo aunque no haya watcher corriendo:
  // se tiene que poder elegir cada cuánto vigilar ANTES de encenderlo.
  const state = scheduler.getState(1);
  assert.equal(state.watcher, null, 'no hay watcher encendido en este test');
  assert.equal(state.watcherSettings.tickMs, 300_000, 'el ritmo se sirve con el watcher apagado');
  assert.equal(state.watcherSettings.minTickMs, 30_000);
  assert.equal(state.watcherSettings.maxTickMs, 3_600_000);

  // ── 3. El techo de sincronización es un techo, no un piso ─────────────────
  const bySource = () => Object.fromEntries(sync.SOURCES.map((s) => [s.key, sync.effectiveTtlMs(s)]));

  sync.setSyncIntervalMs(3_600_000);
  let ttl = bySource();
  assert.equal(ttl.advisement, 3_600_000, 'el avance (7 días naturales) queda acotado por el techo');
  assert.equal(ttl.mySchedule, 3_600_000, 'el horario (12h naturales) también');
  assert.equal(ttl.cart, 600_000, 'el carrito conserva sus 10 min: el mínimo de los dos manda');

  sync.setSyncIntervalMs(86_400_000);
  ttl = bySource();
  assert.equal(ttl.cart, 600_000, 'con techo de 24h el carrito sigue en 10 min');
  assert.equal(ttl.mySchedule, 12 * 3_600_000, 'y el horario vuelve a su frescura natural');

  // Cero es "sin techo": cada fuente con su propia frescura declarada.
  sync.setSyncIntervalMs(0);
  ttl = bySource();
  assert.equal(ttl.advisement, 7 * 24 * 3_600_000, 'sin techo, el avance vuelve a su semana');
  assert.equal(ttl.cart, 600_000);

  assert.throws(() => sync.setSyncIntervalMs(60_000), /0 \(sin techo\)/, 'un minuto es demasiado agresivo');
  assert.throws(() => sync.setSyncIntervalMs(48 * 3_600_000), /0 \(sin techo\)/, 'dos días es demasiado viejo');

  // ── 4. Lo que la UI lee: TTL efectivo, no el declarado ────────────────────
  sync.setSyncIntervalMs(3_600_000);
  const advisement = sync.syncState(1).sources.find((source) => source.key === 'advisement');
  assert.equal(advisement.ttlMs, 3_600_000, 'la pantalla recibe el TTL que de verdad rige');
  assert.equal(advisement.naturalTtlMs, 7 * 24 * 3_600_000, 'y también el natural, para poder explicarlo');
  assert.equal(sync.syncState(1).interval.ms, 3_600_000, 'el estado publica el techo vigente');

  console.log('✓ ritmos: default sin preferencia, techo de frescura que no es piso, y límites validados en el backend');
} finally {
  await rm(dir, { recursive: true, force: true });
}
