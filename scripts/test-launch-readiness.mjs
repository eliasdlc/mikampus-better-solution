// Contrato del pre-warm para el día-D: la distribución no puede depender de
// timers reales ni debe concentrar logins en el mismo milisegundo.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-launch-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.MIKAMPUS_SILENT = '1';

const scheduler = await import('../src/scheduler.js');

try {
  const now = Date.parse('2026-07-19T05:00:00.000-04:00');
  const atISO = '2026-07-19T06:00:00.000-04:00';
  const fireAt = Date.parse(atISO);
  const prewarms = Array.from({ length: 12 }, (_, index) =>
    Date.parse(scheduler.prewarmAtFor(index + 1, atISO, now))
  );

  assert.ok(prewarms.every((time) => time >= fireAt - 8 * 60_000), 'ningún pre-warm empieza antes de T-8');
  assert.ok(prewarms.every((time) => time <= fireAt - 60_000), 'queda al menos un minuto antes de T0');
  assert.ok(new Set(prewarms).size > 1, 'usuarios distintos no hacen login todos en el mismo instante');
  assert.equal(
    scheduler.prewarmAtFor(4, atISO, now),
    scheduler.prewarmAtFor(4, atISO, now),
    'el jitter es estable para que un reinicio no cambie el turno del usuario'
  );
  assert.equal(
    scheduler.prewarmAtFor(4, '2026-07-19T05:04:00.000-04:00', now),
    new Date(now).toISOString(),
    'un disparo creado con poco margen prepara inmediatamente'
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ lanzamiento: pre-warms repartidos, estables y con margen antes de T0');
