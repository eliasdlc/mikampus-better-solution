// Smoke del ciclo de vida (Fase 4): un agente real, con datos en un app-data
// desechable, tiene que poder guiar el primer uso SIN terminal, negar todo lo
// demás sin sesión, y notificar por su cuenta con el navegador cerrado.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const dataDir = await mkdtemp(path.join(tmpdir(), 'mikampus-lifecycle-'));
const port = 47291;
const base = `http://127.0.0.1:${port}`;
const origin = { Origin: base, 'Content-Type': 'application/json' };

// El repo puede tener capturas viejas de recon (carpeta ignorada por git). Lo
// que se verifica es que ESTA corrida no escriba ninguna nueva ahí.
const screenshotsBefore = await readdir(path.join(root, 'screenshots')).catch(() => []);

const child = spawn(process.execPath, [path.join(root, 'src', 'launcher.js')], {
  cwd: tmpdir(),
  env: { ...process.env, PORT: String(port), MIKAMPUS_DATA_DIR: dataDir, MIKAMPUS_SILENT: '1', MIKAMPUS_DB: '', MIKAMPUS_BACKUP_DIR: '', MIKAMPUS_RUNTIME_DIR: '', MIKAMPUS_CRED_DB: '' },
  stdio: 'ignore',
});

try {
  const until = Date.now() + 15_000;
  let up = false;
  while (Date.now() < until && !up) {
    try {
      up = (await fetch(`${base}/api/onboarding`)).ok;
    } catch {}
    if (!up) await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.ok(up, 'el agente levantó y sirve el onboarding');

  // ── El primer uso no necesita terminal ──────────────────────────────────
  let state = await (await fetch(`${base}/api/onboarding`)).json();
  assert.equal(state.step, 'mode', 'el primer paso está disponible sin sesión');
  assert.equal(state.mode, null);

  const chosen = await fetch(`${base}/api/onboarding/mode`, {
    method: 'POST',
    headers: origin,
    body: JSON.stringify({ mode: 'desktop' }),
  });
  assert.equal(chosen.status, 200, 'elegir modo funciona desde la UI local');
  state = await (await fetch(`${base}/api/onboarding`)).json();
  assert.equal(state.mode, 'desktop');
  assert.ok(state.prerequisites.length > 0, 'los prerequisitos se verifican en el agente');

  // ── Una página ajena no puede manejar esta instalación ───────────────────
  const foreign = await fetch(`${base}/api/onboarding/mode`, {
    method: 'POST',
    headers: { Origin: 'https://sitio-ajeno.invalid', 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'home-server' }),
  });
  assert.equal(foreign.status, 403, 'un origen ajeno no puede tocar el onboarding');
  state = await (await fetch(`${base}/api/onboarding`)).json();
  assert.equal(state.mode, 'desktop', 'y no cambió nada');

  // ── Todo lo demás sigue exigiendo sesión ────────────────────────────────
  for (const route of ['/api/status', '/api/backups', '/api/notifications', '/api/account/erase-preview', '/api/diagnostics']) {
    assert.equal((await fetch(`${base}${route}`)).status, 401, `${route} exige sesión`);
  }
  assert.equal(
    (await fetch(`${base}/api/updates/check`, { method: 'POST', headers: origin })).status,
    401,
    'el update-check exige sesión'
  );

  // ── Los datos viven en app-data, no junto al código ─────────────────────
  assert.ok(existsSync(path.join(dataDir, 'mikampus.db')), 'la base se creó en app-data');
  assert.ok(!existsSync(path.join(root, 'mikampus.db')), 'no se escribió nada junto al repo');
  assert.ok(existsSync(path.join(dataDir, 'backups')), 'la copia de arranque se hizo sola');
  const screenshotsAfter = await readdir(path.join(root, 'screenshots')).catch(() => []);
  assert.deepEqual(screenshotsAfter, screenshotsBefore, 'ningún diagnóstico nuevo cae en el CWD del proceso');
} finally {
  child.kill('SIGTERM');
  if (child.exitCode == null) await new Promise((resolve) => child.once('exit', resolve));
  await rm(dataDir, { recursive: true, force: true });
}

console.log('✓ smoke: primer uso sin terminal, origen ajeno rechazado, sesión exigida y datos en app-data');
