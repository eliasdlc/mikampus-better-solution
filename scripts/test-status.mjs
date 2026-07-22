// El estado permanente: lo que la UI muestra siempre tiene que contestar si
// mikampus está trabajando, hasta cuándo, y qué necesita para seguir.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-status-'));
process.env.MIKAMPUS_DATA_DIR = dir;
process.env.MIKAMPUS_DB = path.join(dir, 'mikampus.db');
process.env.MIKAMPUS_BACKUP_DIR = path.join(dir, 'backups');
process.env.MIKAMPUS_RUNTIME_DIR = path.join(dir, 'runtime');
delete process.env.MIKAMPUS_RUNTIME_MODE;

const { db } = await import('../src/db.js');
const { chooseMode } = await import('../src/onboarding.js');
const { recordRuntimeStart, recordRuntimeStop } = await import('../src/runtime.js');
const { fullStatus } = await import('../src/status.js');

try {
  chooseMode('desktop');

  // Sin watcher ni disparo, el equipo no tiene por qué quedarse despierto.
  let status = fullStatus(1);
  assert.equal(status.mode, 'desktop');
  assert.equal(status.watcher, null);
  assert.equal(status.power.mustStayAwake, false, 'sin trabajo pendiente no se le pide nada al usuario');
  assert.ok(status.schema.version >= 2, 'el estado publica la versión de esquema');
  assert.ok(status.backup.sameDiskWarning.length > 0, 'el aviso de copias viaja con el estado');
  assert.equal(status.update.policy, 'manual');

  // Con watcher vigilando, la UI tiene que decir que el equipo debe seguir vivo.
  db.prepare(
    "INSERT INTO watchers (user_id, interval_ms, status, next_check_at, consecutive_failures) VALUES (1, 45000, 'running', '2026-07-22T12:00:00Z', 0)"
  ).run();
  status = fullStatus(1);
  assert.equal(status.watcher.status, 'running');
  assert.equal(status.watcher.nextCheckAt, '2026-07-22T12:00:00Z', 'se ve cuándo es la próxima consulta');
  assert.equal(status.power.mustStayAwake, true, 'Desktop avisa que dormir o apagar pausa la vigilancia');
  assert.match(status.power.note, /dormir|hibernar|apagar/i);

  // Backoff tras fallos: el número de fallos consecutivos es parte del estado.
  db.prepare("UPDATE watchers SET status = 'backing-off', consecutive_failures = 3 WHERE user_id = 1").run();
  status = fullStatus(1);
  assert.equal(status.watcher.consecutiveFailures, 3);
  assert.equal(status.power.mustStayAwake, true, 'un watcher en backoff sigue siendo trabajo pendiente');

  // Un intervalo no vigilado (crash/reboot) queda visible y medido.
  recordRuntimeStart();
  recordRuntimeStop();
  db.prepare("UPDATE runtime_events SET started_at = '2026-07-20T10:00:00.000Z', ended_at = '2026-07-20T11:00:00.000Z' WHERE id = 1").run();
  db.prepare("INSERT INTO runtime_events (kind, detail, started_at) VALUES ('agent', 'reinicio', '2026-07-20T15:00:00.000Z')").run();
  status = fullStatus(1);
  assert.ok(status.monitoringGap, 'el gap se expone, no se esconde');
  assert.equal(status.monitoringGap.ms, 4 * 60 * 60 * 1000, 'y se mide de verdad');

  // Home Server no le pide a nadie que deje una laptop despierta.
  chooseMode('home-server');
  status = fullStatus(1);
  assert.equal(status.power.mustStayAwake, false);
  assert.match(status.power.note, /Home Server/);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ estado permanente: agente, watcher, backoff, gap, próxima acción, copias y energía');
