// Primer uso sin terminal: modo con sus garantías, prerequisitos verificables y
// el orden que impide pedir una contraseña antes de poder verificarla.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-onboarding-'));
process.env.MIKAMPUS_DATA_DIR = dir;
process.env.MIKAMPUS_DB = path.join(dir, 'mikampus.db');
delete process.env.MIKAMPUS_RUNTIME_MODE;

const { db } = await import('../src/db.js');
const onboarding = await import('../src/onboarding.js');
const { parseProgress } = await import('../src/browser.js');

try {
  // ── Paso 1: sin modo elegido no se avanza ────────────────────────────────
  let state = await onboarding.onboardingState();
  assert.equal(state.mode, null, 'una instalación nueva no asume el modo');
  assert.equal(state.step, 'mode', 'el primer paso es elegir cómo va a correr');
  assert.deepEqual(state.modes.map((mode) => mode.id).sort(), ['desktop', 'home-server']);
  for (const mode of state.modes) {
    assert.ok(mode.guarantees.length >= 2, `${mode.id} declara sus garantías antes de elegirse`);
  }
  // Las garantías dicen la verdad incómoda de cada modo.
  assert.match(state.modes.find((m) => m.id === 'desktop').guarantees.join(' '), /dormir|apagar/i);
  assert.match(state.modes.find((m) => m.id === 'home-server').guarantees.join(' '), /24\/7/);

  assert.throws(() => onboarding.chooseMode('nube'), /desconocido/, 'no hay modos fuera de los dos soportados');
  onboarding.chooseMode('desktop');
  assert.equal(onboarding.runtimeMode(), 'desktop', 'la elección persiste');

  // ── Paso 2: prerequisitos comprobables sin tocar el portal ───────────────
  state = await onboarding.onboardingState();
  const ids = state.prerequisites.map((check) => check.id);
  assert.deepEqual(ids, ['node', 'data-dir', 'backups']);
  assert.ok(state.prerequisites.every((check) => check.ok), 'en este entorno los prerequisitos pasan');

  // ── Paso 3 y 4: la credencial va DESPUÉS del browser ─────────────────────
  // El estado real de este entorno depende de si Chromium está instalado; lo
  // que se verifica es la regla, no la máquina.
  assert.equal(
    state.step,
    state.browser.installed ? 'credentials' : 'browser',
    'sin browser instalado nunca se llega al paso de la contraseña'
  );
  assert.equal(state.account, false, 'todavía no hay cuenta configurada');
  assert.equal(state.browser.install.status, 'idle', 'no se descarga nada sin que el usuario lo pida');

  // Con cuenta configurada, el onboarding se da por terminado.
  db.prepare("UPDATE users SET portal_username = 'operador' WHERE id = 1").run();
  state = await onboarding.onboardingState();
  if (state.browser.installed) assert.equal(state.step, 'done');

  onboarding.markOnboardingComplete(new Date('2026-07-22T12:00:00Z'));
  assert.equal((await onboarding.onboardingState()).completedAt, '2026-07-22T12:00:00.000Z');

  // El progreso de la descarga viene de la salida real de Playwright.
  assert.equal(parseProgress('|██████    |  45% of 160.5 MiB'), 45);
  assert.equal(parseProgress('Downloading Chromium 141.0'), null);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ onboarding: modo con garantías, prerequisitos y credencial siempre después del browser');
