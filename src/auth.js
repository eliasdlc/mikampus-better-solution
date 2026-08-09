import crypto from 'node:crypto';
import { db, deleteAllUserData } from './db.js';
import { LOCAL_USER_ID, adoptLocalUsername, getUser, touchLastLogin } from './users.js';
import { verifyPortalCredentials, adoptSession, resetSession } from './session.js';
import { deleteCredential } from './credentialVault.js';

// El login de mikampus ES el login del portal (§5): no hay cuenta paralela.
// El estudiante entra con sus credenciales de micampus, mikampus las verifica
// logueándose a PeopleSoft, y recién ahí crea/encuentra el usuario y le emite
// una sesión propia por cookie. La contraseña queda en RAM atada a su context
// (regla 1 de §5) — nunca en la DB principal.

export const SESSION_COOKIE = 'mikampus_session';
export const CSRF_HEADER = 'x-csrf-token';
const SESSION_DAYS = 30;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// ── Sesiones ───────────────────────────────────────────────────────────────

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrfToken = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)').run(
    sha256(token), userId, csrfToken, expiresAt
  );
  return { token, csrfToken, expiresAt };
}

export function sessionFor(token) {
  if (!token) return null;
  const row = db
    .prepare('SELECT user_id, csrf_token, expires_at, revoked_at FROM sessions WHERE token_hash = ?')
    .get(sha256(token));
  if (!row || row.revoked_at || row.expires_at <= new Date().toISOString()) return null;
  return { userId: row.user_id, csrfToken: row.csrf_token };
}

export function revokeSession(token) {
  if (!token) return;
  db.prepare(`UPDATE sessions SET revoked_at = datetime('now') WHERE token_hash = ?`).run(sha256(token));
}

// Cambio de contraseña detectado en el portal → afuera TODAS las sesiones de
// mikampus de ese usuario (§5). También lo usa "Borrar mis datos".
export function revokeAllSessions(userId) {
  db.prepare(`UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL`).run(userId);
}

export function purgeExpiredSessions() {
  return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString()).changes;
}

// ── Cookies (sin dependencia: solo necesitamos leer la nuestra) ────────────

