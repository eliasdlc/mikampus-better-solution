import fs from 'node:fs';
import path from 'node:path';
import { dataPaths } from './paths.js';

// La credencial del portal vive en un archivo .env del usuario, dentro del
// data dir de mikampus. Es la única fuente: iniciar sesión lo escribe, cerrar
// sesión lo vacía, y el usuario puede editarlo a mano cuando quiera. Se lee en
// cada uso y nunca se cachea, así que un cambio manual aplica en la próxima
// operación sin reiniciar el agente.
//
// El archivo existe siempre (se crea vacío al arrancar) para que la persona
// sepa dónde está y qué llaves lleva, aunque todavía no haya entrado.

export const USER_KEY = 'MIKAMPUS_PORTAL_USER';
export const PASSWORD_KEY = 'MIKAMPUS_PORTAL_PASSWORD';

// La PVA (el Moodle de PUCMM) es la segunda fuente y pide su propia
// contraseña: el usuario es el mismo del portal, la contraseña no. Su token de
// Web Service vive acá y no en la base, porque no caduca solo: vale hasta que
// alguien lo revoque, así que es una credencial y no un dato. Por eso tampoco
// entra a los backups, que copian la base y nada más.
export const PVA_PASSWORD_KEY = 'MIKAMPUS_PVA_PASSWORD';
export const PVA_TOKEN_KEY = 'MIKAMPUS_PVA_TOKEN';
// La tercera credencial del dominio, y la más fácil de confundir con un dato:
// `userprivateaccesskey` viene dentro de la respuesta de site_info y abre el
// calendario y los archivos SIN sesión. Vive acá y no en la base, y sirve para
// bajar materiales por tokenpluginfile.php, que no deja el token en la query.
export const PVA_ACCESS_KEY_KEY = 'MIKAMPUS_PVA_ACCESS_KEY';

const HEADER = [
  '# Credenciales que usa mikampus para entrar por vos. Son dos fuentes.',
  '# micampus (PeopleSoft): usuario y contraseña del portal.',
  '# PVA (Moodle): el MISMO usuario, con SU propia contraseña, y el token que',
  '# mikampus saca con ella. El token no caduca: vale hasta que se revoque.',
  '# Iniciar sesión en la app las escribe; cerrar sesión las vacía todas.',
  '# Podés editarlas a mano: el cambio aplica en la próxima operación.',
  '# Si una fuente rechaza su contraseña, mikampus borra la suya y deja la otra.',
].join('\n');

export function credentialFilePath(env = process.env) {
  return dataPaths(env).credentials;
}

