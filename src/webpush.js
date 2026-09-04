import webpush from 'web-push';
import { db } from './db.js';

// Web Push (LANZAMIENTO §5.5): cuando abre un cupo, el teléfono suena aunque la
// app esté cerrada. Es gratis — VAPID + el service worker que la PWA ya tiene—
// y es la mitad accionable del watcher: sin push, "apareció cupo" muere en un
// feed que nadie mira a las 6am.
//
// Este módulo es el CANAL de envío, no la política. Qué merece una push (y con
// qué urgencia) lo decide notify.js, el mismo lugar que decide el popup de
// escritorio: un solo criterio para "esto interrumpe al usuario".

// ── Configuración VAPID ────────────────────────────────────────────────────
// Las llaves viven solo en el .env del server (la privada nunca sale de ahí; la
// pública se la damos al navegador para suscribirse). Sin llaves, el canal
// queda apagado; el feed local sigue funcionando.
const PUBLIC_KEY = process.env.MIKAMPUS_VAPID_PUBLIC || '';
const PRIVATE_KEY = process.env.MIKAMPUS_VAPID_PRIVATE || '';
// El subject identifica al remitente ante el push service (mailto: o una URL).
const SUBJECT = process.env.MIKAMPUS_VAPID_SUBJECT || 'mailto:admin@mikampus.decruce.dev';

export const configured = Boolean(PUBLIC_KEY && PRIVATE_KEY);
let warned = false;

if (configured) {
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
}

export function vapidPublicKey() {
  return configured ? PUBLIC_KEY : null;
}

// El transport es inyectable para que el test verifique poda y dedupe sin red
// (scripts/test-webpush.mjs). Por defecto, el envío real cifrado de web-push.
let transport = (subscription, payload, options) =>
  webpush.sendNotification(subscription, payload, options);

export function __setTransport(fn) {
  transport = fn;
}

// ── Almacén de suscripciones ────────────────────────────────────────────────
// Una fila por dispositivo. endpoint es la identidad (único global): el mismo
// teléfono re-suscribiéndose actualiza sus claves en vez de duplicar la push.

export function saveSubscription(userId, subscription, ua = null) {
  const { endpoint, keys } = subscription ?? {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    throw new Error('Suscripción de push incompleta (falta endpoint o claves)');
  }
  db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, ua)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id,
       p256dh  = excluded.p256dh,
       auth    = excluded.auth,
       ua      = excluded.ua`
  ).run(userId, endpoint, keys.p256dh, keys.auth, ua);
}

export function removeSubscription(userId, endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
}

export function subscriptionsFor(userId) {
  return db
    .prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?')
    .all(userId);
}

// ── Envío ───────────────────────────────────────────────────────────────────

// Un endpoint que el push service ya no reconoce (410 Gone / 404) está muerto:
// se poda en el acto para no volver a pagar un envío que nadie recibe.
function isGone(err) {
  return err?.statusCode === 404 || err?.statusCode === 410;
}

// Envía a TODOS los dispositivos de un usuario. Nunca lanza — la push es el
// accesorio, la operación que la disparó (un enroll, un watcher) no puede caerse
// porque un push service esté lento. Devuelve cuántos envíos salieron.
export async function sendPush(userId, { title, body = '', url = '/', tag, urgency = 'normal' } = {}) {
  if (!configured || process.env.MIKAMPUS_SILENT) return 0;
  const subs = subscriptionsFor(userId);
  if (subs.length === 0) return 0;

  const payload = JSON.stringify({ title, body, url, tag: tag ?? title });
  // Un cupo entregado una hora tarde no vale nada: crítico va con TTL corto y
  // prioridad alta para que el push service no lo encole. Lo informativo aguanta.
  const options = urgency === 'critical' ? { TTL: 600, urgency: 'high' } : { TTL: 3600, urgency: 'normal' };

  let sent = 0;
  for (const sub of subs) {
    const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    try {
      await transport(subscription, payload, options);
      db.prepare('UPDATE push_subscriptions SET last_ok_at = datetime(\'now\') WHERE id = ?').run(sub.id);
      sent++;
    } catch (err) {
      if (isGone(err)) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
      } else {
        console.warn(`[push] envío falló (endpoint ${sub.id}): ${err.statusCode ?? ''} ${err.message ?? err}`);
      }
    }
  }
  return sent;
}

// ── Dedupe por usuario ──────────────────────────────────────────────────────
// Independiente del dedupe de escritorio (notify.js): el popup local es de un
// solo usuario, la push es por dueño. La misma notificación repetida dentro de
// la ventana sale una vez por usuario, no 80 veces por hora si un watcher falla.
const DEDUPE_MS = 5 * 60 * 1000;
const lastSent = new Map(); // `${userId}:${key}` → timestamp

// Recibe la notificación ya resuelta por notify.js (título, cuerpo, urgencia,
// key de dedupe) y su evento de origen (para el deep-link). Fire-and-forget.
export function dispatchPush(userId, notice, event = {}, now = Date.now()) {
  if (!configured || process.env.MIKAMPUS_SILENT) return;
  const dedupeKey = `${userId}:${notice.key}`;
  const prev = lastSent.get(dedupeKey);
  if (prev != null && now - prev < DEDUPE_MS) return;
  lastSent.set(dedupeKey, now);

  sendPush(userId, {
    title: notice.title,
    body: notice.body,
    url: event.url ?? '/',
    tag: notice.key,
    urgency: notice.urgency,
  }).catch((err) => console.warn(`[push] dispatch falló: ${err.message}`));
}

// Para los tests: limpia el estado de dedupe entre casos.
export function __resetDedupe() {
  lastSent.clear();
}
