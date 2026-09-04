// La capa de sesiones/CSRF de mikampus contra una DB desechable: emisión y
// verificación de sesión, expiración, revocación, cookie, rate-limit del
// login y el middleware completo (401 sin cookie, 403 sin CSRF en mutación).
// El flujo contra el portal vivo (loginWithPortal) no se prueba acá: eso es
// Playwright contra micampus, no una unidad.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-auth-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.MIKAMPUS_CREDENTIALS_FILE = path.join(dir, 'credenciales.env');

const {
  createSession,
  sessionFor,
  revokeSession,
  revokeAllSessions,
  purgeExpiredSessions,
  cookieValue,
  sessionCookieHeader,
  clearedSessionCookieHeader,
  loginBlocked,
  noteLoginFailure,
  noteLoginSuccess,
  authMiddleware,
  localRequestGuard,
  SESSION_COOKIE,
  CSRF_HEADER,
} = await import('../src/auth.js');
const { db } = await import('../src/db.js');
const { writeCredential, deleteCredential } = await import('../src/credentialStore.js');

// ── Sesión: ida y vuelta, y el token no se guarda en claro. ──
const s1 = createSession(42);
assert.ok(s1.token.length >= 40, 'el token es largo de verdad');
assert.deepEqual(sessionFor(s1.token), { userId: 42, csrfToken: s1.csrfToken });
assert.equal(sessionFor('token-inventado'), null, 'un token inventado no es nadie');
const stored = db.prepare('SELECT token_hash FROM sessions').all();
assert.ok(stored.every((r) => r.token_hash !== s1.token), 'en la DB vive el hash, no el token');

// ── Revocación individual y total. ──
revokeSession(s1.token);
assert.equal(sessionFor(s1.token), null, 'una sesión revocada no vale');
const s2 = createSession(42);
const s3 = createSession(42);
revokeAllSessions(42);
assert.equal(sessionFor(s2.token), null, 'revocar todo tumba la primera');
assert.equal(sessionFor(s3.token), null, 'y la segunda');

// ── Expiración con purga. ──
const s4 = createSession(7);
db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = 7').run(new Date(Date.now() - 1000).toISOString());
assert.equal(sessionFor(s4.token), null, 'una sesión vencida no vale');
assert.ok(purgeExpiredSessions() >= 1, 'la purga limpia lo vencido');

// ── Cookie: parseo y atributos. ──
const header = sessionCookieHeader('abc123', { secure: true });
assert.match(header, /HttpOnly/);
assert.match(header, /SameSite=Strict/);
assert.match(header, /Secure/);
assert.ok(!sessionCookieHeader('abc123', { secure: false }).includes('Secure'), 'sin Secure en local/http');
assert.match(clearedSessionCookieHeader({ secure: true }), /Max-Age=0/);
assert.equal(cookieValue(`otra=x; ${SESSION_COOKIE}=abc123; mas=y`, SESSION_COOKIE), 'abc123');
assert.equal(cookieValue(undefined, SESSION_COOKIE), null);

// ── Rate-limit: 5 fallos bloquean 15 minutos; el éxito limpia. ──
for (let i = 0; i < 4; i++) noteLoginFailure('elias');
assert.equal(loginBlocked('elias'), false, '4 fallos todavía no bloquean');
noteLoginFailure('elias');
assert.equal(loginBlocked('ELIAS'), true, 'el 5º fallo bloquea (case-insensitive)');
assert.equal(loginBlocked('elias', Date.now() + 16 * 60_000), false, 'a los 16 minutos se libera');
noteLoginFailure('ana');
noteLoginSuccess('ana');
for (let i = 0; i < 4; i++) noteLoginFailure('ana');
assert.equal(loginBlocked('ana'), false, 'el éxito reinicia el contador');

// ── Middleware: cookie del login Y credencial en el archivo, las dos. ──
// Sin credencial ninguna cookie vale; con credencial pero sin cookie tampoco se
// entra (la cookie solo la emite el formulario); una mutación exige CSRF.
const fakeRes = () => {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (code) => ((res.statusCode = code), res);
  res.json = (body) => ((res.body = body), res);
  res.set = (name, value) => ((res.headers[name] = value), res);
  return res;
};
const call = (req) => {
  const res = fakeRes();
  let passed = false;
  authMiddleware(req, res, () => (passed = true));
  return { res, passed, req };
};

let out = call({ path: '/grades', method: 'GET', headers: {} });
assert.equal(out.res.statusCode, 401, 'sin credencial guardada no se entra');

out = call({ path: '/health', method: 'GET', headers: {} });
assert.ok(out.passed, '/health es público');

