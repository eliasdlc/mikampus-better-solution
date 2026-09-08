// Con qué navegador scrapea mikampus.
//
// El caso que motivó esta prueba: en Ubuntu, `/usr/bin/chromium-browser` es un
// script de dos kilobytes que reenvía al snap, y un Chromium confinado por snap
// no puede leer el perfil que Playwright le crea en /tmp. Arranca y se muere
// con `ptrace: Input/output error` y SIGTRAP, así que el login falla con un
// muro de log que no dice nada de la credencial. Elegirlo es el bug.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { isSnapLauncher, preferredBrowser, systemBrowserExecutable } = await import('../src/browser.js');

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-browser-'));

try {
  // ── El shim de Ubuntu, tal como es en disco ──
  const shim = path.join(dir, 'chromium-browser');
  await writeFile(
    shim,
    ['#!/bin/sh', '# Chromium snap wrapper', 'exec /snap/bin/chromium "$@"'].join('\n')
  );
  await chmod(shim, 0o755);
  assert.equal(isSnapLauncher(shim), true, 'un script que reenvía al snap no sirve para automatizar');

  // ── Un binario de verdad ──
  const real = path.join(dir, 'chrome');
  await writeFile(real, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]));
  assert.equal(isSnapLauncher(real), false, 'un ELF normal sí sirve');

  // ── Un enlace directo dentro de /snap ──
  const dentro = path.join(dir, 'snap-fake', 'bin');
  await mkdir(dentro, { recursive: true });
  const destino = path.join(dentro, 'chromium');
  await writeFile(destino, 'x');
  const enlace = path.join(dir, 'link-chromium');
  await symlink(destino, enlace);
  assert.equal(isSnapLauncher(enlace), false, 'un enlace fuera de /snap real no se descarta por parecido');

  assert.equal(isSnapLauncher(path.join(dir, 'no-existe')), false, 'un archivo que no está no rompe la detección');

  // ── Cuál gana ──
  assert.deepEqual(
    preferredBrowser({ managed: '/managed/chrome', system: '/usr/bin/google-chrome' }),
    { executable: '/managed/chrome', source: 'managed' },
    'con los dos en disco manda el administrado: es el build contra el que Playwright se probó'
  );
  assert.deepEqual(
    preferredBrowser({ managed: null, system: '/usr/bin/google-chrome' }),
    { executable: '/usr/bin/google-chrome', source: 'system' },
    'sin descarga administrada se usa el del equipo, que es para lo que existía la preferencia'
  );
  assert.deepEqual(preferredBrowser({}), { executable: null, source: null }, 'sin ninguno se dice que no hay');

  // ── CHROME_PATH es una elección explícita y manda ──
  const previo = process.env.CHROME_PATH;
  process.env.CHROME_PATH = shim;
  assert.equal(systemBrowserExecutable(), shim, 'si la persona apunta a un navegador a mano, se respeta aunque sea snap');
  process.env.CHROME_PATH = path.join(dir, 'tampoco-existe');
  assert.notEqual(systemBrowserExecutable(), process.env.CHROME_PATH, 'una ruta que no existe no se devuelve');
  if (previo === undefined) delete process.env.CHROME_PATH;
  else process.env.CHROME_PATH = previo;
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ navegador: el shim del snap se descarta, el administrado gana cuando ya está bajado y CHROME_PATH sigue mandando');
