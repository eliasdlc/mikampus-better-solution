// El archivo de credencial contra un temporal: se crea vacío, ida y vuelta,
// conserva líneas ajenas, vaciar deja el archivo, y un cambio a mano se ve
// sin reiniciar nada. La contraseña va en claro: lo que se verifica es que
// solo el dueño pueda leerla.
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-credential-'));
const file = path.join(dir, 'nested', 'credenciales.env');
process.env.MIKAMPUS_CREDENTIALS_FILE = file;

const {
  ensureCredentialFile,
  readCredential,
  writeCredential,
  deleteCredential,
  credentialInfo,
  credentialFilePath,
  readPvaCredential,
  writePvaPassword,
  readPvaToken,
  writePvaToken,
  forgetPvaToken,
  deletePvaCredential,
} = await import('../src/credentialStore.js');

try {
  assert.equal(credentialFilePath(), file, 'la ruta sale del entorno');
  assert.equal(readCredential(), null, 'sin archivo no hay credencial, y no revienta');

  // ── Existe siempre, aunque esté vacío. ──
  ensureCredentialFile();
  const empty = await readFile(file, 'utf8');
  assert.match(empty, /^MIKAMPUS_PORTAL_USER=$/m, 'el archivo vacío ya enseña la llave del usuario');
  assert.match(empty, /^MIKAMPUS_PORTAL_PASSWORD=$/m, 'y la de la contraseña');
  assert.match(empty, /^MIKAMPUS_PVA_PASSWORD=$/m, 'y las dos de la PVA, que son otra fuente');
  assert.match(empty, /^MIKAMPUS_PVA_TOKEN=$/m);
  assert.equal(readCredential(), null, 'vacío sigue siendo "sin credencial"');
  if (process.platform !== 'win32') {
    assert.equal((await stat(file)).mode & 0o777, 0o600, 'solo el dueño puede leerlo');
  }

  // ── Ida y vuelta, con una contraseña que rompería un parser ingenuo. ──
  writeCredential({ username: '  ana  ', password: 'se creta #1 "x"' });
  assert.deepEqual(readCredential(), { username: 'ana', password: 'se creta #1 "x"' }, 'la credencial vuelve intacta');
  assert.deepEqual(credentialInfo(), { username: 'ana', path: file }, 'la info nunca lleva la contraseña');
  assert.ok((await readFile(file, 'utf8')).startsWith('#'), 'el encabezado explicativo se conserva');

  // ── Editado a mano: aplica en la próxima lectura. ──
  await writeFile(file, `# mi nota\nOTRA_COSA=1\nMIKAMPUS_PORTAL_USER=juan\nMIKAMPUS_PORTAL_PASSWORD='clave'\n`);
  assert.deepEqual(readCredential(), { username: 'juan', password: 'clave' }, 'lo que la persona escribió manda');

  // ── Vaciar deja el archivo y respeta las líneas ajenas. ──
  deleteCredential();
  assert.equal(readCredential(), null, 'vaciar es cerrar sesión');
  const after = await readFile(file, 'utf8');
  assert.match(after, /^OTRA_COSA=1$/m, 'una línea que no es nuestra sobrevive');
  assert.match(after, /^MIKAMPUS_PORTAL_USER=$/m, 'las llaves quedan, vacías');

  // ── Una llave duplicada a mano no sobrevive al vaciado. ──
  await writeFile(file, 'MIKAMPUS_PORTAL_USER=\nMIKAMPUS_PORTAL_PASSWORD=\nMIKAMPUS_PORTAL_USER=juan\nMIKAMPUS_PORTAL_PASSWORD=clave\n');
  assert.deepEqual(readCredential(), { username: 'juan', password: 'clave' });
  deleteCredential();
  assert.equal(readCredential(), null, 'vaciar vacía todas las copias');
  assert.equal((await readFile(file, 'utf8')).match(/^MIKAMPUS_PORTAL_USER=/gm)?.length, 1, 'y deja una sola llave');

  // ── Solo usuario o solo contraseña no es una credencial. ──
  await writeFile(file, 'MIKAMPUS_PORTAL_USER=juan\n');
  assert.equal(readCredential(), null, 'sin contraseña no hay con qué entrar');
  assert.throws(() => writeCredential({ username: 'juan', password: '' }), /obligatorios/);

  // ── La PVA: mismo usuario, otra contraseña, y un token que es credencial. ──
  writeCredential({ username: 'ana', password: 'clave-portal' });
  assert.equal(readPvaCredential(), null, 'entrar al portal no vincula la PVA');
  writePvaPassword('clave-pva');
  writePvaToken('token-de-prueba');
  assert.deepEqual(readPvaCredential(), { username: 'ana', password: 'clave-pva' }, 'el usuario es el del portal');
  assert.equal(readPvaToken(), 'token-de-prueba');

  // El token muere pero la contraseña puede seguir sirviendo.
  forgetPvaToken();
  assert.equal(readPvaToken(), null);
  assert.deepEqual(readPvaCredential(), { username: 'ana', password: 'clave-pva' }, 'la contraseña sobrevive al token');

  // Ninguna fuente vacía a la otra: es la regla de las dos credenciales.
  writePvaToken('token-de-prueba');
  deleteCredential();
  assert.equal(readCredential(), null, 'el portal rechazó su contraseña');
  assert.equal(readPvaToken(), 'token-de-prueba', 'y la PVA sigue con su token');
  writeCredential({ username: 'ana', password: 'clave-portal' });
  deletePvaCredential();
  assert.equal(readPvaCredential(), null, 'la PVA rechazó la suya');
  assert.equal(readPvaToken(), null, 'y su token se va con ella');
  assert.deepEqual(readCredential(), { username: 'ana', password: 'clave-portal' }, 'el portal ni se entera');
} finally {
  await rm(dir, { recursive: true, force: true });
}