writeCredential({ username: 'ana', password: 'secreta' });
out = call({ path: '/grades', method: 'GET', headers: {} });
assert.equal(out.res.statusCode, 401, 'con credencial pero sin cookie tampoco: la cookie la emite el formulario');

const live = createSession(1);
out = call({ path: '/grades', method: 'GET', headers: { cookie: `${SESSION_COOKIE}=${live.token}` } });
assert.ok(out.passed, 'con cookie del login y credencial en el archivo un GET pasa');
assert.equal(out.req.userId, 1, 'el middleware resuelve el dueño');

deleteCredential();
out = call({ path: '/grades', method: 'GET', headers: { cookie: `${SESSION_COOKIE}=${live.token}` } });
assert.equal(out.res.statusCode, 401, 'vaciar el archivo saca aunque la cookie siga vigente');
writeCredential({ username: 'ana', password: 'secreta' });

out = call({ path: '/cart/sync', method: 'POST', headers: { cookie: `${SESSION_COOKIE}=${live.token}` } });
assert.equal(out.res.statusCode, 403, 'una mutación sin CSRF header se rechaza');

out = call({
  path: '/cart/sync',
  method: 'POST',
  headers: { cookie: `${SESSION_COOKIE}=${live.token}`, [CSRF_HEADER]: live.csrfToken },
});
assert.ok(out.passed, 'con cookie + CSRF la mutación pasa');

// ── Frontera loopback: Host y Origin ajenos se rechazan antes de auth. ──
const guard = (req) => {
  const res = fakeRes();
  let passed = false;
  localRequestGuard(req, res, () => (passed = true));
  return { res, passed };
};
assert.ok(guard({ method: 'GET', headers: { host: 'localhost:4173' } }).passed, 'localhost es válido');
assert.equal(guard({ method: 'GET', headers: { host: '192.168.1.5:4173' } }).res.statusCode, 421, 'la LAN no entra');
assert.equal(
  guard({ method: 'POST', headers: { host: 'localhost:4173', origin: 'https://evil.example' } }).res.statusCode,
  403,
  'un origen web ajeno no puede mutar localhost'
);
assert.equal(
  guard({ method: 'POST', headers: { host: 'localhost:4173' } }).res.statusCode,
  403,
  'una mutación sin Origin tampoco puede usar localhost como puente'
);
assert.ok(
  guard({ method: 'POST', headers: { host: 'localhost:4173', origin: 'http://localhost:4173' } }).passed,
  'la SPA local conserva acceso'
);

// ── Hosts de confianza: el proxy de identidad entra, el resto no. ──
// Lo que se protege: que declarar un host para el proxy de identidad no se
// convierta sin querer en "cualquiera puede hablarle al agente". El Host pasa a
// estar permitido; el Origin sigue teniendo que coincidir, que es lo que
// impide que un sitio ajeno mute nada.
// El .env del equipo puede tener hosts declarados; esta prueba fija los suyos
// para no depender de cómo esté configurada la máquina que la corre.
delete process.env.MIKAMPUS_TRUSTED_HOSTS;
assert.equal(
  guard({ method: 'GET', headers: { host: 'proxy.example.net' } }).res.statusCode,
  421,
  'sin declararlo, el hostname del proxy es un desconocido más'
);

process.env.MIKAMPUS_TRUSTED_HOSTS = 'proxy.example.net';
assert.ok(
  guard({ method: 'GET', headers: { host: 'proxy.example.net' } }).passed,
  'declarado, el host de confianza entra'
);
assert.ok(
  guard({ method: 'GET', headers: { host: 'Proxy.Example.Net' } }).passed,
  'y la comparación no depende de mayúsculas'
);
assert.ok(
  guard({ method: 'POST', headers: { host: 'proxy.example.net', origin: 'https://proxy.example.net' } }).passed,
  'la SPA servida por el proxy puede mutar'
);
assert.equal(
  guard({ method: 'POST', headers: { host: 'proxy.example.net', origin: 'https://evil.example' } }).res.statusCode,
  403,
  'pero un origen ajeno sigue sin poder, aunque el Host sea de confianza'
);
assert.equal(
  guard({ method: 'GET', headers: { host: 'otro.example.net' } }).res.statusCode,
  421,
  'declarar un host no habilita a sus vecinos del mismo dominio'
);
assert.equal(
  guard({ method: 'GET', headers: { host: '192.168.1.5:4173' } }).res.statusCode,
  421,
  'y la LAN sigue afuera'
);
process.env.MIKAMPUS_TRUSTED_HOSTS = '';

await rm(dir, { recursive: true, force: true });
console.log('✓ auth: sesiones con hash + expiración, cookie SameSite, CSRF obligatorio en mutaciones, rate-limit de login');
