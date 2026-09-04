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

export function touchLastLogin(userId) {
  db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(userId);
}

// La instalación local tiene una sola identidad persistida (fila 1). Si se
// inicia sesión con otra cuenta, esa identidad se reemplaza en vez de crear un
// segundo espacio de datos.
export function adoptLocalUsername(portalUsername) {
  const username = String(portalUsername ?? '').trim();
  if (!username) return;
  db.prepare('UPDATE users SET portal_username = ? WHERE id = ?').run(username, LOCAL_USER_ID);
}
