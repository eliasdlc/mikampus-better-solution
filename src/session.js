import { chromium } from 'playwright';
import { loginContext } from './login.js';
import { readCredential, deleteCredential } from './credentialStore.js';
import { browserLaunchOptions } from './browser.js';

// Una sola sesión del portal para el único operador. La cola evita que dos
// acciones de Playwright se solapen sobre el mismo context.

// El único context se cierra tras un rato ocioso; nunca se cierra a mitad de
// una operación encolada.
const IDLE_CLOSE_MS = Number(process.env.CONTEXT_IDLE_MS ?? 15 * 60_000);
let browser = null;
let operator = { userId: null, context: null, page: null, queue: Promise.resolve(), lastUsedAt: 0, running: false, idleTimer: null };

// ── Credencial ─────────────────────────────────────────────────────────────
// La contraseña vive en el archivo de credencial del usuario (credentialStore)
// y se lee en cada re-login: nada queda en RAM entre operaciones, y un cambio
// manual del archivo aplica en la próxima.

export function hasLiveCredentials() {
  return readCredential() != null;
}

// ¿Con qué re-loguear? Sin credencial en el archivo, el error lleva
// needsCredentials: la UI lo traduce al pedido de volver a entrar, no a un
// error genérico.
function credentialsFor() {
  const credential = readCredential();
  if (credential) return credential;
  const err = new Error('No hay credencial guardada: hay que iniciar sesión de nuevo');
  err.needsCredentials = true;
  throw err;
}

// ── La sesión única ────────────────────────────────────────────────────────

async function ensureBrowser() {
  if (browser?.isConnected()) return browser;
  const launched = await chromium.launch({ headless: true, ...(await browserLaunchOptions()) });
  browser = launched;
  // Un crash invalida el único context y la próxima operación relanza desde
  // cero con una credencial todavía vigente.
  launched.on('disconnected', () => {
    if (browser === launched) browser = null;
    operator.context = null;
    operator.page = null;
  });
  return browser;
}

function entryFor(userId) {
  if (!Number.isInteger(userId)) throw new Error('withPage necesita un userId');
  if (operator.userId != null && operator.userId !== userId) {
    throw new Error('Esta instalación solo admite la identidad local del operador');
  }
  operator.userId = userId;
  return operator;
}

async function teardownEntry(entry = operator) {
  clearTimeout(entry.idleTimer);
  try {
    await entry.context?.close();
  } catch {
    // el context ya podía estar muerto, no importa
  }
  entry.context = null;
  entry.page = null;
}

async function ensureSession(entry) {
  if (entry.page && !entry.page.isClosed() && !entry.page.url().includes('cmd=login')) return;
  await teardownEntry(entry);
  const creds = credentialsFor();
  try {
    const { context, page } = await loginContext(await ensureBrowser(), creds);
    entry.context = context;
    entry.page = page;
  } catch (err) {
    // El portal dijo que no: la credencial guardada ya no sirve. Vaciarla es
    // lo que saca al usuario de la sesión de mikampus en la próxima request.
    if (err?.credentialRejected) {
      deleteCredential();
      err.needsCredentials = true;
    }
    throw err;
  }
}

function scheduleIdleClose(entry) {
  clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    const run = async () => {
      if (!entry.running && Date.now() - entry.lastUsedAt >= IDLE_CLOSE_MS - 1000) {
        await teardownEntry(entry);
      }
    };
    entry.queue = entry.queue.then(run, run);
  }, IDLE_CLOSE_MS);
  entry.idleTimer.unref?.();
}

// ¿El error significa "la sesión murió" (browser caído, page cerrada) o "el
// portal respondió algo"? Solo lo primero amerita re-login + reintento. Un
// error lógico (selector roto, materia inexistente) va a volver a fallar igual
// y a escala N eso duplica carga contra el portal (§0).
function isSessionDead(err) {
  if (err?.name === 'TargetClosedError') return true;
  return /Target (page|closed)|has been closed|Target crashed|browserContext\.|browser\.newContext|page (was closed|crashed)/i.test(
    err?.message ?? ''
  );
}

// Toda acción contra PeopleSoft de un usuario pasa por acá: se encola en SU
// fila, sobre SU context. retry solo repite cuando la sesión murió o el portal
// nos devolvió al signon a mitad de camino; las operaciones con efectos
// (enroll/drop) van con retry:false porque un timeout pudo ocurrir DESPUÉS del
// submit — el caller verifica el estado antes de decidir un segundo intento.
export function withPage(userId, fn, { retry = true } = {}) {
  const entry = entryFor(userId);
  const run = async () => {
    entry.running = true;
    entry.lastUsedAt = Date.now();
    try {
      await ensureSession(entry);
      try {
        return await fn(entry.page);
      } catch (err) {
        const kickedToSignon =
          entry.page && !entry.page.isClosed() && entry.page.url().includes('cmd=login');
        if (!isSessionDead(err) && !kickedToSignon) throw err;
        await teardownEntry(entry);
        if (!retry) throw err;
        await ensureSession(entry);
        return await fn(entry.page);
      }
    } finally {
      entry.running = false;
      entry.lastUsedAt = Date.now();
      scheduleIdleClose(entry);
    }
  };
  const result = entry.queue.then(run, run);
  entry.queue = result.then(
    () => {},
    () => {}
  );
  return result;
}

// Verifica unas credenciales contra el portal SIN usuario todavía: es el paso
// previo del login de mikampus (el usuario se crea recién cuando el portal dijo
// que sí). Devuelve el context vivo para no tirar un login que costó ~30s.
export async function verifyPortalCredentials({ username, password }) {
  return loginContext(await ensureBrowser(), { username, password });
}

// Adopta un context ya logueado (el que dejó verifyPortalCredentials) como LA
// sesión del usuario: el primer sync tras el login no paga un segundo signon.
export function adoptSession(userId, { context, page }) {
  const entry = entryFor(userId);
  const run = async () => {
    await teardownEntry(entry);
    entry.context = context;
    entry.page = page;
    entry.lastUsedAt = Date.now();
    scheduleIdleClose(entry);
  };
  const result = entry.queue.then(run, run);
  entry.queue = result.then(
    () => {},
    () => {}
  );
  return result;
}

// Fuerza que la próxima acción de ESTE usuario re-loguee desde cero. Se usa
// al cambiar de cuenta y al cerrar sesión. Va por su fila para no matar el
// context a mitad de un scrape.
export function resetSession(userId) {
  const entry = entryFor(userId);
  const run = () => teardownEntry(entry);
  const result = entry.queue.then(run, run);
  entry.queue = result.then(
    () => {},
    () => {}
  );
  return result;
}

export async function shutdown() {
  clearTimeout(operator.idleTimer);
  operator = { userId: null, context: null, page: null, queue: Promise.resolve(), lastUsedAt: 0, running: false, idleTimer: null };
  try {
    await browser?.close();
  } catch {
    // el browser ya podía estar muerto, no importa
  }
  browser = null;
}
