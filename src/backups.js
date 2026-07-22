import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { db } from './db.js';
import { dataPaths } from './paths.js';
import { readMeta, writeMeta } from './appMeta.js';
import { SCHEMA_VERSION } from './migrations.js';

const BACKUP_DIR = dataPaths().backups;
const BACKUP_AT = process.env.MIKAMPUS_BACKUP_AT || '03:30';
const DEFAULT_KEEP = Math.max(1, Number(process.env.MIKAMPUS_BACKUP_KEEP || 7));
// Copias pre-upgrade: son el camino de retorno de una migración, no una serie
// histórica. Con las últimas tres alcanza para volver de un upgrade malo.
const KEEP_PRE_UPGRADE = 3;
const INTERVAL_MS = 24 * 60 * 60_000;
const LAST_KEY = 'backup.lastSuccessfulAt';
const KEEP_KEY = 'backup.keep';
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

// La retención es del usuario, no del entorno: se puede cambiar desde Ajustes y
// sobrevive a un reinicio. El env sigue siendo el valor inicial.
export function retention() {
  const stored = Number(readMeta(KEEP_KEY));
  return Number.isInteger(stored) && stored >= 1 ? stored : DEFAULT_KEEP;
}

export function setRetention(keep) {
  const value = Number(keep);
  if (!Number.isInteger(value) || value < 1) throw new Error('La retención tiene que ser un entero mayor que cero');
  writeMeta(KEEP_KEY, value);
  rotateBackups();
  return value;
}

export function lastSuccessfulBackupAt() {
  return readMeta(LAST_KEY);
}

export function rotateBackups(directory = BACKUP_DIR, keep = retention()) {
  if (!fs.existsSync(directory)) return [];
  const removed = [];
  const groups = [
    [/^mikampus-\d{4}-\d{2}-\d{2}\.sqlite$/, keep],
    [/^pre-upgrade-v\d+-.*\.sqlite$/, KEEP_PRE_UPGRADE],
  ];
  for (const [pattern, limit] of groups) {
    const files = fs.readdirSync(directory).filter((name) => pattern.test(name)).sort().reverse();
    for (const name of files.slice(limit)) {
      const target = path.join(directory, name);
      fs.unlinkSync(target);
      removed.push(target);
    }
  }
  return removed;
}

// Una copia sirve si SQLite la puede abrir, pasa integrity_check y su esquema
// lo entiende esta versión. Verificarlo al crearla convierte "tengo backups" en
// "tengo backups que restauran": lo primero es una carpeta, lo segundo es una
// garantía.
export function verifyBackup(file) {
  if (!fs.existsSync(file)) throw new Error(`No existe el archivo de copia ${file}`);
  const probe = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = probe.prepare('PRAGMA integrity_check').get();
    if (integrity.integrity_check !== 'ok') {
      throw new Error(`La copia no pasó integrity_check: ${integrity.integrity_check}`);
    }
    const schema = Number(probe.prepare('PRAGMA user_version').get().user_version ?? 0);
    if (schema > SCHEMA_VERSION) {
      throw new Error(`La copia usa el esquema ${schema} y esta versión entiende hasta el ${SCHEMA_VERSION}`);
    }
    const tables = probe
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .get().n;
    if (tables === 0) throw new Error('La copia no contiene ninguna tabla');
    return { file, schema, tables, bytes: fs.statSync(file).size };
  } finally {
    probe.close();
  }
}

// VACUUM INTO usa la API de backup consistente de SQLite: incluye el WAL y no
// copia un archivo a mitad de una escritura. El destino es nuevo o se reutiliza
// la copia del mismo día; nunca toca la DB principal.
export function createBackup({ now = new Date(), directory = BACKUP_DIR, keep = retention() } = {}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `mikampus-${stamp(now)}.sqlite`);
  if (!fs.existsSync(target)) db.exec(`VACUUM INTO ${sqlString(target)}`);
  // Una copia que no se verifica no se registra como exitosa: si no, el próximo
  // catch-up creería que ya hay respaldo del día y no volvería a intentarlo.
  verifyBackup(target);
  writeMeta(LAST_KEY, now.toISOString());
  rotateBackups(directory, keep);
  return target;
}

export function listBackups(directory = BACKUP_DIR) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.sqlite'))
    .map((name) => {
      const stats = fs.statSync(path.join(directory, name));
      return {
        name,
        path: path.join(directory, name),
        bytes: stats.size,
        at: new Date(stats.mtimeMs).toISOString(),
        kind: name.startsWith('pre-upgrade-') ? 'pre-upgrade' : 'daily',
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

// Exportar es la única forma de que una copia salga del disco de la app. No se
// automatiza a ninguna nube: el destino lo elige la persona.
export function exportBackup(targetDir, { now = new Date() } = {}) {
  if (!targetDir) throw new Error('Indicá la carpeta destino de la exportación');
  const resolved = path.resolve(targetDir);
  fs.mkdirSync(resolved, { recursive: true });
  const source = createBackup({ now });
  const target = path.join(resolved, path.basename(source));
  fs.copyFileSync(source, target);
  const verified = verifyBackup(target);
  return { ...verified, sameDisk: path.parse(resolved).root === path.parse(BACKUP_DIR).root };
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

// El equipo estuvo apagado a las 3:30 y el timer nunca corrió. La copia no se
// decide solo por reloj de pared: se compara contra la última copia exitosa,
// igual que el watcher se compara contra su lastCheckedAt.
export function backupIsDue(now = new Date(), lastAt = lastSuccessfulBackupAt()) {
  if (!lastAt) return true;
  const last = new Date(lastAt).getTime();
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= INTERVAL_MS;
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

export function startBackupCron({ now = new Date() } = {}) {
  if (backupIsDue(now)) {
    try {
      const target = createBackup({ now });
      console.log(`[backup] copia al arrancar (se había atrasado): ${target}`);
    } catch (error) {
      console.warn(`[backup] no se pudo hacer la copia de catch-up: ${error.message}`);
    }
  }
  const next = schedule();
  if (next) console.log(`[backup] próxima copia: ${next.toLocaleString('es-DO')}`);
  else console.warn(`[backup] MIKAMPUS_BACKUP_AT="${BACKUP_AT}" no es válida; backups apagados`);
  return next;
}

export function stopBackupCron() {
  clearTimeout(timer);
  timer = null;
}

export function backupState(now = new Date()) {
  return {
    lastSuccessfulAt: lastSuccessfulBackupAt(),
    nextRunAt: nextBackupRun(now)?.toISOString() ?? null,
    due: backupIsDue(now),
    keep: retention(),
    directory: BACKUP_DIR,
    copies: listBackups(),
    // El aviso no es decorativo: una copia en el mismo disco no sobrevive a un
    // robo, un incendio ni a un disco que muere. La UI lo muestra siempre.
    sameDiskWarning:
      'Las copias viven en el mismo disco que tus datos: no protegen de robo, daño físico ni de un disco que muere. Exportá a otro disco si querés esa cobertura.',
  };
}
