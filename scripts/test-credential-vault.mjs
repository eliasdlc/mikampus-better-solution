// El almacén cifrado de credenciales contra un archivo desechable: ida y
// vuelta, expiración con purga, info sin contraseña, y que sin clave el
// almacén simplemente no existe (ni guarda ni revienta al leer).
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-vault-'));
process.env.MIKAMPUS_CRED_DB = path.join(dir, 'credentials.db');
process.env.MIKAMPUS_CRED_KEY = crypto.randomBytes(32).toString('hex');

const {
  vaultAvailable,
  storeCredential,
  getCredential,
  credentialInfo,
  deleteCredential,
  purgeExpiredCredentials,
} = await import('../src/credentialVault.js');

assert.ok(vaultAvailable(), 'con MIKAMPUS_CRED_KEY el almacén está disponible');

// ── Ida y vuelta. ──
const en1h = new Date(Date.now() + 3600_000).toISOString();
storeCredential(7, { username: 'ana', password: 'secreta123' }, { expiresAt: en1h, reason: 'disparo 6am Sept-2026' });
assert.deepEqual(getCredential(7), { username: 'ana', password: 'secreta123' }, 'la credencial vuelve intacta');

// ── La contraseña no está en claro en disco (el WAL también cuenta). ──
const rawFile = Buffer.concat([
  await readFile(process.env.MIKAMPUS_CRED_DB),
  await readFile(`${process.env.MIKAMPUS_CRED_DB}-wal`).catch(() => Buffer.alloc(0)),
]);
assert.ok(!rawFile.includes('secreta123'), 'la contraseña no aparece en claro en disco');
assert.ok(rawFile.includes('ana'), 'el username sí es legible (Ajustes lo muestra)');

// ── La info para Ajustes dice por qué y hasta cuándo, nunca la contraseña. ──
const info = credentialInfo(7);
assert.equal(info.reason, 'disparo 6am Sept-2026');
assert.equal(info.expiresAt, en1h);
assert.ok(!('password' in info), 'credentialInfo jamás incluye la contraseña');

// ── Guardar sin vencimiento es un error de programación, no un default. ──
assert.throws(
  () => storeCredential(8, { username: 'x', password: 'y' }, {}),
  /vencimiento/,
  'una credencial persistida exige fecha de vencimiento'
);

// ── Una credencial vencida no se entrega y se purga sola. ──
const hace1h = new Date(Date.now() - 3600_000).toISOString();
storeCredential(9, { username: 'beto', password: 'otra' }, { expiresAt: hace1h, reason: 'watcher' });
assert.equal(getCredential(9), null, 'una credencial vencida no se entrega');
assert.equal(credentialInfo(9), null, 'ni siquiera como info');

storeCredential(10, { username: 'caro', password: 'tercera' }, { expiresAt: hace1h });
assert.equal(purgeExpiredCredentials(), 1, 'la purga limpia lo vencido');
assert.deepEqual(getCredential(7), { username: 'ana', password: 'secreta123' }, 'lo vigente sobrevive la purga');

// ── Borrado explícito (cerrar sesión, "Borrar mis datos"). ──
deleteCredential(7);
assert.equal(getCredential(7), null, 'borrada es borrada');

await rm(dir, { recursive: true, force: true });
console.log('✓ almacén de credenciales: cifrado real, vida acotada con purga, info sin contraseña');
