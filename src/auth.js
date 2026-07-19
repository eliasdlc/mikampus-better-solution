import crypto from 'node:crypto';
import { db } from './db.js';
import { ensureUser, touchLastLogin } from './users.js';
import { verifyPortalCredentials, adoptSession, resetSession } from './session.js';

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
    'SameSite=Lax',
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

// Hosted no es un directorio público de estudiantes. La lista se mantiene en
// el entorno de la instancia, nunca en la base de datos ni en el bundle web.
// Exigir que exista evita que publicar el DNS convierta por accidente la beta
// de 10–20 personas en una puerta abierta para toda la universidad.
export function isInvited(username) {
  if ((process.env.MIKAMPUS_MODE ?? 'local') !== 'hosted') return true;
  const invited = (process.env.MIKAMPUS_ALLOWLIST ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return invited.includes(String(username ?? '').trim().toLowerCase());
}

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
  if (!isInvited(user)) {
    throw Object.assign(new Error('Esta beta es solo por invitación'), { status: 403 });
  }
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
  const account = ensureUser(user);
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
// Modo hosted: toda /api exige sesión salvo las rutas públicas, y toda
// mutación exige además el CSRF header de esa sesión (la cookie viaja sola;
// el header solo lo puede poner nuestra página).
const PUBLIC_API = new Set(['/health', '/auth/login']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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