function parse(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\(["\\])/g, '$1');
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

// Un valor con espacios, `#` o comillas se guarda entre comillas dobles para
// que el parser de arriba (y dotenv, si alguien lo lee con él) lo recupere igual.
function quote(value) {
  return /[\s#"'\\]/.test(value) ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : value;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Escritura atómica y solo legible por el dueño: la contraseña va en claro, y
// los permisos del archivo son lo que la protege del resto del sistema.
function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

// Reescribe el archivo conservando cualquier línea ajena a las dos llaves. Una
// llave nuestra repetida a mano se colapsa en una sola: si no, vaciar dejaría
// viva la copia de abajo.
function upsert(file, values) {
  const existing = readText(file);
  const lines = existing == null ? [HEADER] : existing.replace(/\n$/, '').split('\n');
  const pending = new Map(Object.entries(values));
  const out = [];
  for (const line of lines) {
    const key = line.trim().split('=', 1)[0]?.trim();
    if (!(key in values)) {
      out.push(line);
    } else if (pending.has(key)) {
      out.push(`${key}=${quote(pending.get(key))}`);
      pending.delete(key);
    }
  }
  for (const [key, value] of pending) out.push(`${key}=${quote(value)}`);
  writeText(file, `${out.join('\n')}\n`);
}

export function ensureCredentialFile(file = credentialFilePath()) {
  if (readText(file) != null) return file;
  upsert(file, {
    [USER_KEY]: '',
    [PASSWORD_KEY]: '',
    [PVA_PASSWORD_KEY]: '',
    [PVA_TOKEN_KEY]: '',
    [PVA_ACCESS_KEY_KEY]: '',
  });
  return file;
}

export function readCredential(file = credentialFilePath()) {
  const text = readText(file);
  if (text == null) return null;
  const values = parse(text);
  const username = values[USER_KEY]?.trim() ?? '';
  const password = values[PASSWORD_KEY] ?? '';
  if (!username || !password) return null;
  return { username, password };
}

export function writeCredential({ username, password }, file = credentialFilePath()) {
  const user = String(username ?? '').trim();
  if (!user || !password) throw new Error('Usuario y contraseña son obligatorios');
  upsert(file, { [USER_KEY]: user, [PASSWORD_KEY]: String(password) });
}

// Vaciar en vez de borrar el archivo: la persona sigue viendo dónde iría.
// Solo las llaves del portal: que PeopleSoft rechace su contraseña no dice nada
// de la de la PVA, y tumbar las dos fuentes por un rechazo de una sola es
// exactamente lo que no puede pasar. Cerrar sesión sí vacía todo, llamando
// también a deletePvaCredential.
export function deleteCredential(file = credentialFilePath()) {
  upsert(file, { [USER_KEY]: '', [PASSWORD_KEY]: '' });
}

// ── PVA (Moodle) ───────────────────────────────────────────────────────────

// El usuario sale de la llave del portal: es la misma persona, y así no hay dos
// copias del nombre de usuario que puedan discrepar. La consecuencia, y es
// deliberada: vaciar la credencial del portal deja a la PVA sin con qué sacar
// un token nuevo, aunque el que ya tenga siga sirviendo. Volver a entrar al
// portal la devuelve a como estaba, porque su contraseña nunca se tocó.
export function readPvaCredential(file = credentialFilePath()) {
  const text = readText(file);
  if (text == null) return null;
  const values = parse(text);
  const username = values[USER_KEY]?.trim() ?? '';
  const password = values[PVA_PASSWORD_KEY] ?? '';
  if (!username || !password) return null;
  return { username, password };
}

export function writePvaPassword(password, file = credentialFilePath()) {
  if (!password) throw new Error('La contraseña de la PVA es obligatoria');
  upsert(file, { [PVA_PASSWORD_KEY]: String(password) });
}

export function readPvaToken(file = credentialFilePath()) {
  const text = readText(file);
  if (text == null) return null;
  const token = parse(text)[PVA_TOKEN_KEY]?.trim() ?? '';
  return token || null;
}

export function writePvaToken(token, file = credentialFilePath()) {
  if (!token) throw new Error('El token de la PVA es obligatorio');
  upsert(file, { [PVA_TOKEN_KEY]: String(token) });
}

export function readPvaAccessKey(file = credentialFilePath()) {
  const text = readText(file);
  if (text == null) return null;
  const key = parse(text)[PVA_ACCESS_KEY_KEY]?.trim() ?? '';
  return key || null;
}

export function writePvaAccessKey(key, file = credentialFilePath()) {
  if (!key) throw new Error('La llave de acceso de la PVA es obligatoria');
  upsert(file, { [PVA_ACCESS_KEY_KEY]: String(key) });
}

// El token murió (revocado, o cambió la contraseña de la PVA) pero la
// contraseña guardada puede seguir sirviendo: se tira solo el token y la
// próxima llamada saca uno nuevo.
export function forgetPvaToken(file = credentialFilePath()) {
  // La llave de acceso se va con el token: las dos salen de la misma sesión y
  // una llave vieja contra un token nuevo solo produce 403 silenciosos.
  upsert(file, { [PVA_TOKEN_KEY]: '', [PVA_ACCESS_KEY_KEY]: '' });
}

// La PVA rechazó la contraseña, o se cerró sesión: fuera las dos llaves. El
// portal no se toca.
export function deletePvaCredential(file = credentialFilePath()) {
  upsert(file, { [PVA_PASSWORD_KEY]: '', [PVA_TOKEN_KEY]: '', [PVA_ACCESS_KEY_KEY]: '' });
}

// Lo que la UI puede mostrar: quién está guardado y en qué archivo. Nunca la
// contraseña.
export function credentialInfo(file = credentialFilePath()) {
  const credential = readCredential(file);
  return credential ? { username: credential.username, path: file } : null;
}
