import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readMeta, writeMeta, readMetaJson, writeMetaJson } from './appMeta.js';
import { resourcePath, dataPaths } from './paths.js';
import { createBackup } from './backups.js';

// Actualizaciones (Fase 4 §11). Dos reglas que el contrato de egress impone:
// mikampus nunca consulta si hay versión nueva por su cuenta —el check es una
// acción del usuario— y nada descargado se ejecuta sin haber verificado su
// SHA-256 contra el valor publicado en el release.

const POLICY_KEY = 'update.policy';        // 'manual' (default) | 'off'
const LAST_CHECK_KEY = 'update.lastCheck';
const STATE_KEY = 'update.state';
const RELEASES_URL = 'https://api.github.com/repos/eliasdlc/mikampus/releases/latest';

export function currentVersion() {
  try {
    return JSON.parse(fs.readFileSync(resourcePath('package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function updatePolicy() {
  const stored = readMeta(POLICY_KEY);
  return stored === 'off' ? 'off' : 'manual';
}

export function setUpdatePolicy(policy) {
  if (!['manual', 'off'].includes(policy)) throw new Error('La política de updates es "manual" o "off"');
  // No existe "automático" a propósito: un update-check automático es tráfico
  // periódico a un tercero que el usuario no pidió.
  return writeMeta(POLICY_KEY, policy);
}

export function lastUpdateCheck() {
  return readMetaJson(LAST_CHECK_KEY);
}

// Compara "1.2.10" contra "1.2.9" sin dependencias: sólo números y un sufijo
// pre-release que siempre pierde contra la versión final.
export function isNewer(candidate, base) {
  const parse = (value) => String(value).replace(/^v/, '').split('-')[0].split('.').map((n) => Number(n) || 0);
  const [a, b] = [parse(candidate), parse(base)];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/**
 * Consulta explícita. Nunca corre sola: la dispara el usuario desde Ajustes o
 * `mikampus update --check`.
 */
export async function checkForUpdate({ fetchImpl = fetch, now = new Date(), url = RELEASES_URL } = {}) {
  if (updatePolicy() === 'off') return { status: 'off', current: currentVersion() };
  const current = currentVersion();
  let result;
  try {
    const response = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) throw new Error(`GitHub respondió HTTP ${response.status}`);
    const release = await response.json();
    const latest = String(release.tag_name ?? '').replace(/^v/, '');
    result = {
      status: latest && isNewer(latest, current) ? 'update-available' : 'up-to-date',
      current,
      latest: latest || null,
      url: release.html_url ?? null,
      notes: release.body ? String(release.body).slice(0, 2000) : null,
      checkedAt: now.toISOString(),
    };
  } catch (error) {
    result = { status: 'error', current, error: error.message, checkedAt: now.toISOString() };
  }
  writeMetaJson(LAST_CHECK_KEY, result);
  return result;
}

/**
 * Descarga con verificación de integridad obligatoria. Un archivo que no
 * coincide con su hash se borra: no queda un artefacto a medio verificar que
 * alguien pueda ejecutar después por error.
 */
export async function downloadVerified(url, { sha256, dest, fetchImpl = fetch } = {}) {
  if (!sha256) throw new Error('Una descarga de update necesita su SHA-256 publicado');
  const target = dest ?? path.join(dataPaths().dataDir, 'updates', path.basename(new URL(url).pathname));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`La descarga respondió HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest.toLowerCase() !== String(sha256).toLowerCase()) {
    throw new Error(`El archivo descargado no coincide con su SHA-256 publicado (${digest})`);
  }
  fs.writeFileSync(target, bytes, { mode: 0o600 });
  return { path: target, sha256: digest, bytes: bytes.length };
}

// El orden no es negociable: primero se corta lo que puede escribir, después se
// respalda, después se cambia el código y recién entonces se valida. Cada paso
// se registra para que un corte de luz a mitad deje un rastro accionable en vez
// de una instalación en estado desconocido.
export const UPDATE_STEPS = ['verify', 'stop-agent', 'backup', 'install', 'migrate', 'health'];

export function updateState() {
  return readMetaJson(STATE_KEY);
}

export function clearUpdateState() {
  writeMetaJson(STATE_KEY, null);
}

/**
 * Ejecuta el flujo con los pasos que le inyecte el host (el instalador real
 * llega en Fase 5). Deja `update.state` con el paso alcanzado y el backup para
 * volver, tanto si termina como si falla.
 */
export async function runUpdate({ verify, stopAgent, install, migrate, health, now = new Date() } = {}) {
  const steps = { verify, 'stop-agent': stopAgent, install, migrate, health };
  const state = { startedAt: now.toISOString(), from: currentVersion(), step: null, backup: null, status: 'running' };
  writeMetaJson(STATE_KEY, state);

  for (const name of UPDATE_STEPS) {
    state.step = name;
    writeMetaJson(STATE_KEY, state);
    try {
      if (name === 'backup') {
        // El respaldo previo al update es el camino de retorno; si no se puede
        // hacer, el update no arranca.
        state.backup = createBackup({ now });
        writeMetaJson(STATE_KEY, state);
        continue;
      }
      await steps[name]?.();
    } catch (error) {
      const failed = {
        ...state,
        status: 'failed',
        error: error.message,
        recovery: state.backup
          ? `Restaurá con \`mikampus restore ${state.backup}\` y volvé a la versión anterior.`
          : 'No se llegó a hacer la copia: los datos siguen como estaban antes del update.',
      };
      writeMetaJson(STATE_KEY, failed);
      throw Object.assign(new Error(`El update falló en "${name}": ${error.message}`), { state: failed });
    }
  }

  const done = { ...state, status: 'done', step: null, finishedAt: new Date().toISOString() };
  writeMetaJson(STATE_KEY, done);
  return done;
}
