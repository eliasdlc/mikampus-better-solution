import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dataPaths } from '../paths.js';
import { SCHEMA_VERSION } from '../migrations.js';
import { assertReadable, READ_ALLOWLIST } from './allowlist.js';

// La conexión del carril de LECTURA del MCP.
//
// Deliberadamente NO importa src/db.js: esa conexión es de escritura, corre las
// migraciones al importarse y es del agente. Acá abrimos el mismo archivo por
// separado y le sacamos la capacidad de escribir a nivel de SQLite, así una
// herramienta de lectura no puede corromper nada ni siquiera por un bug.
//
// Dos cierres, no uno:
//   readOnly            el archivo se abre sin permiso de escritura.
//   PRAGMA query_only   SQLite rechaza toda escritura aunque el handle pudiera.
// El segundo existe porque readOnly puede fallar cuando hay un -wal que
// necesita recuperación y no se puede crear el -shm; en ese caso caemos a una
// apertura normal, pero query_only sigue siendo absoluto.

let handle = null;
let openedReadOnly = false;
const schemaCache = new Map();

export function openReadOnlyDatabase(file = dataPaths().db) {
  if (!fs.existsSync(file)) {
    const error = new Error(`No encontré la base de mikampus en ${file}. Arrancá mikampus al menos una vez.`);
    error.code = 'MIKAMPUS_DB_MISSING';
    throw error;
  }
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    openedReadOnly = true;
  } catch {
    db = new DatabaseSync(file);
    openedReadOnly = false;
  }
  db.exec('PRAGMA query_only = ON');
  return db;
}

export function readDb() {
  if (!handle) handle = openReadOnlyDatabase();
  return handle;
}

export function closeReadDb() {
  if (!handle) return;
  handle.close();
  handle = null;
  schemaCache.clear();
}

export function connectionMode() {
  readDb();
  return openedReadOnly ? 'readOnly+query_only' : 'query_only';
}

// El esquema de la base puede ser más nuevo que el binario que la lee (el
// agente migró, este proceso es de un release anterior). No se adivina: una
// lectura contra columnas que no existen es peor que un error claro.
export function assertSchemaReadable() {
  const found = readDb().prepare('PRAGMA user_version').get().user_version;
  if (found > SCHEMA_VERSION) {
    throw new Error(
      `La base está en esquema ${found} y este mikampus-mcp entiende hasta ${SCHEMA_VERSION}. Actualizá mikampus.`
    );
  }
  return found;
}

// La base local evoluciona por migraciones, así que una tabla o una columna
// puede no existir todavía. Preguntarlo es la diferencia entre "no hay dato" y
// "reventó la consulta".
export function hasTable(table) {
  const key = `t:${table}`;
  if (!schemaCache.has(key)) {
    const row = readDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    schemaCache.set(key, Boolean(row));
  }
  return schemaCache.get(key);
}

export function hasColumn(table, column) {
  const key = `c:${table}.${column}`;
  if (!schemaCache.has(key)) {
    if (!hasTable(table)) schemaCache.set(key, false);
    else {
      const columns = readDb().prepare(`PRAGMA table_info(${table})`).all();
      schemaCache.set(key, columns.some((entry) => entry.name === column));
    }
  }
  return schemaCache.get(key);
}

// Toda lectura del MCP entra por acá: la consulta se valida contra la allowlist
// antes de prepararse, así la lista de src/mcp/allowlist.js no es documentación
// sino el filtro real.
export function readRows(sql, params = [], aliases = {}) {
  assertReadable(sql, aliases);
  return readDb().prepare(sql).all(...params);
}

export function readRow(sql, params = [], aliases = {}) {
  assertReadable(sql, aliases);
  return readDb().prepare(sql).get(...params) ?? null;
}

// Solo para el test de aislamiento: confirma que la conexión rechaza escribir.
export function attemptWrite() {
  readDb().exec('CREATE TABLE mcp_should_never_exist (x INTEGER)');
}

export const ALLOWED_TABLES = Object.keys(READ_ALLOWLIST);
