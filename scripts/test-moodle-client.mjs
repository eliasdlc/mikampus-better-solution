// El cliente de los Web Services de la PVA contra fixtures, sin red: los tres
// sobres que devuelve Moodle, las excepciones que llegan con HTTP 200, el
// aplanado de parámetros, los reintentos, el tope de llamadas en vuelo y la
// regla de que el token no aparece en ninguna parte que se pueda loguear.
//
// Los fixtures salen de los volcados del recon, sanitizados: conservan la forma
// exacta y ningún dato de nadie (docs/fixtures-policy.md).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const {
  createMoodleClient,
  requestToken,
  flattenParams,
  classifyErrorCode,
  redactToken,
  MoodleError,
  MOODLE_SERVICE,
} = await import('../src/moodle/client.js');

const fixture = async (name) => JSON.parse(await readFile(`fixtures/${name}`, 'utf8'));
const siteInfo = await fixture('pva-site-info.json');
const courses = await fixture('pva-courses.json');
const assignments = await fixture('pva-assignments.json');
const noPermission = await fixture('pva-error-nopermission.json');

const SITE = 'https://campusvirtual.pucmm.edu.do/moodle';
const TOKEN = 'token-sintetico-de-prueba';

const json = (body, { status = 200, headers = {} } = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// Un fetch de mentira que registra cada llamada y contesta lo que le digan.
function recorder(responses) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, init) => {
    const body = new URLSearchParams(init.body);
    calls.push({ url, method: init.method, body, headers: init.headers });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === 'function') return next(calls.length);
    return next;
  };
  return { fetchImpl, calls };
}

const client = (responses, options = {}) => {
  const { fetchImpl, calls } = recorder(responses);
  return {
    calls,
    api: createMoodleClient({ siteUrl: SITE, token: TOKEN, fetchImpl, sleep: async () => {}, random: () => 0, ...options }),
  };
};

// ── Parámetros aplanados al estilo Moodle ─────────────────────────────────
{
  const params = flattenParams({
    courseids: [800101, 800202],
    options: [{ name: 'excludemodules', value: true }],
    since: 0,
    userid: 90001,
    ausente: null,
    tampoco: undefined,
    apagado: false,
  });
  assert.equal(params.get('courseids[0]'), '800101', 'un arreglo va indexado');
  assert.equal(params.get('courseids[1]'), '800202');
  assert.equal(params.get('options[0][name]'), 'excludemodules', 'un objeto adentro de un arreglo también');
  assert.equal(params.get('options[0][value]'), '1', 'true viaja como 1: PHP considera verdadera la cadena "false"');
  assert.equal(params.get('apagado'), '0', 'y false como 0');
  assert.equal(params.get('since'), '0', 'el 0 es un valor, no una ausencia');
  assert.equal(params.has('ausente'), false, 'null no se manda');
  assert.equal(params.has('tampoco'), false, 'undefined tampoco');
}

// ── Los tres sobres, y el token donde tiene que ir ────────────────────────
{
  const { api, calls } = client([json(courses)]);
  const data = await api.call('core_enrol_get_users_courses', { userid: 90001 });
  assert.ok(Array.isArray(data) && data.length === 2, 'el arreglo pelado vuelve tal cual');

  const [call] = calls;
  assert.equal(call.url, `${SITE}/webservice/rest/server.php`, 'el endpoint sale de siteurl, con su subruta');
  assert.equal(call.method, 'POST');
  assert.equal(call.url.includes(TOKEN), false, 'el token NUNCA va en la URL');
  assert.equal(call.body.get('wstoken'), TOKEN, 'va en el cuerpo');
  assert.equal(call.body.get('wsfunction'), 'core_enrol_get_users_courses');
  assert.equal(call.body.get('moodlewsrestformat'), 'json');
  assert.equal(call.body.get('userid'), '90001');
}
{
  const { api } = client([json(assignments)]);
  const data = await api.call('mod_assign_get_assignments', { courseids: [800101] });
  assert.equal(data.courses[0].assignments[0].id, 900001, 'el objeto con warnings vuelve entero');
  assert.equal(data.warnings.length, 1, 'y sus warnings, que son parte del dato');
}
{
  const { api } = client([json(siteInfo)]);
  const data = await api.call('core_webservice_get_site_info');
  assert.equal(data.userid, 90001, 'el objeto sin warnings también');
  assert.equal(data.functions.length, 6);
}

