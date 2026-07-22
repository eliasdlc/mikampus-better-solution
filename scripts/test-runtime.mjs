// El proceso durable no depende del navegador: lock exclusivo, token de health
// y recuperación del intervalo no vigilado se prueban sin abrir Chromium.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-runtime-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.MIKAMPUS_RUNTIME_DIR = path.join(dir, 'runtime');
const { db } = await import('../src/db.js');
const runtime = await import('../src/runtime.js');

try {
  const token = runtime.agentToken();
  assert.ok(token.length >= 32, 'el healthcheck tiene un secreto aleatorio');
  runtime.acquireAgentLock({ port: 4173 });
  assert.equal(runtime.readAgentLock().pid, process.pid, 'el agente publica ownership');
  assert.throws(() => runtime.acquireAgentLock({ port: 4173 }), /Ya existe/, 'un segundo agente no puede duplicar trabajo');
  runtime.recordRuntimeStart();
  db.prepare("INSERT INTO watchers (user_id, interval_ms) VALUES (1, 45000)").run();
  // Simula el siguiente arranque sin cerrar el evento anterior (crash/reboot).
  runtime.recordRuntimeStart();
  const watcher = db.prepare('SELECT status, pause_reason FROM watchers WHERE user_id = 1').get();
  assert.equal(watcher.status, 'monitoring-gap');
  assert.match(watcher.pause_reason, /Agente no disponible/);
  runtime.recordRuntimeStop();
  runtime.releaseAgentLock();
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log('✓ runtime durable: lock, health token y monitoring gap persistidos');
