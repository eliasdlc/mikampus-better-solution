// Salir de mikampus: el preview enumera todo lo que la instalación escribió, y
// el borrado no deja secretos, copias ni capturas del portal.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-erase-'));
// Toda ruta que `dataPaths()` sabe resolver tiene que apuntar al temporal. La
// que falte no se aísla: la hereda del entorno y este test la BORRA de verdad.
// PLAYWRIGHT_BROWSERS_PATH es la trampa, porque es la única que un equipo de
// desarrollo suele tener exportada por su cuenta, y ahí `npm test` se lleva
// puesto el Chromium del que dependen los demás tests.
const env = {
  MIKAMPUS_DATA_DIR: dir,
  MIKAMPUS_DB: path.join(dir, 'mikampus.db'),
  MIKAMPUS_CREDENTIALS_FILE: path.join(dir, 'credenciales.env'),
  MIKAMPUS_BACKUP_DIR: path.join(dir, 'backups'),
  MIKAMPUS_RUNTIME_DIR: path.join(dir, 'runtime'),
  PLAYWRIGHT_BROWSERS_PATH: path.join(dir, 'browsers'),
};
Object.assign(process.env, env);

const { erasePreview, eraseTargets, eraseLocalArtifacts } = await import('../src/erase.js');
const { diagnosticsDir } = await import('../src/diagnostics.js');

try {
  // Se fabrica una instalación "usada": base, credencial, copias, diagnósticos y
  // runtime, que es exactamente lo que un borrado incompleto suele olvidar.
  fs.mkdirSync(env.MIKAMPUS_BACKUP_DIR, { recursive: true });
  fs.mkdirSync(env.MIKAMPUS_RUNTIME_DIR, { recursive: true });
  fs.mkdirSync(diagnosticsDir, { recursive: true });
  fs.writeFileSync(env.MIKAMPUS_DB, 'datos');
  fs.writeFileSync(`${env.MIKAMPUS_DB}-wal`, 'wal');
  fs.writeFileSync(env.MIKAMPUS_CREDENTIALS_FILE, 'MIKAMPUS_PORTAL_USER=ana\n');
  fs.writeFileSync(path.join(env.MIKAMPUS_BACKUP_DIR, 'mikampus-2026-07-20.sqlite'), 'copia');
  fs.writeFileSync(path.join(diagnosticsDir, '2026-login.png'), 'captura');
  fs.writeFileSync(path.join(env.MIKAMPUS_RUNTIME_DIR, 'agent.token'), 'token');

  const preview = erasePreview();
  // Antes de borrar nada: ningún objetivo puede caer fuera del temporal. Este
  // test ejecuta un borrado real, así que una ruta heredada del entorno no
  // falla — destruye. Se verifica que el aislamiento existe, no que se quiso.
  for (const target of preview.targets) {
    assert.ok(
      target.path.startsWith(dir + path.sep),
      `el objetivo ${target.id} apunta fuera del temporal (${target.path}); abortá antes de borrarlo`
    );
  }
  const ids = preview.targets.map((target) => target.id);
  for (const required of ['db', 'db-wal', 'db-shm', 'credentials', 'backups', 'diagnostics', 'runtime', 'browsers']) {
    assert.ok(ids.includes(required), `el preview enumera ${required}`);
  }
  assert.ok(
    preview.external.some((item) => item.id === 'sessions'),
    'el preview incluye lo que no es un archivo: las sesiones emitidas'
  );
  assert.ok(preview.totalBytes > 0, 'el preview dice cuánto ocupa');
  assert.match(preview.note, /micampus/, 'aclara que la cuenta del portal no se toca');
  assert.ok(
    preview.outsideReach.some((item) => item.id === 'service-worker'),
    'y declara lo que no puede borrar por vos en vez de prometer un borrado total'
  );

  // Con el agente vivo solo se pueden borrar copias y diagnósticos: la base
  // abierta y el runtime son del proceso.
  const runtimeSafe = eraseLocalArtifacts({ onlyRuntimeSafe: true });
  assert.equal(fs.existsSync(diagnosticsDir), false, 'las capturas del portal se van con el borrado en caliente');
  assert.equal(fs.existsSync(env.MIKAMPUS_BACKUP_DIR), false, 'las copias también');
  assert.equal(fs.existsSync(env.MIKAMPUS_DB), true, 'la base abierta no se borra bajo el proceso');
  assert.ok(runtimeSafe.length >= 2);

  // Con el agente detenido, no queda nada.
  eraseLocalArtifacts();
  for (const target of eraseTargets()) {
    assert.equal(fs.existsSync(target.path), false, `${target.id} quedó eliminado`);
  }

  // La desinstalación que conserva datos preserva SOLO lo preservable.
  fs.mkdirSync(env.MIKAMPUS_BACKUP_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.MIKAMPUS_BACKUP_DIR, 'mikampus-2026-07-21.sqlite'), 'copia');
  fs.writeFileSync(env.MIKAMPUS_CREDENTIALS_FILE, 'MIKAMPUS_PORTAL_USER=ana\n');
  eraseLocalArtifacts({ keep: ['backups'] });
  assert.equal(fs.existsSync(env.MIKAMPUS_BACKUP_DIR), true, 'las copias se conservan si se pidió');
  assert.equal(fs.existsSync(env.MIKAMPUS_CREDENTIALS_FILE), false, 'la credencial nunca se conserva');
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ erase: preview completo, borrado en caliente sin capturas y desinstalación que preserva solo lo elegido');
