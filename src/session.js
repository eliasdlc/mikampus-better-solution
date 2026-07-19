import { chromium } from 'playwright';
import { loginContext } from './login.js';
import { getCredentials } from './credentials.js';
import { getCredential as vaultCredential, storeCredential } from './credentialVault.js';
import { LOCAL_USER_ID } from './users.js';

// El pool de sesiones del portal (LANZAMIENTO §1): UN Chromium compartido y un
// browser context por usuario — cookies y sesión de PeopleSoft aisladas — con
// su propia fila de acciones. La lentitud de un usuario nunca encola a otro;
// dentro de un mismo usuario jamás corren dos acciones de Playwright a la vez.
//
// La cuenta de servicio (§1, la cuenta de Elias) es un context más del pool:
// sirve el sync compartido (catálogo, cupos) sin exponer sesiones ajenas.
export const SERVICE_USER_ID = LOCAL_USER_ID;

// ~80–150MB por context activo: se cierran solos tras un rato ociosos y hay un
// techo global. El techo es blando — antes de abrir un context nuevo se cierra
// el ocioso más viejo, pero nunca uno a mitad de una operación.
const IDLE_CLOSE_MS = Number(process.env.CONTEXT_IDLE_MS ?? 15 * 60_000);
const MAX_CONTEXTS = Number(process.env.MAX_BROWSER_CONTEXTS ?? 12);

let browser = null;
const pool = new Map(); // userId → { context, page, queue, lastUsedAt, running, idleTimer }

// ── Credenciales en RAM (§5 regla 1) ───────────────────────────────────────
// La contraseña del uso interactivo vive acá, atada al ciclo de vida del pool:
// entra al loguearse en mikampus, se descarta al cerrar sesión o al reiniciar
// el proceso. Nunca toca disco — lo persistido es solo el almacén cifrado.
const ramCredentials = new Map();

export function setRamCredential(userId, { username, password }) {
  ramCredentials.set(userId, { username, password });
}

export function clearRamCredential(userId) {
  ramCredentials.delete(userId);
}

// La contraseña nunca sale de este módulo. Cuando el usuario acepta una
// feature desatendida, copiamos la credencial que ya vive en RAM al vault
// cifrado; el endpoint no recibe ni reenvía una contraseña por segunda vez.
export function persistRamCredential(userId, options) {
  const credentials = ramCredentials.get(userId);
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

// ¿Con qué re-loguear a este usuario? RAM → almacén cifrado → y solo para el
// usuario local/de servicio, el .env/account.json de siempre. Sin nada de eso,
// el error lleva needsCredentials: la UI lo traduce al prompt de re-tipeo
// (la costura sesión/credencial de §5.1), no a un error genérico.
function credentialsFor(userId) {
  const ram = ramCredentials.get(userId);
  if (ram) return ram;
  const vaulted = vaultCredential(userId);
  if (vaulted) return vaulted;
  if (userId === LOCAL_USER_ID) {
    const { username, password } = getCredentials();
    if (username && password) return { username, password };
  }
  const err = new Error('No hay credenciales vivas para este usuario: hay que iniciar sesión de nuevo');
  err.needsCredentials = true;
  throw err;
}

// ── El pool ────────────────────────────────────────────────────────────────

async function ensureBrowser() {
  if (browser?.isConnected()) return browser;
  const launched = await chromium.launch({ headless: true });
  browser = launched;
  // Un crash del Chromium compartido tumba TODOS los contexts a la vez (§1):
  // se invalida el pool entero y el próximo withPage relanza desde cero.
  launched.on('disconnected', () => {
    if (browser === launched) browser = null;
    for (const entry of pool.values()) {
      entry.context = null;
      entry.page = null;
    }
  });
  return browser;
}

function entryFor(userId) {
  if (!Number.isInteger(userId)) throw new Error('withPage necesita un userId');
  let entry = pool.get(userId);
  if (!entry) {
    entry = { userId, context: null, page: null, queue: Promise.resolve(), lastUsedAt: 0, running: false, idleTimer: null };
    pool.set(userId, entry);
  }
  return entry;
}

function liveEntries() {
  return [...pool.values()].filter((e) => e.page && !e.page.isClosed());
}

async function teardownEntry(entry) {
  clearTimeout(entry.idleTimer);
  try {
    await entry.context?.close();
  } catch {
    // el context ya podía estar muerto, no importa
  }
  entry.context = null;
  entry.page = null;
}

// Hace lugar antes de abrir un context nuevo: cierra el ocioso más viejo.
async function evictIfNeeded() {
  const live = liveEntries();
  if (live.length < MAX_CONTEXTS) return;
  const idle = live.filter((e) => !e.running).sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
  if (idle) await teardownEntry(idle);
}

async function ensureSession(entry) {
  if (entry.page && !entry.page.isClosed() && !entry.page.url().includes('cmd=login')) return;
  await teardownEntry(entry);
  await evictIfNeeded();
  const creds = credentialsFor(entry.userId);
  const { context, page } = await loginContext(await ensureBrowser(), creds);
  entry.context = context;
  entry.page = page;
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
  for (const entry of pool.values()) clearTimeout(entry.idleTimer);
  pool.clear();
  ramCredentials.clear();
  try {
    await browser?.close();
  } catch {
    // el browser ya podía estar muerto, no importa
  }
  browser = null;
}
