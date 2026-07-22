import { db } from './db.js';

// Estado del producto que no es dato académico ni configuración de despliegue:
// el modo elegido en el onboarding, la última copia exitosa, la preferencia de
// update-check. Vive en la base y no en un archivo aparte para que `backup`,
// `restore` y `erase-data` lo cubran sin tener que acordarse de él.

export function readMeta(key, fallback = null) {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function writeMeta(key, value) {
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(key, String(value));
  return value;
}

export function readMetaJson(key, fallback = null) {
  const raw = readMeta(key);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeMetaJson(key, value) {
  writeMeta(key, JSON.stringify(value));
  return value;
}

export function deleteMeta(key) {
  db.prepare('DELETE FROM app_meta WHERE key = ?').run(key);
}
