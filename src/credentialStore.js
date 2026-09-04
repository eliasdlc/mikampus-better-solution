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

const HEADER = [
  '# Credencial de micampus que usa mikampus para entrar al portal por vos.',
  '# Iniciar sesión en la app escribe estas dos líneas; cerrar sesión las vacía.',
  '# Podés editarlas a mano: el cambio aplica en la próxima operación.',
  '# Si el portal rechaza la credencial, mikampus la borra y te saca de la sesión.',
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
  upsert(file, { [USER_KEY]: '', [PASSWORD_KEY]: '' });
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
export function deleteCredential(file = credentialFilePath()) {
  upsert(file, { [USER_KEY]: '', [PASSWORD_KEY]: '' });
}

// Lo que la UI puede mostrar: quién está guardado y en qué archivo. Nunca la
// contraseña.
export function credentialInfo(file = credentialFilePath()) {
  const credential = readCredential(file);
  return credential ? { username: credential.username, path: file } : null;
}