export function cookieValue(cookieHeader, name) {
  for (const part of (cookieHeader ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function sessionCookieHeader(token, { secure, maxAgeSeconds = SESSION_DAYS * 86400 } = {}) {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearedSessionCookieHeader({ secure } = {}) {
  return sessionCookieHeader('', { secure, maxAgeSeconds: 0 });
}

// ── Rate-limit de intentos (§5): PeopleSoft bloquea cuentas por intentos
// fallidos — mikampus no puede ser el vector. Por username, en memoria: 5
// fallos → 15 minutos de espera. Un login exitoso limpia el contador.
const attempts = new Map(); // usernameLower → { count, blockedUntil }
const MAX_ATTEMPTS = 5;
const BLOCK_MS = 15 * 60_000;

export function loginBlocked(username, now = Date.now()) {
  const entry = attempts.get(username.toLowerCase());
  if (!entry) return false;
  if (entry.blockedUntil && entry.blockedUntil > now) return true;
  if (entry.blockedUntil && entry.blockedUntil <= now) attempts.delete(username.toLowerCase());
  return false;
}

export function noteLoginFailure(username, now = Date.now()) {
  const key = username.toLowerCase();
  const entry = attempts.get(key) ?? { count: 0, blockedUntil: null };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) entry.blockedUntil = now + BLOCK_MS;
  attempts.set(key, entry);
}

export function noteLoginSuccess(username) {
  attempts.delete(username.toLowerCase());
}

// ── El flujo de login completo ─────────────────────────────────────────────
// Verifica contra el portal, crea/encuentra el usuario, adopta el context ya
// logueado (el primer sync no paga un segundo signon) y emite la sesión.
export async function loginWithPortal({ username, password }) {
  const user = String(username ?? '').trim();
  if (!user || !password) throw Object.assign(new Error('Faltan usuario o contraseña'), { status: 400 });
  if (loginBlocked(user)) {
    throw Object.assign(
      new Error('Demasiados intentos fallidos: esperá 15 minutos antes de reintentar'),
      { status: 429 }
    );
  }

  let live;
  try {
    live = await verifyPortalCredentials({ username: user, password });
  } catch (err) {
    if (err.credentialRejected) {
      noteLoginFailure(user);
      throw Object.assign(new Error('El portal rechazó ese usuario o contraseña'), { status: 401 });
    }
    // Timeout o portal caído: no es culpa de la credencial, no cuenta intento.
    throw Object.assign(new Error(`No se pudo verificar contra micampus: ${err.message}`), { status: 502 });
  }

  noteLoginSuccess(user);
  // Esta distribución solo tiene un operador. Reutilizar siempre la identidad
  // local evita que una segunda cuenta del portal cree un segundo espacio de
  // datos en la misma instalación.
  const previous = getUser(LOCAL_USER_ID);
  // Una instalación representa a una sola persona. Cambiar de cuenta no crea
  // un segundo espacio ni deja una autorización desatendida de la anterior.
  // El context nuevo todavía no se adoptó, así que cortar el anterior acá no
  // interrumpe la verificación que acabamos de completar.
  if (previous?.portalUsername && previous.portalUsername.toLowerCase() !== user.toLowerCase()) {
    deleteCredential(LOCAL_USER_ID);
    revokeAllSessions(LOCAL_USER_ID);
    await resetSession(LOCAL_USER_ID);
    // Los datos académicos pertenecen a la cuenta anterior. Antes de adoptar
    // la nueva identidad se purgan completos; recreamos únicamente el registro
    // local fijo que representa esta instalación.
    deleteAllUserData(LOCAL_USER_ID);
    db.prepare('INSERT OR IGNORE INTO users (id) VALUES (?)').run(LOCAL_USER_ID);
  }
  adoptLocalUsername(user);
  const account = getUser(LOCAL_USER_ID);
  touchLastLogin(account.id);
  await adoptSession(account.id, live, { username: user, password });
  const session = createSession(account.id);
  return { user: account, ...session };
}

export async function logout(token) {
  const session = sessionFor(token);
  revokeSession(token);
  if (session) await resetSession(session.userId);
}

// ── Middleware ─────────────────────────────────────────────────────────────
// Toda /api exige sesión salvo las rutas públicas, y toda mutación exige CSRF.
// El onboarding es público por necesidad: elegir modo, ver prerequisitos e
// instalar el browser ocurre ANTES de que exista una cuenta que autenticar. No
// devuelve ni acepta datos académicos, y sigue detrás de localRequestGuard
// (loopback + Origin), igual que el propio login.
const PUBLIC_API = new Set([
  '/health',
  '/auth/login',
  '/onboarding',
  '/onboarding/mode',
  '/onboarding/browser',
]);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Hosts que este agente acepta ADEMÁS de loopback, separados por coma. Vacío
// por defecto, y esa es la postura: dejar de ser solo-loopback es una decisión
// explícita del operador, nunca un default que se hereda sin querer.
//
// Está pensado para un proxy de identidad en el mismo equipo —`tailscale serve`
// es el caso— que termina TLS, autentica el dispositivo contra el tailnet y
// reenvía a 127.0.0.1. La diferencia con abrir el puerto es real: el agente
// nunca deja de escuchar solo en loopback, así que no hay superficie nueva en
// la red; lo único que cambia es qué `Host` se considera legítimo.
//
// Se lee por request y no una sola vez, para que el operador pueda corregir un
// hostname mal escrito reiniciando el servicio y no rebuildeando nada.
function trustedHosts() {
  return new Set(
    String(process.env.MIKAMPUS_TRUSTED_HOSTS ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

// El agente sirve loopback y, si el operador lo declaró, los hosts de confianza.
// Validamos Host en todas las requests y Origin en las mutaciones, incluso antes
// del login: así una página ajena no puede usar localhost como puente hacia
// PeopleSoft ni intentar fijar sesión.
export function localRequestGuard(req, res, next) {
  const host = String(req.headers.host ?? '').toLowerCase();
  const loopback = /^((localhost|127\.0\.0\.1)(:\d+)?)$/.test(host);
  // El puerto no distingue confianza: el proxy llega sin él o con el suyo.
  const hostname = host.replace(/:\d+$/, '');
  if (!loopback && !trustedHosts().has(hostname)) {
    return res.status(421).json({ error: 'mikampus solo acepta requests desde localhost' });
  }
  if (!SAFE_METHODS.has(req.method)) {
    const origin = req.headers.origin;
    // Las mutaciones de la SPA siempre llevan Origin. Exigirlo evita que un
    // form/navegación cross-site use localhost como puente, incluso en rutas
    // públicas como el login que todavía no tienen token CSRF.
    //
    // Sigue siendo igualdad estricta contra el Host de ESTA request: un sitio
    // ajeno no puede fabricar Origin, así que agregar un host de confianza no
    // afloja la protección CSRF. Los dos esquemas se aceptan porque loopback es
    // http y el proxy de identidad es https.
    if (origin !== `http://${host}` && origin !== `https://${host}`) {
      return res.status(403).json({ error: 'El origen de esta operación no está autorizado' });
    }
  }
  next();
}

export function authMiddleware(req, res, next) {
  if (PUBLIC_API.has(req.path)) return next();

  const token = cookieValue(req.headers.cookie, SESSION_COOKIE);
  const session = sessionFor(token);
  if (!session) return res.status(401).json({ error: 'Sesión inválida o vencida: iniciá sesión' });

  if (!SAFE_METHODS.has(req.method) && req.headers[CSRF_HEADER] !== session.csrfToken) {
    return res.status(403).json({ error: 'Falta o no coincide el token CSRF' });
  }

  req.userId = session.userId;
  req.sessionToken = token;
  next();
}
