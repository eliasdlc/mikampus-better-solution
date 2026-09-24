// La sesión de Teams. Sin red y sin navegador.
//
// Lo que se prueba es lo único que se puede probar sin la cuenta de Elias, y es
// justo donde esto puede hacer daño: que el estado se guarde con permisos de
// solo él, que un proceso automático nunca abra una ventana por su cuenta, y
// que "hay fichero" no se confunda con "hay sesión".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-teams-'));
process.env.MIKAMPUS_DATA_DIR = dir;
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.MIKAMPUS_SILENT = '1';

const { db } = await import('../src/db.js');
const { teamsStatePath, hasTeamsSession, forgetTeamsSession, withTeamsPage, writeTeamsState, teamsSessionState } = await import('../src/teams/session.js');

try {
  const file = teamsStatePath();

  // ── Sin sesión no hay sesión ──
  assert.equal(hasTeamsSession(), false);

  // Un fichero vacío no es una sesión: se crea solo cuando algo escribe a
  // medias, y tratarlo como válido manda al cron a fallar contra Teams.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  assert.equal(hasTeamsSession(), false, 'un fichero vacío no es una sesión');

  // Sin fichero, el chequeo de un timer responde sin lanzar un navegador.
  assert.equal(await teamsSessionState(), 'missing');

  // ── Un proceso automático nunca abre una ventana ──
  //
  // Es la regla dura: un cron que abre un navegador en mitad de una clase le
  // toma la pantalla a Elias, que es lo que este proyecto no hace nunca.
  const err = await withTeamsPage(() => assert.fail('no debería llegar acá')).catch((e) => e);
  assert.equal(err.needsTeamsLogin, true);
  assert.match(err.message, /teams-login/);

  // ── El estado es de él y de nadie más ──
  //
  // Se escribe sobre el fichero vacío de arriba a propósito: writeFileSync solo
  // aplica el modo cuando crea, así que sin el chmod de writeTeamsState una
  // sesión sobreescrita se quedaría con los permisos que tuviera antes.
  fs.chmodSync(file, 0o644);
  writeTeamsState(file, { cookies: [], origins: [] });
  assert.equal(hasTeamsSession(), true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'son cookies de su cuenta institucional');

  // ── Olvidarla es una operación, no un borrado a mano ──
  assert.equal(forgetTeamsSession(), true);
  assert.equal(hasTeamsSession(), false);
  assert.equal(forgetTeamsSession(), false, 'olvidar lo ya olvidado no es un error');

  console.log('test-teams-sesion: ok');
} finally {
  db.close();
  await rm(dir, { recursive: true, force: true });
}