// ── Las excepciones llegan con HTTP 200 ───────────────────────────────────
{
  const { api } = client([json(noPermission)]);
  const err = await api.call('gradereport_user_get_grade_items', { courseid: 800202 }).catch((e) => e);
  assert.ok(err instanceof MoodleError, 'un 200 con errorcode es un error, no un dato');
  assert.equal(err.errorcode, 'nopermissiontoviewgrades');
  assert.equal(err.kind, 'permission', 'es por curso: se marca ese curso y el ciclo sigue');
  assert.equal(err.retryable, false, 'reintentar no le va a dar permiso');
  assert.equal(err.needsCredentials, undefined, 'y no saca a nadie de la sesión');
}
{
  // Sin `exception`, solo con `errorcode`: el mapa registra el código, el resto
  // del sobre es supuesto, así que el cliente decide por el código.
  const { api } = client([json({ errorcode: 'invalidtoken', message: 'Token inválido' })]);
  const err = await api.call('core_webservice_get_site_info').catch((e) => e);
  assert.equal(err.kind, 'token');
  assert.equal(err.needsCredentials, true, 'token muerto es pedir credencial de nuevo');
}
{
  const { api } = client([json({ exception: 'moodle_exception', errorcode: 'sitepolicynotagreed' })]);
  const err = await api.call('core_enrol_get_users_courses').catch((e) => e);
  assert.equal(err.kind, 'policy', 'una política nueva tumba TODAS las llamadas y no es una caída');
}
assert.equal(classifyErrorCode('nopermissions'), 'permission', 'la familia nopermission* entera');
assert.equal(classifyErrorCode('accessexception'), 'token');
assert.equal(classifyErrorCode('cualquierotracosa'), 'wsexception', 'lo desconocido no se convierte en vacío');

// ── 200 que no es JSON: el HTML del login disfrazado de éxito ─────────────
{
  const { api } = client([new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } })]);
  const err = await api.call('core_course_get_contents', { courseid: 800101 }).catch((e) => e);
  assert.equal(err.kind, 'protocol');
  assert.equal(err.retryable, false);
  assert.equal(/login|html/i.test(err.message.replace('text/html', '')), false, 'el cuerpo no entra al mensaje');
}

// ── Reintentos: 429 con Retry-After, y 5xx con backoff ────────────────────
{
  const delays = [];
  const { fetchImpl, calls } = recorder([
    (n) => (n === 1 ? json({ error: 'slow down' }, { status: 429, headers: { 'retry-after': '2' } }) : json(courses)),
  ]);
  const api = createMoodleClient({
    siteUrl: SITE,
    token: TOKEN,
    fetchImpl,
    sleep: async (ms) => delays.push(ms),
    random: () => 0,
  });
  const data = await api.call('core_enrol_get_users_courses');
  assert.equal(calls.length, 2, 'el 429 se reintenta');
  assert.equal(delays[0], 2000, 'y Retry-After manda sobre el backoff');
  assert.equal(data.length, 2);
}
{
  const delays = [];
  const { fetchImpl, calls } = recorder([(n) => (n < 3 ? json({}, { status: 503 }) : json(siteInfo))]);
  const api = createMoodleClient({
    siteUrl: SITE,
    token: TOKEN,
    fetchImpl,
    baseDelayMs: 500,
    sleep: async (ms) => delays.push(ms),
    random: () => 0,
  });
  await api.call('core_webservice_get_site_info');
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [500, 1000], 'backoff exponencial desde la base');
}
{
  const { fetchImpl, calls } = recorder([json({}, { status: 500 })]);
  const api = createMoodleClient({ siteUrl: SITE, token: TOKEN, fetchImpl, maxAttempts: 2, sleep: async () => {} });
  const err = await api.call('core_webservice_get_site_info').catch((e) => e);
  assert.equal(calls.length, 2, 'no reintenta para siempre');
  assert.equal(err.kind, 'server');
  assert.equal(err.attempts, 2, 'el error dice cuántas veces se intentó');
}
{
  // Un 4xx que no es 429 no se reintenta: no es el servidor pidiendo tiempo.
  const { fetchImpl, calls } = recorder([json({}, { status: 403 })]);
  const api = createMoodleClient({ siteUrl: SITE, token: TOKEN, fetchImpl, sleep: async () => {} });
  const err = await api.call('core_webservice_get_site_info').catch((e) => e);
  assert.equal(calls.length, 1);
  assert.equal(err.kind, 'protocol');
}

