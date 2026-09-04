import fs from 'node:fs';
import path from 'node:path';
import { dataPaths } from './paths.js';
import { diagnosticsDir } from './diagnostics.js';

// Salir tiene que ser tan claro como entrar (Fase 4 §9). "Borrar mis datos" no
// puede significar "borré la tabla y dejé la contraseña en el keychain, las
// copias en el disco y las capturas del portal en diagnostics". Este módulo
// enumera TODO lo que la instalación escribió, para poder mostrarlo antes de
// borrar y para que el borrado no dependa de acordarse de cada ruta.

function sizeOf(target) {
  let bytes = 0;
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop();
    let stats;
    try {
      stats = fs.statSync(current);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      for (const entry of fs.readdirSync(current)) stack.push(path.join(current, entry));
    } else {
      bytes += stats.size;
    }
  }
  return bytes;
}

/**
 * Todo lo borrable, con su propósito. `keepable` marca lo que una desinstalación
 * puede preservar si el usuario lo pide (sus copias). `runtimeSafe` marca lo que
 * se puede borrar con el agente vivo: la base abierta y el runtime del proceso
 * no lo son, y por eso el borrado desde la UI limpia filas mientras que el de la
 * CLI —que primero detiene el agente— borra los archivos.
 */
export function eraseTargets(env = process.env) {
  const paths = dataPaths(env);
  const items = [
    { id: 'db', label: 'Base de datos local', path: paths.db, purpose: 'Notas, horario, avance, planes e historial' },
    { id: 'db-wal', label: 'Journal WAL', path: `${paths.db}-wal`, purpose: 'Escrituras pendientes de la base' },
    { id: 'db-shm', label: 'Memoria compartida SQLite', path: `${paths.db}-shm`, purpose: 'Índice del WAL' },
    { id: 'credentials', label: 'Archivo de credencial', path: paths.credentials, purpose: 'Usuario y contraseña del portal en claro' },
    { id: 'backups', label: 'Copias de seguridad', path: paths.backups, purpose: 'Copias diarias y pre-upgrade', keepable: true, runtimeSafe: true },
    { id: 'diagnostics', label: 'Diagnósticos', path: diagnosticsDir, purpose: 'Capturas y textos de fallas (pueden contener PII del portal)', runtimeSafe: true },
    { id: 'runtime', label: 'Runtime del agente', path: paths.runtime, purpose: 'Lock, PID y token del healthcheck' },
    { id: 'browsers', label: 'Browser administrado', path: paths.browsers, purpose: 'Chromium descargado por Playwright', keepable: true },
  ];
  return items.map((item) => {
    const exists = fs.existsSync(item.path);
    return {
      ...item,
      exists,
      bytes: exists ? sizeOf(item.path) : 0,
      keepable: item.keepable ?? false,
      runtimeSafe: item.runtimeSafe ?? false,
    };
  });
}

// Lo que no es un archivo: las suscripciones push y las sesiones registradas
// en la base. Se enumeran aparte porque su borrado pasa por otra API, pero el
// usuario tiene que verlos en el preview.
export function externalErasures() {
  return [
    { id: 'push', label: 'Suscripciones push', purpose: 'Endpoints de notificación registrados por cada navegador' },
    { id: 'sessions', label: 'Sesiones de mikampus', purpose: 'Cookies emitidas a los navegadores de este equipo' },
  ];
}

// Lo que mikampus NO puede borrar por vos, dicho en voz alta. Prometer un
// borrado total que el runtime no puede cumplir es peor que no prometerlo:
// el service worker y su caché viven en el navegador, y los logs del agente
// los administra el gestor de servicios del sistema.
export function outsideReach() {
  return [
    {
      id: 'service-worker',
      label: 'Service worker y caché del navegador',
      purpose: 'Se quitan desde el navegador: borrá los datos del sitio de localhost o desinstalá la PWA.',
    },
    {
      id: 'service-logs',
      label: 'Registros del servicio del sistema',
      purpose: 'mikampus no escribe archivos de log; si instalaste el servicio, la salida vive en journald/Event Viewer/launchd.',
    },
  ];
}

export function erasePreview(env = process.env) {
  const targets = eraseTargets(env);
  return {
    targets,
    external: externalErasures(),
    outsideReach: outsideReach(),
    totalBytes: targets.reduce((sum, item) => sum + item.bytes, 0),
    note: 'Tu cuenta de micampus no se toca: mikampus solo puede borrar lo que escribió en este equipo.',
  };
}

/**
 * Borra los artefactos en disco. `keep` lista los ids preservables que se
 * respetan (por ejemplo `backups` en una desinstalación que conserva datos).
 */
export function eraseLocalArtifacts({ keep = [], onlyRuntimeSafe = false, env = process.env } = {}) {
  const removed = [];
  for (const target of eraseTargets(env)) {
    if (keep.includes(target.id)) continue;
    if (onlyRuntimeSafe && !target.runtimeSafe) continue;
    if (!target.exists) continue;
    fs.rmSync(target.path, { recursive: true, force: true, maxRetries: 1 });
    removed.push(target.path);
  }
  return removed;
}
