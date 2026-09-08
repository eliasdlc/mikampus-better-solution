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
  linkPvaOnLogin,
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
  logout,
  SESSION_COOKIE,
  CSRF_HEADER,
} = await import('../src/auth.js');
const { db } = await import('../src/db.js');
const {
  writeCredential,
  deleteCredential,
  readCredential,
  writePvaPassword,
  writePvaToken,
  readPvaToken,
  readPvaCredential,
  pvaAutolinkRejected,
  deletePvaCredential,
} = await import('../src/credentialStore.js');

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

// ── Cerrar sesión se lleva las dos fuentes ──
// El token de la PVA no caduca solo: si sobreviviera al logout seguiría
// valiendo contra la plataforma sin que nadie lo esté usando.
{
  writeCredential({ username: 'ana', password: 'clave-portal' });
  writePvaPassword('clave-pva');
  writePvaToken('token-de-prueba');
  const session = createSession(42);
  await logout(session.token);
  assert.equal(sessionFor(session.token), null, 'la sesión de mikampus queda revocada');
  assert.equal(readCredential(), null, 'y el portal vaciado');
  assert.equal(readPvaCredential(), null, 'la contraseña de la PVA también');
  assert.equal(readPvaToken(), null, 'y su token, que es lo único que seguiría valiendo solo');
}

// ── Entrar vincula las dos fuentes con una sola contraseña ──
// La guía de la PVA dice que sus credenciales son las de Campus Solutions, así
// que se prueba esa primero. Lo que el recon encontró es que para esta cuenta
// la PVA la rechaza, y ahí está el riesgo: reintentar en cada login contra un
// Moodle con bloqueo por intentos traba la cuenta sola.
{
  // Un sitio de mentira: acepta una sola contraseña y cuenta los intentos.
  const site = (aceptada) => {
    const intentos = { token: 0 };
    const fetchImpl = async (url, options) => {
      const params = new URLSearchParams(String(options?.body ?? ''));
      if (String(url).endsWith('/login/token.php')) {
        intentos.token += 1;
        const ok = params.get('password') === aceptada;
        return new Response(JSON.stringify(ok ? { token: 'token-pva' } : { error: 'Datos erróneos', errorcode: 'invalidlogin' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { intentos, fetchImpl };
  };

  // 1. Misma contraseña en las dos fuentes: entrar alcanza, no se pide nada dos veces.
  deleteCredential();
  deletePvaCredential();
  writeCredential({ username: 'ana', password: 'clave-unica' });
  const iguales = site('clave-unica');
  const primera = await linkPvaOnLogin({ username: 'ana', portalPassword: 'clave-unica', fetchImpl: iguales.fetchImpl });
  assert.deepEqual(
    { linked: primera.linked, mode: primera.mode },
    { linked: true, mode: 'misma' },
    'la contraseña del portal vinculó la PVA sin que nadie la escriba de nuevo'
  );
  assert.equal(readPvaCredential().password, 'clave-unica');
  assert.equal(pvaAutolinkRejected(), null, 'y no queda huella de rechazo');

  // 2. La PVA rechaza esa contraseña: se anota y NO se reintenta sola.
  deletePvaCredential();
  const distintas = site('otra-clave');
  const rechazo = await linkPvaOnLogin({ username: 'ana', portalPassword: 'clave-unica', fetchImpl: distintas.fetchImpl });
  assert.deepEqual(
    { linked: rechazo.linked, reason: rechazo.reason },
    { linked: false, reason: 'misma-clave-rechazada' },
    'la PVA dijo que no y el login sigue siendo válido igual'
  );
  assert.equal(distintas.intentos.token, 1);
  const segunda = await linkPvaOnLogin({ username: 'ana', portalPassword: 'clave-unica', fetchImpl: distintas.fetchImpl });
  assert.equal(segunda.reason, 'misma-clave-rechazada');
  assert.equal(distintas.intentos.token, 1, 'el segundo login NO gasta otro intento contra la cuenta');

  // 3. Cambiar la contraseña del portal habilita un intento nuevo: puede ser
  //    justo la resincronización que faltaba.
  const nueva = site('otra-clave');
  const tercera = await linkPvaOnLogin({ username: 'ana', portalPassword: 'otra-clave', fetchImpl: nueva.fetchImpl });
  assert.equal(tercera.linked, true, 'contraseña distinta, huella distinta, intento nuevo');
  assert.equal(nueva.intentos.token, 1);

  // 4. Con una contraseña propia de la PVA, esa manda y la huella se limpia.
  deletePvaCredential();
  const propia = site('clave-solo-pva');
  const cuarta = await linkPvaOnLogin({
    username: 'ana',
    portalPassword: 'clave-unica',
    pvaPassword: 'clave-solo-pva',
    fetchImpl: propia.fetchImpl,
  });
  assert.deepEqual({ linked: cuarta.linked, mode: cuarta.mode }, { linked: true, mode: 'propia' });
  assert.equal(readPvaCredential().password, 'clave-solo-pva');
}

await rm(dir, { recursive: true, force: true });
console.log('✓ auth: sesiones con hash + expiración, cookie SameSite, CSRF obligatorio en mutaciones, rate-limit de login, y una sola contraseña vincula las dos fuentes sin gastar intentos');