// ── Tope de llamadas en vuelo ─────────────────────────────────────────────
{
  let inFlight = 0;
  let peak = 0;
  const fetchImpl = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return json(courses);
  };
  const api = createMoodleClient({ siteUrl: SITE, token: TOKEN, fetchImpl, maxConcurrency: 2 });
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => api.call('core_course_get_contents', { courseid: i }))
  );
  assert.equal(results.length, 8, 'las ocho llegan');
  assert.equal(peak, 2, 'pero nunca hay más de dos en vuelo contra un servidor compartido');
}

// ── El token no aparece en ningún texto ───────────────────────────────────
{
  const fetchImpl = async () => {
    throw new Error(`socket hang up al mandar wstoken=${TOKEN}`);
  };
  const api = createMoodleClient({ siteUrl: SITE, token: TOKEN, fetchImpl, maxAttempts: 1 });
  const err = await api.call('core_webservice_get_site_info').catch((e) => e);
  assert.equal(err.kind, 'network');
  assert.equal(err.message.includes(TOKEN), false, 'ni cuando el servidor nos lo devuelve en su propio error');
  assert.ok(err.message.includes('«token»'), 'queda tapado, no borrado: se ve que ahí iba el token');
}
assert.equal(redactToken('a b', null), 'a b', 'sin token no hay nada que tapar');

// ── Función que la instancia no expone ────────────────────────────────────
{
  const { fetchImpl, calls } = recorder([json(courses)]);
  const api = createMoodleClient({
    siteUrl: SITE,
    token: TOKEN,
    fetchImpl,
    knownFunctions: siteInfo.functions.map((fn) => fn.name),
  });
  const err = await api.call('mod_forum_get_forum_discussions', { forumid: 1 }).catch((e) => e);
  assert.equal(err.kind, 'capability', 'ausente del catálogo es capability, no error');
  assert.equal(calls.length, 0, 'y no gasta una petición para descubrirlo');
  await api.call('core_enrol_get_users_courses');
  assert.equal(calls.length, 1, 'las que sí están pasan igual');
}

// ── token.php ─────────────────────────────────────────────────────────────
{
  const { fetchImpl, calls } = recorder([json({ token: 'token-nuevo', privatetoken: 'privado' })]);
  const token = await requestToken({ siteUrl: SITE, username: 'ab123456', password: 'x', fetchImpl });
  assert.equal(token, 'token-nuevo');
  assert.equal(calls[0].url, `${SITE}/login/token.php`);
  assert.equal(calls[0].body.get('service'), MOODLE_SERVICE);
  assert.equal(typeof token, 'string', 'solo el token: privatetoken es otra credencial y no se devuelve');
}
{
  const { fetchImpl } = recorder([json({ error: 'Datos erróneos', errorcode: 'invalidlogin' })]);
  const err = await requestToken({ siteUrl: SITE, username: 'ab123456', password: 'mala', fetchImpl }).catch((e) => e);
  assert.equal(err.kind, 'credential');
  assert.equal(err.credentialRejected, true, 'la bandera que el resto de mikampus ya entiende');
  assert.equal(err.needsCredentials, undefined);
}
{
  const err = await requestToken({ siteUrl: SITE, username: '', password: '', fetchImpl: async () => json({}) }).catch(
    (e) => e
  );
  assert.equal(err.kind, 'credential', 'sin credencial no se molesta al servidor');
}

console.log('✓ cliente de la PVA: sobres, excepciones con 200, aplanado, reintentos, tope de 2 y token tapado');
