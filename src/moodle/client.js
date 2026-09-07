// Cliente de los Web Services de la PVA (el Moodle de PUCMM).
//
// A diferencia de `src/peoplesoft/`, acá no hay HTML ni Playwright: la PVA es
// Moodle 5.1.5 con `moodle_mobile_app` habilitado y se consume por REST. Este
// archivo es solo el transporte (parámetros, errores, reintentos y
// concurrencia); quién guarda el token es `src/moodle/session.js` y quién
// interpreta cada respuesta son los módulos de la fase 2.
//
// Las cuatro cosas que este cliente existe para hacer bien, todas documentadas
// en MAPA-PVA.md:
//
//   1. Los parámetros viajan APLANADOS al estilo de Moodle:
//      `courseids[0]=5&options[0][name]=x`. Un objeto anidado sin aplanar llega
//      vacío y la función responde como si no le hubieras pasado nada.
//   2. Los errores llegan con **HTTP 200** y el cuerpo trae `errorcode`
//      (MAPA §"El sobre y los errores"). Un cliente que decida por `res.ok`
//      trata cada excepción como éxito y guarda basura. Acá cada `errorcode`
//      se convierte en un MoodleError tipado, porque las ramas de arriba son
//      distintas: `nopermissiontoviewgrades` es un estado válido del dominio y
//      `invalidtoken` significa volver a pedir la credencial.
//   3. El servidor es compartido con toda la universidad: reintentos con
//      backoff ante 429 y 5xx, y un tope de llamadas en vuelo.
//   4. El token es una contraseña. Nunca va en la query, nunca sale en el
//      mensaje de un error, y si el servidor lo devuelve en un `debuginfo` se
//      tapa antes de que ese texto exista como Error.
//
// Nada de lo que hay acá escribe en la plataforma: `call()` sirve cualquier
// `wsfunction`, y son los módulos de arriba los que eligen cuáles.

export const MOODLE_SERVICE = 'moodle_mobile_app';

// La base incluye la subruta `/moodle`. Armar endpoints desde el host y no
// desde esta base rompe todo (MAPA §"Modelo de la plataforma").
export const DEFAULT_SITE_URL = 'https://campusvirtual.pucmm.edu.do/moodle';

export function siteUrlFrom(env = process.env) {
  return String(env.PVA_URL ?? DEFAULT_SITE_URL).replace(/\/+$/, '');
}

// ── Errores ────────────────────────────────────────────────────────────────

