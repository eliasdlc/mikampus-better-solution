import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Las credenciales de la cuenta que la app está usando. Fuente de verdad en
// runtime: si existe data/account.json (lo escribe el login de la página), esa
// cuenta manda; si no, se cae al .env, que sigue sirviendo de bootstrap.
//
// Vive en data/ (gitignoreado, igual que la DB) y NUNCA se escribe al .env: el
// .env es config que vos editás a mano, no un archivo que la app reescriba por
// debajo. Separarlos deja que cambies de cuenta desde la web sin tocar tu .env.
const ACCOUNT_PATH = process.env.MIKAMPUS_ACCOUNT ?? path.join(__dirname, '..', 'data', 'account.json');

// login.js leía process.env directo, así que cambiar de cuenta obligaba a
// reiniciar el proceso (dotenv congela el .env al arrancar). Leer desde acá en
// cada login deja que setCredentials cambie la cuenta en caliente.
function readAccountFile() {
  try {
    const raw = fs.readFileSync(ACCOUNT_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.username === 'string' && typeof parsed.password === 'string') {
      return { username: parsed.username, password: parsed.password };
    }
  } catch {
    // No existe todavía, o quedó corrupto: en ambos casos caemos al .env.
  }
  return null;
}

// Las credenciales vigentes y de dónde salieron. login.js llama esto en cada
// intento de login, así que refleja siempre el último setCredentials sin
// reiniciar nada.
export function getCredentials() {
  const fromFile = readAccountFile();
  if (fromFile) return { ...fromFile, source: 'account.json' };
  return {
    username: process.env.PUCMM_USERNAME ?? null,
    password: process.env.PUCMM_PASSWORD ?? null,
    source: '.env',
  };
}

// Lo que la UI puede ver: el usuario y de dónde sale, nunca la contraseña.
export function getAccountInfo() {
  const { username, source } = getCredentials();
  return { username: username ?? null, source, configured: Boolean(username) };
}

// Persiste la cuenta que la página eligió. El archivo se crea con permisos 0600
// (solo el dueño lo lee) porque guarda una contraseña en claro: no hay forma de
// que el portal acepte un hash, así que lo mínimo es que nadie más en la
// máquina pueda leerlo.
export function setCredentials({ username, password }) {
  const user = String(username ?? '').trim();
  const pass = String(password ?? '');
  if (!user || !pass) throw new Error('Usuario y contraseña son obligatorios');

  fs.mkdirSync(path.dirname(ACCOUNT_PATH), { recursive: true });
  fs.writeFileSync(ACCOUNT_PATH, JSON.stringify({ username: user, password: pass }, null, 2), { mode: 0o600 });
  // writeFileSync solo aplica el mode al crear: si el archivo ya existía con
  // permisos más laxos, hay que forzarlo.
  fs.chmodSync(ACCOUNT_PATH, 0o600);

  return getAccountInfo();
}
