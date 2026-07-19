import { db } from './db.js';

// Ciclo de vida de usuarios (Fase 2 de LANZAMIENTO.md). La identidad es el
// username del portal — mikampus no inventa cuentas paralelas. El usuario 1 es
// especial solo por historia: la migración adoptó como suyos los datos de la
// era single-user, y en modo local sigue siendo el único.

export const LOCAL_USER_ID = 1;

export function getUser(id) {
  return db
    .prepare('SELECT id, portal_username AS portalUsername, created_at AS createdAt, last_login_at AS lastLoginAt FROM users WHERE id = ?')
    .get(id) ?? null;
}

export function getUserByUsername(portalUsername) {
  return db
    .prepare('SELECT id, portal_username AS portalUsername FROM users WHERE portal_username = ? COLLATE NOCASE')
    .get(portalUsername) ?? null;
}

// El usuario de un username del portal, creándolo si es su primer login. El
// usuario 1 sin username reclama el primero que llegue SOLO en modo local
// (adoptLocalUsername); acá un username desconocido siempre es un usuario nuevo.
export function ensureUser(portalUsername) {
  const username = String(portalUsername ?? '').trim();
  if (!username) throw new Error('ensureUser necesita el username del portal');
  const existing = getUserByUsername(username);
  if (existing) return existing;
  const { lastInsertRowid } = db.prepare('INSERT INTO users (portal_username) VALUES (?)').run(username);
  return getUser(Number(lastInsertRowid));
}

export function touchLastLogin(userId) {
  db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(userId);
}

// Modo local: la cuenta configurada (.env / account.json) ES el usuario 1. Se
// llama al arrancar el server para que la fila migrada deje de ser anónima; si
// el username ya pertenece a otra fila (no debería pasar en local), no se pisa.
export function adoptLocalUsername(portalUsername) {
  const username = String(portalUsername ?? '').trim();
  if (!username) return;
  const owner = getUserByUsername(username);
  if (owner && owner.id !== LOCAL_USER_ID) return;
  db.prepare('UPDATE users SET portal_username = ? WHERE id = ?').run(username, LOCAL_USER_ID);
}
