// Las grabaciones que viven en el equipo de una materia. Sin red.
//
// Lo que se prueba es el fallo que este modulo existe para corregir: una clase
// es una reunion de canal y su grabacion no esta en el OneDrive personal, asi
// que buscar solo ahi encuentra reuniones sueltas y ninguna clase.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-sitios-'));
process.env.MIKAMPUS_DATA_DIR = dir;
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.MIKAMPUS_SILENT = '1';

const { db } = await import('../src/db.js');
const { sitesWithRecentRecordings, recordingsInSite, MAX_SITES } = await import('../src/teams/sites.js');

const NOW = Date.parse('2026-09-22T01:00:00.000Z');
const hace = (h) => new Date(NOW - h * 3600_000).toISOString();

const fila = (web, titulo, horas) => ({
  Cells: [
    { Key: 'SPWebUrl', Value: web },
    { Key: 'SiteTitle', Value: titulo },
    { Key: 'LastModifiedTime', Value: hace(horas) },
  ],
});

const pageWith = ({ filas = [], porRuta = {} } = {}) => ({
  goto: async () => {}, waitForTimeout: async () => {},
  request: {
    get: async (url) => {
      if (url.includes('/_api/search/query')) {
        return { ok: () => true, status: () => 200, json: async () => ({
          PrimaryQueryResult: { RelevantResults: { Table: { Rows: filas } } } }) };
      }
      const clave = Object.keys(porRuta).find((k) => decodeURI(url).includes(k));
      if (!clave) return { ok: () => false, status: () => 404, text: async () => 'no' };
      return { ok: () => true, status: () => 200, json: async () => ({ value: porRuta[clave] }) };
    },
  },
});

const carpeta = (name) => ({ name, folder: {} });
const video = (name, horas, id) => ({
  name, id, lastModifiedDateTime: hace(horas), parentReference: { driveId: 'd-equipo' },
});

try {
  // ── El sitio de la materia se descubre sin saberlo de antemano ──
  const page = pageWith({
    filas: [
      fila('https://t/teams/ICC-451', 'ICC-451 Moviles', 2),
      fila('https://t/teams/ICC-451', 'ICC-451 Moviles', 3),
      fila('https://t/teams/VIEJO', 'Algo del semestre pasado', 24 * 30),
    ],
  });
  const sitios = await sitesWithRecentRecordings(page, { now: NOW });
  assert.equal(sitios.length, 1, 'el mismo sitio dos veces es uno solo');
  assert.equal(sitios[0].web, 'https://t/teams/ICC-451');
  assert.ok(sitios.length <= MAX_SITES);

  // ── La grabacion sale del canal, no de la raiz ──
  //
  // Es el fallo entero: mirar el OneDrive personal encuentra reuniones sueltas
  // y ninguna clase, porque una clase la abre el profesor desde el equipo.
  const conCanales = pageWith({
    porRuta: {
      '/drive/root/children': [carpeta('General'), carpeta('Practicas'), { name: 'un.docx' }],
      '/General/Recordings': [video('Meeting in General-20260921_183307.mp4', 2, 'v1'), { name: 'notas.txt' }],
      '/Practicas/Recordings': [video('Practica.mp4', 24 * 10, 'v2')],
    },
  });
  const recs = await recordingsInSite(conCanales, { web: 'https://t/teams/ICC-451', title: 'ICC-451 Moviles' }, { now: NOW });
  assert.equal(recs.length, 1, 'la de hace diez dias no entra');
  assert.equal(recs[0].itemId, 'v1');
  assert.equal(recs[0].driveId, 'd-equipo');
  assert.equal(recs[0].site, 'ICC-451 Moviles', 'la materia viaja para poder nombrar el fichero');
  // El host no es el del OneDrive personal, y los dos saltos siguientes dependen de el.
  assert.ok(recs[0].host.includes('sharepoint.com') && !recs[0].host.includes('-my'));

  // ── Un canal sin grabaciones no es un error ──
  const sinNada = pageWith({ porRuta: { '/drive/root/children': [carpeta('General')] } });
  assert.deepEqual(await recordingsInSite(sinNada, { web: 'https://t/x', title: 'X' }, { now: NOW }), []);

  // ── Un sitio al que ya no se puede entrar tampoco ──
  const cerrado = pageWith({ porRuta: {} });
  assert.deepEqual(await recordingsInSite(cerrado, { web: 'https://t/y', title: 'Y' }, { now: NOW }), []);

  console.log('test-teams-sitios: ok');
} finally {
  db.close();
  await rm(dir, { recursive: true, force: true });
}
