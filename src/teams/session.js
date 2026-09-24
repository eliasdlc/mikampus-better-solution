import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { browserLaunchOptions } from '../browser.js';
import { dataPaths } from '../paths.js';

// La sesión de Teams, que es la puerta de todo lo que venga de una clase.
//
// **Por qué no hay credencial guardada acá.** El portal de la universidad
// acepta usuario y contraseña, así que `credentialStore` puede reautenticar
// sola. Teams no: es una cuenta institucional de Microsoft con MFA, y un
// segundo factor no se guarda en un fichero. Lo que se guarda es el resultado
// del login, el `storageState` de Playwright, que son cookies con fecha de
// caducidad. Cuando caduca no hay nada que reintentar en silencio: hace falta
// Elias delante otra vez.
//
// Eso convierte el login en un paso de sus manos y no en un fallo del
// automatismo, y por eso vive en su propio comando y no dentro de un cron.
//
// **El único momento en que algo de este proyecto abre una ventana.** Todo lo
// demás corre headless porque nada puede tomarle la pantalla. `teamsLogin` la
// toma a propósito, cuando él lo pide, porque una pantalla de MFA no se puede
// resolver de otra forma.

const TEAMS_URL = 'https://teams.microsoft.com/';

/** Dónde vive el estado de la sesión. Modo 600: son cookies de su cuenta. */
export function teamsStatePath(env = process.env) {
  return path.join(dataPaths(env).dataDir, 'teams-state.json');
}

export function hasTeamsSession(env = process.env) {
  try {
    return fs.statSync(teamsStatePath(env)).size > 0;
  } catch {
    return false;
  }
}

export function forgetTeamsSession(env = process.env) {
  try {
    fs.unlinkSync(teamsStatePath(env));
    return true;
  } catch {
    return false;
  }
}

/**
 * Guarda el estado con permisos de solo su dueño.
 *
 * El `chmod` después del `write` no es redundante: `writeFileSync` solo aplica
 * el modo cuando crea el fichero, así que una sesión que se sobreescribe sobre
 * otra escrita antes con otro umask se quedaría con los permisos viejos.
 */
export function writeTeamsState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  // Una sesión escrita antes con otro umask no se arregla sola.
  fs.chmodSync(file, 0o600);
}

/**
 * El login asistido. Abre una ventana, espera a que Elias entre, y guarda el
 * resultado.
 *
 * `signedIn` decide cuándo terminó, y no puede ser "la URL cambió": el flujo de
 * Microsoft pasa por varias URLs y por un "¿quieres seguir conectado?" que
 * también cambia la URL sin haber terminado. Lo que sí prueba que la sesión
 * está viva es que la aplicación cargó su propio armazón.
 */
export async function teamsLogin({ env = process.env, timeoutMs = 300_000, url = TEAMS_URL } = {}) {
  const browser = await chromium.launch({ headless: false, ...(await browserLaunchOptions()) });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await signedIn(page, timeoutMs);
    writeTeamsState(teamsStatePath(env), await context.storageState());
    return { saved: true, path: teamsStatePath(env) };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Que la aplicación esté cargada y con sesión.
 *
 * El selector sale del recon y no de la memoria de nadie: mientras no haya un
 * volcado real de esta cuenta, la señal es la cookie de autenticación que el
 * dominio deja, que no depende del DOM y por lo tanto no se rompe cuando
 * Microsoft cambia la interfaz.
 */
async function signedIn(page, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const cookies = await page.context().cookies();
    if (cookies.some((cookie) => cookie.name === 'authtoken' || cookie.name === 'SSOAUTHCOOKIE')) return true;
    await page.waitForTimeout(2_000);
  }
  throw new Error('El login de Teams no terminó a tiempo');
}

/**
 * Una página headless con la sesión guardada.
 *
 * Si no hay estado, o caducó, se lanza un error que dice qué hacer en vez de
 * abrir una ventana por su cuenta: un cron que abre un navegador en mitad de
 * una clase es peor que un cron que no corre.
 */
export async function withTeamsPage(fn, { env = process.env } = {}) {
  const file = teamsStatePath(env);
  if (!hasTeamsSession(env)) {
    const err = new Error('No hay sesión de Teams: corré `mikampus teams-login` una vez');
    err.needsTeamsLogin = true;
    throw err;
  }
  const browser = await chromium.launch({ headless: true, ...(await browserLaunchOptions()) });
  try {
    const context = await browser.newContext({ storageState: file });
    const page = await context.newPage();
    const result = await fn(page, context);
    // Microsoft renueva sus cookies en cada carga. Sin guardarlas de vuelta, el
    // fichero se queda con las del login y caduca en la fecha de entonces
    // aunque la sesión se use a diario.
    writeTeamsState(file, await context.storageState());
    return result;
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Si la sesión guardada todavía abre SharePoint, que es donde viven las
 * grabaciones de las clases.
 *
 * Existir el fichero no lo prueba: solo cargarlo. Una sesión caducada acaba en
 * `login.microsoftonline.com`, y eso es lo que se mira, no el DOM de nadie.
 * Devuelve `missing`, `expired` o `alive`; al estar viva, las cookies
 * renovadas quedan guardadas.
 */
export async function teamsSessionState({ env = process.env, url = 'https://cepucmmedu.sharepoint.com/' } = {}) {
  if (!hasTeamsSession(env)) return 'missing';
  const file = teamsStatePath(env);
  const browser = await chromium.launch({ headless: true, ...(await browserLaunchOptions()) });
  try {
    const context = await browser.newContext({ storageState: file });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(3_000);
    if (new URL(page.url()).hostname !== new URL(url).hostname) return 'expired';
    writeTeamsState(file, await context.storageState());
    return 'alive';
  } finally {
    await browser.close().catch(() => {});
  }
}
