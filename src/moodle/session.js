import {
  readPvaCredential,
  readPvaToken,
  writePvaPassword,
  writePvaToken,
  forgetPvaToken,
  deletePvaCredential,
} from '../credentialStore.js';
import { createMoodleClient, requestToken, siteUrlFrom, MoodleError } from './client.js';

// La sesión de la PVA es un token, y nada más. Este archivo es el hermano de
// `src/session.js`: allá la sesión es un context de Playwright que se relanza
// solo, acá es una credencial que se saca de la contraseña guardada y se tira
// cuando el servidor dice que ya no vale.
//
// Las reglas del token, que son las de una contraseña:
//
//   1. Vive en el archivo de credencial (modo 600), nunca en mikampus.db y por
//      lo tanto nunca en un backup, que solo copia la base.
//   2. Se descarta al cerrar sesión y al cambiar de cuenta.
//   3. No se escribe en un log ni en una URL. El cliente lo manda en el cuerpo
//      del POST y lo tapa en cualquier mensaje de error.
//
// Y la razón por la que importan más que con una cookie: un token de Web
// Service de Moodle **no caduca solo**, vale hasta que alguien lo revoque
// (`tool_mobile_forcelogout` y `autologout` están en 0, MAPA §tool_mobile).
//
// Igual que la contraseña del portal, no se cachea en RAM: se lee del archivo
// en cada uso, así que editarlo a mano aplica en la próxima operación.

// Un solo cliente por proceso, para que el tope de concurrencia sea real: dos
// clientes con tope 2 son cuatro llamadas en vuelo contra un servidor que
// atiende a toda la universidad. Se rehace solo si cambia el token.
let cached = null;
// Sacar token es una llamada de red; dos ramas del sync que arrancan a la vez
// piden uno solo.
let minting = null;

function clientFor(token, fetchImpl) {
  if (cached?.token === token && cached.fetchImpl === fetchImpl) return cached.client;
  cached = {
    token,
    fetchImpl,
    client: createMoodleClient({ siteUrl: siteUrlFrom(), token, fetchImpl }),
  };
  return cached.client;
}

function noCredential() {
  return new MoodleError('No hay contraseña de la PVA guardada: hay que vincularla', { kind: 'token' });
}

export function hasPvaCredential() {
  return readPvaCredential() != null;
}

export function hasPvaToken() {
  return readPvaToken() != null;
}

/**
 * Verifica una contraseña de la PVA y, si el sitio la acepta, la guarda junto
 * al token que devolvió. El usuario es el del portal: es la misma persona con
 * dos contraseñas.
 *
 * No toca nada si el sitio la rechaza: una vinculación fallida no puede dejar
 * peor la credencial que ya funcionaba.
 */
export async function linkPvaCredential({ username, password }, { fetchImpl } = {}) {
  const user = String(username ?? '').trim();
  if (!user || !password) throw new MoodleError('Faltan usuario o contraseña de la PVA', { kind: 'credential' });
  const token = await requestToken({ siteUrl: siteUrlFrom(), username: user, password, fetchImpl });
  writePvaPassword(password);
  writePvaToken(token);
  cached = null;
  return { linked: true };
}

// El token guardado, o uno nuevo sacado de la contraseña guardada.
async function ensureToken({ fetchImpl } = {}) {
  const existing = readPvaToken();
  if (existing) return existing;
  if (minting) return minting;
  const credential = readPvaCredential();
  if (!credential) throw noCredential();
  minting = (async () => {
    try {
      const token = await requestToken({ siteUrl: siteUrlFrom(), ...credential, fetchImpl });
      writePvaToken(token);
      return token;
    } catch (err) {
      // La PVA dijo que no a la contraseña guardada: dejarla ahí solo sirve
      // para volver a fallar. Se vacía la de la PVA y la del portal sigue
      // intacta, que es lo que mantiene viva la otra fuente.
      if (err?.credentialRejected) deletePvaCredential();
      throw err;
    } finally {
      minting = null;
    }
  })();
  return minting;
}

/** El cliente listo para llamar, con token vivo. */
export async function pvaClient({ fetchImpl } = {}) {
  return clientFor(await ensureToken({ fetchImpl }), fetchImpl);
}

/**
 * Una llamada de lectura a la PVA. Si el token murió mientras tanto (revocado,
 * o la contraseña cambió) se descarta y se saca uno nuevo una sola vez: no hay
 * forma de preguntar si un token sigue vivo, el `errorcode` de la siguiente
 * llamada es la única señal (MAPA §"Estados que el cliente debe distinguir").
 */
export async function callPva(wsfunction, args = {}, { fetchImpl } = {}) {
  const client = await pvaClient({ fetchImpl });
  try {
    return await client.call(wsfunction, args);
  } catch (err) {
    if (err?.kind !== 'token') throw err;
    forgetPvaToken();
    cached = null;
    const retryClient = await pvaClient({ fetchImpl });
    return retryClient.call(wsfunction, args);
  }
}

// Cerrar sesión, cambiar de cuenta o borrar los datos: el token y su contraseña
// se van con todo lo demás.
export function forgetPvaSession() {
  deletePvaCredential();
  cached = null;
  minting = null;
}
