// La busqueda de transcripciones en OneDrive. Sin red: la pagina se sustituye.
//
// Lo que se prueba es lo que hace inservible esto: confundir "todavia no se ha
// generado" con "no hay", bajar dos veces la misma clase porque aparece en las
// dos puertas, tomar por nueva una grabacion de la semana pasada, y dejar en
// disco un nombre que no dice de que clase es.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-teams-tr-'));
process.env.MIKAMPUS_DATA_DIR = dir;
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.MIKAMPUS_SILENT = '1';

const { db } = await import('../src/db.js');
const { recentRecordings, transcriptsOf, download, RECENT_HOURS } = await import('../src/teams/transcripts.js');

const NOW = Date.parse('2026-09-21T23:00:00.000Z');
const hace = (horas) => new Date(NOW - horas * 3600_000).toISOString();
const VTT = '﻿WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n<v Profesor>Buenas tardes</v>\n';

/** Una pagina falsa: responde lo que cada endpoint real responderia. */
const pageWith = ({ shared = [], recent = [], transcripts = {}, contenido = VTT } = {}) => ({
  goto: async () => {},
  waitForTimeout: async () => {},
  request: {
    get: async (url) => {
      const ok = (body) => ({ ok: () => true, status: () => 200, json: async () => body, text: async () => body });
      if (url.includes('sharedWithMe')) return ok({ value: shared });
      if (url.includes('/me/drive/recent')) return ok({ value: recent });
      const m = url.match(/items\/([^/]+)\/media\/transcripts$/);
      if (m) return ok({ value: transcripts[m[1]] ?? [] });
      if (url.includes('/streamContent') || url.includes('download')) {
        return { ok: () => true, status: () => 200, text: async () => contenido };
      }
      return { ok: () => false, status: () => 404, text: async () => 'no' };
    },
  },
});

const grabacion = (name, horas, id = 'it-' + name) => ({
  name, id, lastModifiedDateTime: hace(horas), parentReference: { driveId: 'd1' },
});

try {
  // ── Las dos puertas se juntan sin repetir ──
  const page = pageWith({
    shared: [grabacion('Clase de Moviles.mp4', 1, 'A'), grabacion('Gestion.mp4', 3, 'B')],
    recent: [grabacion('Clase de Moviles.mp4', 1, 'A')],
  });
  const { recordings, fallos } = await recentRecordings(page, { now: NOW });
  assert.equal(fallos.length, 0);
  assert.equal(recordings.length, 2, 'la misma grabacion por dos puertas es una sola');

  // ── Lo viejo no entra ──
  const viejas = await recentRecordings(pageWith({ shared: [grabacion('De junio.mp4', 24 * 90, 'C')] }), { now: NOW });
  assert.equal(viejas.recordings.length, 0, `nada de mas de ${RECENT_HOURS} horas`);

  // ── Un pdf compartido no es una clase ──
  const otros = await recentRecordings(pageWith({ shared: [grabacion('Diapositivas.pdf', 1, 'D')] }), { now: NOW });
  assert.equal(otros.recordings.length, 0);

  // ── "Todavia no" no es "no hay" ──
  //
  // Es el caso normal en los minutos siguientes a colgar, y confundirlo con un
  // fallo es perder la clase: el video ya subio y Teams la esta generando.
  const sinAun = await transcriptsOf(pageWith({ transcripts: {} }), { driveId: 'd1', itemId: 'A' });
  assert.deepEqual(sinAun, [], 'lista vacia, no excepcion');

  // ── Con transcripcion, baja el WEBVTT ──
  const conTr = pageWith({ transcripts: { A: [{ id: 't1', languageTag: 'es-es' }] } });
  const lista = await transcriptsOf(conTr, { driveId: 'd1', itemId: 'A' });
  assert.equal(lista.length, 1);

  const destino = path.join(dir, 'bajadas');
  const rec = { name: 'Clase de Moviles-20260921_180000-Grabación de la reunión.mp4', modified: NOW, driveId: 'd1', itemId: 'A' };
  const res = await download(conTr, rec, lista[0], { dir: destino, now: NOW });
  assert.equal(res.skipped, false);
  // La fecha delante, y sin el sufijo que Teams le cuelga al nombre.
  assert.match(path.basename(res.path), /^2026-09-2\d-Clase-de-Moviles-20260921_180000\.vtt$/);
  assert.ok(fs.readFileSync(res.path, 'utf8').includes('WEBVTT'));

  // Y no se baja dos veces.
  assert.equal((await download(conTr, rec, lista[0], { dir: destino, now: NOW })).skipped, true);

  // ── Lo que no es un VTT no se guarda ──
  //
  // Una sesion a medio caducar devuelve 200 con una pagina de login, y guardar
  // eso deja al agente leyendo HTML como si fuera una clase.
  const basura = pageWith({ transcripts: { A: [{ id: 't1' }] }, contenido: '<!doctype html><title>Sign in</title>' });
  const rec2 = { ...rec, name: 'Otra clase.mp4' };
  await assert.rejects(() => download(basura, rec2, { id: 't1' }, { dir: destino, now: NOW }), /WEBVTT/);
  assert.equal(fs.existsSync(path.join(destino, '2026-09-21-Otra-clase.vtt')), false);

  console.log('test-teams-transcripciones: ok');
} finally {
  db.close();
  await rm(dir, { recursive: true, force: true });
}
