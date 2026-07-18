import fs from 'node:fs';
import path from 'node:path';
import { db, DB_PATH } from './db.js';

const BACKUP_DIR = process.env.MIKAMPUS_BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
const BACKUP_AT = process.env.MIKAMPUS_BACKUP_AT || '03:30';
const KEEP = Math.max(1, Number(process.env.MIKAMPUS_BACKUP_KEEP || 7));
let timer = null;

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function stamp(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function rotateBackups(directory = BACKUP_DIR, keep = KEEP) {
  if (!fs.existsSync(directory)) return [];
  const files = fs
    .readdirSync(directory)
    .filter((name) => /^mikampus-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name))
    .sort()
    .reverse();
  const removed = [];
  for (const name of files.slice(keep)) {
    const target = path.join(directory, name);
    fs.unlinkSync(target);
    removed.push(target);
  }
  return removed;
}

// VACUUM INTO usa la API de backup consistente de SQLite: incluye el WAL y no
// copia un archivo a mitad de una escritura. El destino es nuevo o se reutiliza
// la copia del mismo día; nunca toca la DB principal.
export function createBackup({ now = new Date(), directory = BACKUP_DIR, keep = KEEP } = {}) {
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `mikampus-${stamp(now)}.sqlite`);
  if (!fs.existsSync(target)) db.exec(`VACUUM INTO ${sqlString(target)}`);
  rotateBackups(directory, keep);
  return target;
}

function parseAt(raw) {
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

export function nextBackupRun(now = new Date(), rawAt = BACKUP_AT) {
  const at = parseAt(rawAt);
  if (!at) return null;
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), at.hour, at.minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

function schedule() {
  const next = nextBackupRun();
  if (!next) return null;
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      const target = createBackup();
      console.log(`[backup] copia local: ${target}`);
    } catch (error) {
      console.warn(`[backup] falló la copia local: ${error.message}`);
    }
    schedule();
  }, next.getTime() - Date.now());
  return next;
}

export function startBackupCron() {
  const next = schedule();
  if (next) console.log(`[backup] próxima copia: ${next.toLocaleString('es-DO')}`);
  else console.warn(`[backup] MIKAMPUS_BACKUP_AT="${BACKUP_AT}" no es válida; backups apagados`);
  return next;
}

export function stopBackupCron() {
  clearTimeout(timer);
  timer = null;
}
