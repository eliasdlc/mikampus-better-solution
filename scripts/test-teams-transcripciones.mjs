// La busqueda de transcripciones en OneDrive. Sin red: la pagina se sustituye.
//
// Lo que se prueba es lo que hace inservible esto: bajar dos veces la misma
// clase porque aparece en las dos puertas, tomar por nueva una transcripcion de
// la semana pasada, y dejar en disco un nombre que no dice de que clase es.
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
const { recentTranscripts, download, RECENT_HOURS } = await import('../src/teams/transcripts.js');

const NOW = Date.parse('2026-09-21T23:00:00.000Z');
const hace = (horas) => new Date(NOW - horas * 3600_000).toISOString();

// Una pagina falsa: devuelve lo que cada puerta responderia.
const pageWith = (porPuerta, cuerpo = 'WEBVTT\n') => ({
  request: {
    get: async (url) => {
      const puerta = url.includes('sharedWithMe') ? 'shared' : url.includes('recent') ? 'recent' : 'content';
      if (puerta === 'content') {
        return { ok: () => true, status: () => 200, body: async () => Buffer.from(cuerpo) };
      }
      const payload = porPuerta[puerta];
      if (payload instanceof Error) return { ok: () => false, status: () => 401, text: async () => payload.message };
      return { ok: () => true, status: () => 200, json: async () => payload };
    },
  },
});

const item = (name, horas, extra = {}) => ({
  id: 'i-' + name, name, size: 1000, lastModifiedDateTime: hace(horas),
  parentReference: { driveId: 'd1' }, ...extra,
});

try {
  // ── Las dos puertas se juntan sin duplicar ──
  //
  // Una clase de canal aparece en `recent` y en `sharedWithMe`. Bajarla dos
  // veces son dos corridas de agente sobre la misma clase.
  const page = pageWith({
    recent: { value: [item('Reunion en _General_ .vtt', 1)] },
    shared: { value: [item('Reunion en _General_ .vtt', 1), item('Clase de Moviles.vtt', 2)] },
  });
  const { items, fallos } = await recentTranscripts(page, { now: NOW });
  assert.equal(fallos.length, 0);
  assert.equal(items.length, 2, 'la misma transcripcion por dos puertas es una sola');
  assert.deepEqual(items.map((i) => i.name).sort(), ['Clase de Moviles.vtt', 'Reunion en _General_ .vtt']);

  // ── Lo viejo no entra ──
  const viejas = await recentTranscripts(pageWith({
    recent: { value: [item('De la semana pasada.vtt', 24 * 7)] },
    shared: { value: [] },
  }), { now: NOW });
  assert.equal(viejas.items.length, 0, `nada de mas de ${RECENT_HOURS} horas`);

  // ── Lo que no es transcripcion tampoco ──
  const otros = await recentTranscripts(pageWith({
    recent: { value: [item('Grabacion de la clase.mp4', 1), item('presentacion.pptx', 1)] },
    shared: { value: [] },
  }), { now: NOW });
  assert.equal(otros.items.length, 0, 'el video no es la transcripcion');

  // ── Una puerta caida no tumba la otra ──
  //
  // sharedWithMe puede responder 401 con la sesion a medio caducar, y las
  // clases que organizas tu seguirian llegando por recent.
  const media = await recentTranscripts(pageWith({
    recent: { value: [item('Clase viva.vtt', 1)] },
    shared: new Error('unauthorized'),
  }), { now: NOW });
  assert.equal(media.items.length, 1);
  assert.equal(media.fallos.length, 1);
  assert.match(media.fallos[0], /sharedWithMe/);

  // ── El nombre en disco dice de que dia es ──
  //
  // "Reunion en _General_ .vtt" nombra dos materias distintas. La fecha de
  // modificacion es cuando termino la llamada.
  const destino = path.join(dir, 'bajadas');
  const uno = items.find((i) => i.name.startsWith('Reunion'));
  const res = await download(pageWith({}), uno, { dir: destino, now: NOW });
  assert.equal(res.skipped, false);
  assert.match(path.basename(res.path), /^2026-09-2\d-Reunion/, 'la fecha va delante');
  assert.ok(fs.readFileSync(res.path, 'utf8').startsWith('WEBVTT'));

  // Y no se baja dos veces.
  const otra = await download(pageWith({}), uno, { dir: destino, now: NOW });
  assert.equal(otra.skipped, true);

  console.log('test-teams-transcripciones: ok');
} finally {
  db.close();
  await rm(dir, { recursive: true, force: true });
}
