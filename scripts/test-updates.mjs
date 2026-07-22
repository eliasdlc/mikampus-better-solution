// Updates: nunca automáticos, con descarga verificada por SHA-256 y un flujo
// que detiene el agente, respalda y deja camino de vuelta si algo falla.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-updates-'));
process.env.MIKAMPUS_DATA_DIR = dir;
process.env.MIKAMPUS_DB = path.join(dir, 'mikampus.db');
process.env.MIKAMPUS_BACKUP_DIR = path.join(dir, 'backups');

const updates = await import('../src/updates.js');

try {
  // ── Comparación de versiones ─────────────────────────────────────────────
  assert.equal(updates.isNewer('0.2.0', '0.1.9'), true);
  assert.equal(updates.isNewer('1.0.10', '1.0.9'), true);
  assert.equal(updates.isNewer('0.1.0', '0.1.0'), false);
  assert.equal(updates.isNewer('v0.1.0-rc.1', '0.1.0'), false, 'un pre-release no gana contra la versión final');

  // ── El chequeo es una acción del usuario y se puede apagar ───────────────
  assert.equal(updates.updatePolicy(), 'manual', 'por defecto solo hay chequeo manual');
  assert.throws(() => updates.setUpdatePolicy('auto'), /manual/, 'no existe el modo automático');

  let requests = 0;
  const release = {
    ok: true,
    json: async () => ({ tag_name: 'v9.9.9', html_url: 'https://ejemplo.invalid/release', body: 'notas' }),
  };
  const fetchImpl = async () => {
    requests += 1;
    return release;
  };

  updates.setUpdatePolicy('off');
  const apagado = await updates.checkForUpdate({ fetchImpl });
  assert.equal(apagado.status, 'off');
  assert.equal(requests, 0, 'con el chequeo apagado no sale un solo request');

  updates.setUpdatePolicy('manual');
  const disponible = await updates.checkForUpdate({ fetchImpl, now: new Date('2026-07-22T12:00:00Z') });
  assert.equal(disponible.status, 'update-available');
  assert.equal(disponible.latest, '9.9.9');
  assert.equal(requests, 1, 'el chequeo consulta una vez, cuando se lo piden');
  assert.equal(updates.lastUpdateCheck().latest, '9.9.9', 'el resultado queda registrado para mostrarlo');

  const caido = await updates.checkForUpdate({ fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(caido.status, 'error', 'un GitHub caído no rompe la app');

  // ── Descarga verificada ─────────────────────────────────────────────────
  const payload = Buffer.from('artefacto de prueba');
  const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
  const download = async () => ({ ok: true, arrayBuffer: async () => payload });

  const dest = path.join(dir, 'mikampus.tar.gz');
  const ok = await updates.downloadVerified('https://ejemplo.invalid/mikampus.tar.gz', { sha256, dest, fetchImpl: download });
  assert.equal(ok.sha256, sha256);
  assert.ok(fs.existsSync(dest));

  await assert.rejects(
    updates.downloadVerified('https://ejemplo.invalid/x.tar.gz', { sha256: 'a'.repeat(64), dest: path.join(dir, 'malo.tar.gz'), fetchImpl: download }),
    /SHA-256/,
    'un archivo que no coincide con su hash se rechaza'
  );
  assert.equal(fs.existsSync(path.join(dir, 'malo.tar.gz')), false, 'no queda un artefacto sin verificar en disco');

  await assert.rejects(
    updates.downloadVerified('https://ejemplo.invalid/x.tar.gz', { dest, fetchImpl: download }),
    /SHA-256/,
    'sin hash publicado no se descarga nada'
  );

  // ── El flujo: orden fijo, respaldo antes de tocar código ─────────────────
  const order = [];
  const steps = {
    verify: () => order.push('verify'),
    stopAgent: () => order.push('stop-agent'),
    install: () => order.push('install'),
    migrate: () => order.push('migrate'),
    health: () => order.push('health'),
  };
  const done = await updates.runUpdate({ ...steps, now: new Date('2026-07-22T13:00:00Z') });
  assert.deepEqual(order, ['verify', 'stop-agent', 'install', 'migrate', 'health'], 'el agente se detiene antes de instalar');
  assert.equal(done.status, 'done');
  assert.ok(done.backup && fs.existsSync(done.backup), 'el update respalda la base antes de instalar');

  // Un fallo deja estado durable con el camino de vuelta.
  await assert.rejects(
    updates.runUpdate({ ...steps, install: () => { throw new Error('el instalador murió'); }, now: new Date('2026-07-22T14:00:00Z') }),
    /instalador murió/
  );
  const state = updates.updateState();
  assert.equal(state.status, 'failed');
  assert.equal(state.step, 'install');
  assert.match(state.recovery, /mikampus restore/, 'el estado dice exactamente cómo volver');
  assert.ok(fs.existsSync(state.backup), 'la copia a la que apunta existe');
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ updates: chequeo manual u apagado, descarga verificada y flujo con respaldo y recuperación');
