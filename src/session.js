import { chromium } from 'playwright';
import { loginContext } from './login.js';
import { getCredential as vaultCredential, storeCredential, deleteCredential } from './credentialVault.js';
import { browserLaunchOptions } from './browser.js';

// Una sola sesión del portal para el único operador. La cola evita que dos
// acciones de Playwright se solapen sobre el mismo context.

// El único context se cierra tras un rato ocioso; nunca se cierra a mitad de
// una operación encolada.
const IDLE_CLOSE_MS = Number(process.env.CONTEXT_IDLE_MS ?? 15 * 60_000);
let browser = null;
let operator = { userId: null, context: null, page: null, queue: Promise.resolve(), lastUsedAt: 0, running: false, idleTimer: null };

// ── Credenciales en RAM (§5 regla 1) ───────────────────────────────────────
// La contraseña del uso interactivo vive acá, atada al ciclo de vida de la sesión:
// entra al loguearse en mikampus, se descarta al cerrar sesión o al reiniciar
// el proceso. Nunca toca disco — lo persistido es solo el almacén cifrado.
let ramCredential = null;

export function setRamCredential(userId, { username, password }) {
  ramCredential = { userId, username, password };
}

export function clearRamCredential(userId) {
  if (ramCredential?.userId === userId) ramCredential = null;
}

// La contraseña nunca sale de este módulo. Cuando el usuario acepta una
// feature desatendida, copiamos la credencial que ya vive en RAM al vault
// cifrado; el endpoint no recibe ni reenvía una contraseña por segunda vez.
export function persistRamCredential(userId, options) {
  const credentials = ramCredential?.userId === userId ? ramCredential : null;
  if (!credentials) {
    const err = new Error('Volvé a iniciar sesión para autorizar una función desatendida');
    err.needsCredentials = true;
    throw err;
  }
  storeCredential(userId, credentials, options);
}

export function hasLiveCredentials(userId) {
  try {
    return Boolean(credentialsFor(userId));
  } catch (err) {
    if (err?.needsCredentials) return false;
    throw err;
  }
}

// Las tareas que siguen sin la persona presente no pueden apoyarse solo en la
// contraseña RAM de una sesión interactiva: requieren que la autorización
// persistida siga vigente. Así el vencimiento corta watcher/schedules aunque
// el browser todavía conserve un context autenticado.
export function hasUnattendedCredential(userId) {
  return Boolean(vaultCredential(userId));
}

// ¿Con qué re-loguear? RAM → almacén cifrado. Sin nada de eso,
// el error lleva needsCredentials: la UI lo traduce al prompt de re-tipeo
// (la costura sesión/credencial de §5.1), no a un error genérico.
function credentialsFor(userId) {
  const ram = ramCredential?.userId === userId ? ramCredential : null;
  if (ram) return ram;
  const vaulted = vaultCredential(userId);
  if (vaulted) return vaulted;
  const err = new Error('No hay credenciales vivas para este usuario: hay que iniciar sesión de nuevo');
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
  const creds = credentialsFor(entry.userId);
  try {
    const { context, page } = await loginContext(await ensureBrowser(), creds);
    entry.context = context;
    entry.page = page;
  } catch (err) {
    if (err?.credentialRejected) {
      clearRamCredential(entry.userId);
      deleteCredential(entry.userId);
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
// sesión del usuario, y guarda su contraseña en RAM: el primer sync tras el
// login no paga un segundo signon.
export function adoptSession(userId, { context, page }, credentials = null) {
  const entry = entryFor(userId);
  if (credentials) setRamCredential(userId, credentials);
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

// Fuerza que la próxima acción de ESTE usuario re-loguee desde cero, y
// descarta su contraseña en RAM. Se usa al cambiar de cuenta y al cerrar
// sesión. Va por su fila para no matar el context a mitad de un scrape.
export function resetSession(userId) {
  const entry = entryFor(userId);
  clearRamCredential(userId);
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
  ramCredential = null;
  try {
    await browser?.close();
  } catch {
    // el browser ya podía estar muerto, no importa
  }
  browser = null;
}
