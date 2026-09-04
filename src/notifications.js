import { db } from './db.js';

// El feed de notificaciones, durable (Fase 4 §4). Antes el dedupe vivía en un
// Map del proceso: cada reinicio del agente volvía a emitir la misma alerta, y
// nada podía decir "esto ya te lo avisé ayer". Ahora la decisión de interrumpir
// se toma contra la base, que es lo único que sobrevive a un reboot.

export const DEDUPE_MS = 5 * 60 * 1000;

export function lastSentAt(key) {
  const row = db.prepare('SELECT created_at FROM notifications WHERE key = ? ORDER BY id DESC LIMIT 1').get(key);
  return row?.created_at ?? null;
}

// Las filas escritas por el runtime llevan ISO con zona; el DEFAULT de SQLite
// escribe "YYYY-MM-DD HH:MM:SS" en UTC sin marcarla. Se aceptan ambas para que
// una fila vieja no reviva una notificación ya enviada.
function parseTimestamp(value) {
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  return new Date(normalized).getTime();
}

export function shouldSend(key, now = Date.now(), windowMs = DEDUPE_MS) {
  const previous = lastSentAt(key);
  if (!previous) return true;
  const at = parseTimestamp(previous);
  if (Number.isNaN(at)) return true;
  return now - at >= windowMs;
}

// Se guarda SIEMPRE, se envíe o no: el feed es el registro de lo que pasó, y el
// dedupe solo decide si además interrumpe con un popup.
export function recordNotification(notice, { userId = null, now = new Date() } = {}) {
  const info = db
    .prepare(
      `INSERT INTO notifications (user_id, key, title, body, urgency, link, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(userId, notice.key, notice.title, notice.body ?? '', notice.urgency ?? 'normal', notice.link ?? null, now.toISOString());
  return Number(info.lastInsertRowid);
}

export function readFeed(userId, limit = 50) {
  return db
    .prepare(
      `SELECT id, key, title, body, urgency, link, created_at AS createdAt, read_at AS readAt
       FROM notifications
       WHERE user_id IS NULL OR user_id = ?
       ORDER BY id DESC LIMIT ?`
    )
    .all(userId, limit);
}

export function markFeedRead(userId, now = new Date()) {
  return db
    .prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND (user_id IS NULL OR user_id = ?)')
    .run(now.toISOString(), userId).changes;
}

export function unreadCount(userId) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL AND (user_id IS NULL OR user_id = ?)')
    .get(userId).n;
}

export function clearNotifications() {
  db.exec('DELETE FROM notifications');
}
