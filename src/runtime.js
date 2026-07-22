import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH } from './db.js';
import { db } from './db.js';

// El lock pertenece al agente, no a una pestaña. Es un archivo pequeño y
// deliberadamente independiente de SQLite para poder diagnosticar un proceso
// vivo aun cuando la base esté dañada.
export const runtimeDir = process.env.MIKAMPUS_RUNTIME_DIR || path.join(path.dirname(DB_PATH), 'runtime');
export const lockPath = path.join(runtimeDir, 'agent.lock.json');
export const tokenPath = path.join(runtimeDir, 'agent.token');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function readAgentLock() { return readJson(lockPath); }

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export function agentToken() {
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const configuredFile = process.env.MIKAMPUS_AGENT_TOKEN_FILE;
  if (configuredFile) {
    const token = fs.readFileSync(configuredFile, 'utf8').trim();
    if (!token) throw new Error('MIKAMPUS_AGENT_TOKEN_FILE está vacío');
    return token;
  }
  try { return fs.readFileSync(tokenPath, 'utf8').trim(); } catch {}
  const token = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}

export function acquireAgentLock({ port }) {
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const existing = readAgentLock();
  if (existing && processIsAlive(existing.pid)) {
    const error = new Error(`Ya existe un agente mikampus (PID ${existing.pid}, puerto ${existing.port ?? 'desconocido'})`);
    error.code = 'MIKAMPUS_AGENT_RUNNING';
    error.lock = existing;
    throw error;
  }
  // Un lock de un crash no es propiedad viva; retirarlo permite recuperación,
  // pero jamás se reutiliza un puerto alterno silenciosamente.
  try { fs.unlinkSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lock = { pid: process.pid, port: Number(port), startedAt: new Date().toISOString() };
  fs.writeFileSync(lockPath, `${JSON.stringify(lock)}\n`, { flag: 'wx', mode: 0o600 });
  return lock;
}

export function releaseAgentLock() {
  const lock = readAgentLock();
  if (lock?.pid === process.pid) {
    try { fs.unlinkSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function agentHealthAuthorized(req) {
  const expected = process.env.MIKAMPUS_AGENT_TOKEN || agentToken();
  const actual = Buffer.from(String(req.headers['x-mikampus-agent-token'] || ''));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}

// Un apagado limpio cierra su evento; si el último quedó abierto hubo crash,
// reboot o suspensión larga. El watcher no "reproduce" ticks: deja la marca
// durable y el scheduler hará una única lectura fresca al arrancar.
export function recordRuntimeStart() {
  const previous = db.prepare('SELECT id, started_at FROM runtime_events WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1').get();
  const now = new Date().toISOString();
  if (previous) {
    db.prepare("UPDATE watchers SET status = 'monitoring-gap', pause_reason = ?, next_check_at = NULL WHERE status IN ('running', 'backing-off', 'monitoring-gap')")
      .run(`Agente no disponible desde ${previous.started_at}`);
    db.prepare('UPDATE runtime_events SET ended_at = ? WHERE id = ?').run(now, previous.id);
  }
  db.prepare("INSERT INTO runtime_events (kind, detail, started_at) VALUES ('agent', ?, ?)").run(previous ? 'reinicio con intervalo no vigilado' : 'inicio del agente', now);
  return { hadGap: Boolean(previous), startedAt: now };
}

export function recordRuntimeStop() {
  db.prepare("UPDATE runtime_events SET ended_at = ? WHERE kind = 'agent' AND ended_at IS NULL").run(new Date().toISOString());
}