// Un `errorcode` de Moodle no dice qué hacer; el `kind` sí. La tabla sale de
// MAPA §"Manejo de fallos" y §"Estados que el cliente debe distinguir".
//
//   credential  el usuario o la contraseña de la PVA no sirven (solo token.php)
//   token       el token murió o fue revocado: hay que sacar uno nuevo
//   policy      apareció una política de sitio y TODAS las llamadas fallan
//   permission  es por curso o por rol, no por token: marcar ese curso y seguir
//   maintenance el sitio está en mantenimiento: pausa legítima, no falla
//   capability  la función no está en el catálogo de ESE token: ausencia, no error
//   ratelimited 429
//   server      5xx
//   network     no hubo respuesta (DNS, socket, timeout)
//   protocol    hubo respuesta pero no es el JSON que Moodle promete
//   wsexception cualquier otro `errorcode`: falla de esa rama, no dato vacío
export class MoodleError extends Error {
  constructor(message, { kind, errorcode = null, wsfunction = null, status = null, attempts = 1, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'MoodleError';
    this.kind = kind;
    this.errorcode = errorcode;
    this.wsfunction = wsfunction;
    this.status = status;
    this.attempts = attempts;
    this.retryable = RETRYABLE_KINDS.has(kind);
    // Las dos banderas que el resto de mikampus ya entiende: `session.js` y
    // `scheduler.js` las miran para pedir credencial de nuevo en vez de
    // mostrar un error genérico.
    if (kind === 'credential') this.credentialRejected = true;
    if (kind === 'token') this.needsCredentials = true;
  }
}

const RETRYABLE_KINDS = new Set(['ratelimited', 'server', 'network']);

// `invalidtoken` y `accessexception` son los dos códigos que MAPA registra como
// token muerto. El resto se clasifica por patrón porque Moodle no publica una
// taxonomía: `nopermission*` es una familia entera y el de mantenimiento no se
// observó en el recon (es supuesto, por eso se reconoce por substring).
export function classifyErrorCode(errorcode) {
  if (errorcode === 'invalidlogin' || errorcode === 'invalidaccount') return 'credential';
  if (errorcode === 'invalidtoken' || errorcode === 'accessexception') return 'token';
  if (errorcode === 'sitepolicynotagreed') return 'policy';
  if (/^nopermission/.test(errorcode ?? '')) return 'permission';
  if (/maintenance/.test(errorcode ?? '')) return 'maintenance';
  return 'wsexception';
}

// El token nunca debe existir dentro de un string que alguien pueda loguear.
// Se tapa antes de construir el Error, no al imprimirlo.
export function redactToken(text, token) {
  const value = String(text ?? '');
  if (!token) return value;
  return value.split(token).join('«token»');
}

// ── Parámetros ─────────────────────────────────────────────────────────────

// `undefined` y `null` no se mandan: un parámetro presente con valor vacío no
// significa lo mismo que un parámetro ausente. Los booleanos van como 1/0
// porque PARAM_BOOL de PHP considera verdadera la cadena "false".
function flatten(value, prefix, out) {
  if (value === undefined || value === null) return out;
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${prefix}[${index}]`, out));
  } else if (typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) flatten(inner, `${prefix}[${key}]`, out);
  } else if (typeof value === 'boolean') {
    out.set(prefix, value ? '1' : '0');
  } else {
    out.set(prefix, String(value));
  }
  return out;
}

export function flattenParams(args = {}) {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) flatten(value, key, out);
  return out;
}

// ── Concurrencia ───────────────────────────────────────────────────────────

// Un semáforo, no una cola infinita de timers: lo que importa es cuántas
// llamadas hay EN VUELO contra un servidor que atiende a toda la universidad.
// La espera del backoff ocurre dentro del turno a propósito: ante un 429 lo
// correcto es dejar de empujar, no liberar el turno para que entre otra.
function createLimiter(max) {
  let active = 0;
  const waiting = [];
  return async function limited(task) {
    // El turno se toma acá, en el mismo tick del chequeo, y al soltarlo se le
    // pasa entero al que espera. Reservarlo después del await deja pasar a dos
    // y el tope se convierte en una sugerencia.
    if (active >= max) await new Promise((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

// ── Reintentos ─────────────────────────────────────────────────────────────

// `Retry-After` manda cuando viene (segundos o fecha HTTP); si no, backoff
// exponencial con jitter para que dos ramas del sync no vuelvan a la vez.
function retryDelay(attempt, header, { baseDelayMs, maxDelayMs, random }) {
  if (header) {
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    if (Number.isFinite(ms) && ms > 0) return Math.min(ms, maxDelayMs);
  }
  const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
  return Math.round(exponential * (1 + random() * 0.25));
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── El cliente ─────────────────────────────────────────────────────────────

/**
 * Crea el cliente de una identidad: una base y un token.
 *
 * `knownFunctions`, si se pasa, es el catálogo que devolvió
 * `core_webservice_get_site_info` para ESE token (es por token, no por sitio).
 * Con él, pedir una función que la instancia no expone falla como `capability`
 * sin gastar una petición.
 */
export function createMoodleClient({
  siteUrl = siteUrlFrom(),
  token,
  fetchImpl = globalThis.fetch,
  maxConcurrency = 2,
  maxAttempts = 3,
  timeoutMs = 30_000,
  baseDelayMs = 500,
  maxDelayMs = 15_000,
  knownFunctions = null,
  sleep = defaultSleep,
  random = Math.random,
} = {}) {
  if (!token) throw new MoodleError('El cliente de la PVA necesita un token', { kind: 'token' });
  const base = String(siteUrl).replace(/\/+$/, '');
  const endpoint = `${base}/webservice/rest/server.php`;
  const catalog = knownFunctions ? new Set(knownFunctions) : null;
  const limit = createLimiter(maxConcurrency);

  async function attempt(wsfunction, args, attemptNumber) {
    const body = flattenParams(args);
    // El token va en el cuerpo. En la query quedaría en cualquier log de proxy.
    body.set('wstoken', token);
    body.set('wsfunction', wsfunction);
    body.set('moodlewsrestformat', 'json');

    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new MoodleError(`${wsfunction}: no hubo respuesta de la PVA (${redactToken(err.message, token)})`, {
        kind: 'network',
        wsfunction,
        attempts: attemptNumber,
        cause: err,
      });
    }

    if (response.status === 429 || response.status >= 500) {
      const error = new MoodleError(`${wsfunction}: la PVA respondió ${response.status}`, {
        kind: response.status === 429 ? 'ratelimited' : 'server',
        wsfunction,
        status: response.status,
        attempts: attemptNumber,
      });
      // Del rechazo solo sobrevive el `Retry-After`: quedarse con la respuesta
      // entera dejaría un cuerpo sin leer colgando de la conexión.
      error.retryAfter = response.headers.get('retry-after');
      await response.body?.cancel?.().catch(() => {});
      throw error;
    }

    // Moodle contesta 200 hasta para sus excepciones, así que cualquier otro
    // status es el servidor de enfrente hablando, no la función.
    if (!response.ok) {
      throw new MoodleError(`${wsfunction}: la PVA respondió ${response.status}`, {
        kind: 'protocol',
        wsfunction,
        status: response.status,
        attempts: attemptNumber,
      });
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!/json/i.test(contentType)) {
      // Casi siempre es el HTML del login: el token murió y el servidor
      // redirigió. Nunca se incluye el cuerpo, que puede traer datos.
      throw new MoodleError(`${wsfunction}: la PVA respondió ${contentType || 'sin content-type'} en vez de JSON`, {
        kind: 'protocol',
        wsfunction,
        status: response.status,
        attempts: attemptNumber,
      });
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      throw new MoodleError(`${wsfunction}: la respuesta de la PVA no es JSON válido`, {
        kind: 'protocol',
        wsfunction,
        status: response.status,
        attempts: attemptNumber,
        cause: err,
      });
    }

    // La excepción se reconoce por `errorcode`, no por `exception`: el mapa
    // registra el código y da el resto del sobre por supuesto.
    const errorcode = data?.errorcode ?? null;
    if (errorcode || data?.exception) {
      throw new MoodleError(`${wsfunction}: ${errorcode ?? data.exception}`, {
        kind: classifyErrorCode(errorcode),
        errorcode,
        wsfunction,
        status: response.status,
        attempts: attemptNumber,
      });
    }
    return data;
  }

  /**
   * Llama una `wsfunction`. Devuelve el cuerpo tal cual vino: hay tres sobres
   * distintos (arreglo pelado, objeto con `warnings`, objeto sin `warnings`) y
   * un desempaquetador único no cubre los tres, así que desempaqueta el que
   * llama, que sabe qué pidió.
   */
  async function call(wsfunction, args = {}) {
    if (catalog && !catalog.has(wsfunction)) {
      throw new MoodleError(`${wsfunction}: esta instancia no expone la función a este token`, {
        kind: 'capability',
        wsfunction,
      });
    }
    return limit(async () => {
      let last;
      for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
        try {
          return await attempt(wsfunction, args, attemptNumber);
        } catch (err) {
          if (!(err instanceof MoodleError) || !err.retryable || attemptNumber === maxAttempts) throw err;
          last = err;
          await sleep(retryDelay(attemptNumber, err.retryAfter, { baseDelayMs, maxDelayMs, random }));
        }
      }
      throw last;
    });
  }

  return { call, siteUrl: base, endpoint };
}

/**
 * Cambia usuario y contraseña por un token del servicio móvil.
 *
 * El token no caduca solo: vale hasta que alguien lo revoque. Quien lo recibe
 * lo trata como la contraseña que es (ver `src/moodle/session.js`).
 */
export async function requestToken({
  siteUrl = siteUrlFrom(),
  username,
  password,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
} = {}) {
  if (!username || !password) {
    throw new MoodleError('Faltan usuario o contraseña de la PVA', { kind: 'credential' });
  }
  const base = String(siteUrl).replace(/\/+$/, '');
  let response;
  try {
    response = await fetchImpl(`${base}/login/token.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password, service: MOODLE_SERVICE }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new MoodleError(`No hubo respuesta de la PVA al pedir el token (${err.message})`, {
      kind: 'network',
      cause: err,
    });
  }

  if (response.status === 429 || response.status >= 500) {
    throw new MoodleError(`La PVA respondió ${response.status} al pedir el token`, {
      kind: response.status === 429 ? 'ratelimited' : 'server',
      status: response.status,
    });
  }
  if (!/json/i.test(response.headers.get('content-type') ?? '')) {
    throw new MoodleError('La respuesta de token.php no es JSON', { kind: 'protocol', status: response.status });
  }

  const data = await response.json().catch(() => null);
  // token.php no usa el sobre de las wsfunctions: trae `error` + `errorcode`.
  if (!data?.token) {
    const errorcode = data?.errorcode ?? null;
    throw new MoodleError(
      errorcode === 'invalidlogin'
        ? 'La PVA rechazó ese usuario o contraseña'
        : `La PVA no entregó token: ${errorcode ?? 'sin errorcode'}`,
      { kind: errorcode ? classifyErrorCode(errorcode) : 'protocol', errorcode, status: response.status }
    );
  }
  // `privatetoken` también viene y también es una credencial. No se devuelve:
  // solo sirve para el autologin del navegador, que no es de esta fase.
  return data.token;
}
