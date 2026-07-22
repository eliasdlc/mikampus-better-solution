import 'dotenv/config';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Entry } from '@napi-rs/keyring';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Credenciales persistidas del portal. Desktop usa el almacén seguro nativo
// (Credential Manager, Keychain o Secret Service mediante keyring-rs). Home
// Server usa el vault cifrado separado, con su secreto fuera del volumen.
//
// Las tres decisiones que lo definen:
//   1. Archivo APARTE de mikampus.db. Los backups del usuario no deben copiar
//      este archivo ni su secret; si se pierde, se reautoriza el trabajo
//      desatendido. Eso es una molestia, no una fuga.
//   2. AES-256-GCM con la clave SOLO en el .env del server (MIKAMPUS_CRED_KEY).
//      Sin la clave, el archivo es ruido; sin el archivo, la clave no abre nada.
//   3. Toda credencial entra con fecha de vencimiento (el cierre de la ventana
//      de inscripción del término, regla 3 de §5) y se purga sola al vencer.
//      El almacén tiende a vacío: lleno solo alrededor de inscripción.
//
// Acá solo se persiste la excepción: features desatendidas (disparo programado,
// watcher con auto-enroll) que necesitan re-loguear sin el usuario presente.
// El uso interactivo vive en RAM, atado al context de Playwright (session.js).

const RUNTIME = process.env.MIKAMPUS_RUNTIME ?? (process.env.MIKAMPUS_CRED_DB ? 'home-server' : 'desktop');
const VAULT_PATH = process.env.MIKAMPUS_CRED_DB ?? path.join(__dirname, '..', 'data', 'credentials.db');
const KEYRING_SERVICE = 'mikampus.portal';

let vaultDb = null;

function key() {
  const raw = process.env.MIKAMPUS_CRED_KEY ?? '';
  if (!raw) return null;
  const buf = Buffer.from(raw, 'hex');
  if (buf.length !== 32) {
    throw new Error('MIKAMPUS_CRED_KEY tiene que ser 32 bytes en hex (64 caracteres)');
  }
  return buf;
}

export function vaultAvailable() {
  if (RUNTIME === 'desktop') return true;
  return key() !== null;
}

function desktopEntry(userId) {
  return new Entry(KEYRING_SERVICE, `user:${userId}`);
}

function desktopRecord(userId) {
  try {
    const raw = desktopEntry(userId).getPassword();
    if (!raw) return null;
    const record = JSON.parse(raw);
    if (!record?.username || !record?.password || !record?.expiresAt) return null;
    if (record.expiresAt <= new Date().toISOString()) {
      desktopEntry(userId).deletePassword();
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

// El archivo se crea recién cuando alguien guarda una credencial: un server
// donde nadie activó features desatendidas no tiene ni el archivo.
function openVault() {
  if (vaultDb) return vaultDb;
  vaultDb = new DatabaseSync(VAULT_PATH);
  vaultDb.exec('PRAGMA journal_mode = WAL');
  vaultDb.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      user_id     INTEGER PRIMARY KEY,
      username    TEXT NOT NULL,
      ciphertext  BLOB NOT NULL,
      iv          BLOB NOT NULL,
      tag         BLOB NOT NULL,
      reason      TEXT,
      expires_at  TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  return vaultDb;
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function decrypt({ ciphertext, iv, tag }) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// Guarda con consentimiento explícito y vida acotada: expiresAt es obligatorio
// y el diálogo que llama esto ya le dijo al usuario hasta cuándo (§5 regla 3).
export function storeCredential(userId, { username, password }, { expiresAt, reason = null }) {
  if (RUNTIME === 'desktop') {
    if (!Number.isInteger(userId)) throw new Error('storeCredential necesita un userId');
    if (!username || !password) throw new Error('Usuario y contraseña son obligatorios');
    if (!expiresAt) throw new Error('Una credencial persistida necesita fecha de vencimiento');
    try {
      desktopEntry(userId).setPassword(JSON.stringify({ username, password, reason, expiresAt, createdAt: new Date().toISOString() }));
      return;
    } catch (err) {
      throw new Error(`No se pudo usar el almacén seguro del sistema: ${err.message}`);
    }
  }
  if (!vaultAvailable()) {
    throw new Error('El almacén de credenciales no está configurado (falta MIKAMPUS_CRED_KEY)');
  }
  if (!Number.isInteger(userId)) throw new Error('storeCredential necesita un userId');
  if (!username || !password) throw new Error('Usuario y contraseña son obligatorios');
  if (!expiresAt) throw new Error('Una credencial persistida necesita fecha de vencimiento');

  const { ciphertext, iv, tag } = encrypt(password);
  openVault()
    .prepare(
      `INSERT INTO credentials (user_id, username, ciphertext, iv, tag, reason, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         username = excluded.username,
         ciphertext = excluded.ciphertext,
         iv = excluded.iv,
         tag = excluded.tag,
         reason = excluded.reason,
         expires_at = excluded.expires_at,
         created_at = datetime('now')`
    )
    .run(userId, username, ciphertext, iv, tag, reason, expiresAt);
}

function liveRow(userId) {
  if (!vaultAvailable()) return null;
  const row = openVault().prepare('SELECT * FROM credentials WHERE user_id = ?').get(userId);
  if (!row) return null;
  if (row.expires_at <= new Date().toISOString()) {
    deleteCredential(userId);
    return null;
  }
  return row;
}

export function getCredential(userId) {
  if (RUNTIME === 'desktop') {
    const record = desktopRecord(userId);
    return record ? { username: record.username, password: record.password } : null;
  }
  const row = liveRow(userId);
  if (!row) return null;
  return {
    username: row.username,
    password: decrypt({
      ciphertext: Buffer.from(row.ciphertext),
      iv: Buffer.from(row.iv),
      tag: Buffer.from(row.tag),
    }),
  };
}

// Lo que Ajustes puede mostrar (§8): que hay una credencial, por qué y hasta
// cuándo. Nunca la contraseña.
export function credentialInfo(userId) {
  if (RUNTIME === 'desktop') {
    const record = desktopRecord(userId);
    return record
      ? { username: record.username, reason: record.reason, expiresAt: record.expiresAt, createdAt: record.createdAt, store: 'system' }
      : null;
  }
  const row = liveRow(userId);
  if (!row) return null;
  return { username: row.username, reason: row.reason, expiresAt: row.expires_at, createdAt: row.created_at };
}

export function deleteCredential(userId) {
  if (RUNTIME === 'desktop') {
    try {
      desktopEntry(userId).deletePassword();
    } catch {
      // El secreto ya puede no existir; el estado deseado sigue siendo vacío.
    }
    return;
  }
  if (!vaultAvailable()) return;
  openVault().prepare('DELETE FROM credentials WHERE user_id = ?').run(userId);
}

// Se corre al arrancar y una vez al día: el almacén tiende a vacío solo.
export function purgeExpiredCredentials() {
  if (RUNTIME === 'desktop') {
    const record = desktopRecord(1);
    return record ? 0 : 1;
  }
  if (!vaultAvailable()) return 0;
  return openVault()
    .prepare('DELETE FROM credentials WHERE expires_at <= ?')
    .run(new Date().toISOString()).changes;
}
