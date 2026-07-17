// El cron de catálogo (src/cron.js) contra una DB desechable. Lo que se prueba
// no es que sincronice — eso es el scraper, ya probado— sino que NO corra
// cuando no debe y que elija bien qué refrescar.
//
// La guarda de la inscripción es la razón de ser de este archivo: la sesión de
// Playwright es una sola y está en fila (session.js), así que un barrido de 20
// minutos por delante del disparo de las 7am te deja fuera de la materia. Un
// catálogo viejo se arregla; una inscripción perdida espera al otro
// cuatrimestre.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-test-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.SYNC_TERM = '1930';

const { db } = await import('../src/db.js');
const { parseAt, nextRun, subjectsToSync, stalestSubject, blockedBecause } = await import('../src/cron.js');

try {
  // Una hora mal escrita apaga el cron; no lo corre a una hora sorpresa.
  assert.deepEqual(parseAt('03:00'), { hour: 3, minute: 0 });
  assert.deepEqual(parseAt('3:30'), { hour: 3, minute: 30 });
  assert.equal(parseAt('25:00'), null, 'no existen las 25:00');
  assert.equal(parseAt('03:60'), null);
  assert.equal(parseAt('3am'), null);
  assert.equal(parseAt(''), null, 'sin variable, el cron está apagado');
  assert.equal(parseAt(undefined), null);

  // La próxima corrida: hoy si todavía no pasó, mañana si ya pasó.
  const mediodia = new Date(2026, 6, 16, 12, 0);
  assert.equal(nextRun({ hour: 15, minute: 0 }, mediodia).getDate(), 16, 'las 15:00 de hoy todavía no pasaron');
  assert.equal(nextRun({ hour: 3, minute: 0 }, mediodia).getDate(), 17, 'las 03:00 ya pasaron: mañana');
  assert.equal(nextRun({ hour: 12, minute: 0 }, mediodia).getDate(), 17, 'la hora exacta actual ya pasó: mañana');

  // La guarda dura: nada de barrer el portal con una inscripción en juego.
  assert.equal(blockedBecause({ schedule: null, watcher: null }), null, 'sin nada en juego, vía libre');
  assert.match(blockedBecause({ schedule: { atISO: '2026-08-01T11:00:00Z' }, watcher: null }), /inscripción programada/);
  assert.match(blockedBecause({ schedule: null, watcher: { intervalMs: 45000 } }), /watcher/);

  // Qué refrescar: lo que te falta cursar, del pénsum local (sin tocar el portal).
  db.exec(`
    INSERT INTO pensum (code, subject, catalog_nbr, status) VALUES
      ('ICC-303', 'ICC', '303', 'pending'),
      ('ICC-321', 'ICC', '321', 'pending'),
      ('MAT-241', 'MAT', '241', 'pending'),
      ('FIS-139', 'FIS', '139', 'taken');
  `);
  assert.deepEqual(subjectsToSync(), ['ICC', 'MAT'], 'los subjects de lo pendiente, sin repetir; FIS ya está aprobada');

  // La variable de entorno manda sobre el pénsum cuando está.
  process.env.CATALOG_CRON_SUBJECTS = 'let, art';
  assert.deepEqual(subjectsToSync(), ['LET', 'ART'], 'la lista explícita gana y se normaliza');
  delete process.env.CATALOG_CRON_SUBJECTS;

  // La rotación: un subject por noche, el más viejo primero. El que nunca se
  // sincronizó va antes que cualquiera que ya se haya sincronizado alguna vez.
  assert.equal(stalestSubject(['ICC', 'MAT']), 'ICC', 'sin sync previa, el primero por orden');

  db.exec(`
    INSERT INTO sync_log (kind, term, status, detail, finished_at) VALUES
      ('catalog', '1930', 'ok', 'ICC', '2026-07-16 03:00:00');
  `);
  assert.equal(stalestSubject(['ICC', 'MAT']), 'MAT', 'MAT nunca se sincronizó: va antes que ICC');

  db.exec(`
    INSERT INTO sync_log (kind, term, status, detail, finished_at) VALUES
      ('catalog', '1930', 'error', 'MAT (sin trocear: MAT1@CSTI)', '2026-07-17 03:00:00');
  `);
  assert.equal(stalestSubject(['ICC', 'MAT']), 'ICC', 'ahora el más viejo es ICC — y MAT se reconoce con su detalle de troceo');

  // Un sync de OTRO término no cuenta como refresco de este.
  db.exec(`
    INSERT INTO sync_log (kind, term, status, detail, finished_at) VALUES
      ('catalog', '1910', 'ok', 'ICC', '2026-07-18 03:00:00');
  `);
  assert.equal(stalestSubject(['ICC', 'MAT']), 'ICC', 'el catálogo de un término no refresca el de otro');

  console.log('✓ cron de catálogo (hora, rotación por antigüedad, y la guarda de la inscripción)');
} finally {
  await rm(dir, { recursive: true, force: true });
}
