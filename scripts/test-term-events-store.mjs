// La capa de disco del calendario del ciclo: qué se guarda, qué se proyecta y
// qué gana cuando dos fuentes dicen cosas distintas. Contra una DB desechable,
// cero portal.
//
// Lo que protege:
//   1. la ventana de Enrollment Dates se ve sin haberla copiado a term_events
//      (una sola escritura, imposible de desincronizar);
//   2. lo que el estudiante corrigió a mano no lo pisa el portal;
//   3. un ciclo guardado bajo su etiqueta se encuentra pidiéndolo por su STRM.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-test-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');

const { db } = await import('../src/db.js');
const { readTermEvents, saveTermEvents, termPhase, resolveTermTarget } = await import('../src/termEvents.js');

const USER = 1;
const on = (iso) => new Date(`${iso}T12:00:00`);

// El ciclo real: STRM 1930 y su etiqueta, con las fechas que da el horario.
db.prepare('INSERT OR IGNORE INTO users (id) VALUES (?)').run(USER);
db.prepare("INSERT INTO terms (code, label, start_date, end_date) VALUES ('1930', 'Septiembre de 2026', '2026-09-01', '2026-12-07')").run();
// La ventana que el portal publicó, en su tabla de siempre: nadie la copia.
db.prepare(
  `INSERT INTO enrollment_windows (term_code, session, starts_at, ends_at, precision, user_id, synced_at)
   VALUES ('1930', 'Regular Academic Session', '2026-07-16', '2026-09-03', 'date', ?, datetime('now'))`
).run(USER);

try {
  // ── 1. Nace vacía y aun así el portal se ve ──────────────────────────────
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM term_events').get().n, 0, 'ninguna fecha sembrada');
  const soloPortal = readTermEvents(USER, '1930');
  assert.deepEqual(
    soloPortal.map((e) => [e.event, e.startsOn, e.endsOn, e.source]),
    [['inscripcion-regular', '2026-07-16', '2026-09-03', 'portal']],
    'la ventana de Enrollment Dates se proyecta al leer, sin duplicar la fila'
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM term_events').get().n, 0, 'leer no escribe');

  // ── 2. Lo que carga el estudiante entra como suyo ────────────────────────
  saveTermEvents(USER, '1930', [
    { event: 'modificacion-inscripcion', startsOn: '2026-09-04', endsOn: '2026-09-08', sourceNote: 'Calendario académico 2026' },
    { event: 'retiro-parcial', endsOn: '2026-10-15' },
  ]);
  const cargado = readTermEvents(USER, '1930');
  assert.equal(cargado.length, 3, 'las dos cargadas más la del portal');
  const modificacion = cargado.find((e) => e.event === 'modificacion-inscripcion');
  assert.equal(modificacion.source, 'usuario', 'nadie puede escribir una fecha como si la hubiera dicho el portal');
  assert.equal(modificacion.sourceNote, 'Calendario académico 2026');
  assert.equal(cargado.find((e) => e.event === 'retiro-parcial').startsOn, null, 'media ventana se guarda como media ventana');

  // ── 3. El portal no pisa una corrección a mano ───────────────────────────
  saveTermEvents(USER, '1930', [
    { event: 'inscripcion-regular', startsOn: '2026-07-16', endsOn: '2026-09-05', sourceNote: 'me lo corrigieron en secretaría' },
  ]);
  const corregido = readTermEvents(USER, '1930').find((e) => e.event === 'inscripcion-regular');
  assert.deepEqual([corregido.endsOn, corregido.source], ['2026-09-05', 'usuario'], 'la corrección le gana a la proyección del portal');

  // El PUT es un reemplazo: lo que no se manda, se borra. Y solo borra lo suyo.
  assert.equal(readTermEvents(USER, '1930').length, 1, 'la lista guardada es exactamente la última confirmada');
  saveTermEvents(USER, '1930', []);
  assert.deepEqual(
    readTermEvents(USER, '1930').map((e) => [e.event, e.source]),
    [['inscripcion-regular', 'portal']],
    'vaciar el calendario propio devuelve la ventana del portal, no la borra'
  );

  // ── 4. Lo que no se deja escribir ────────────────────────────────────────
  assert.throws(() => saveTermEvents(USER, '1930', [{ event: 'notas' }]), /al menos una/i, 'un evento sin ninguna fecha no es un dato');
  assert.throws(
    () => saveTermEvents(USER, '1930', [{ event: 'notas', startsOn: '2026-12-20', endsOn: '2026-12-10' }]),
    /anterior/i,
    'una ventana que cierra antes de abrir es un error de tipeo, no un dato'
  );
  assert.throws(() => saveTermEvents(USER, '1930', [{ event: 'vacaciones', startsOn: '2026-12-20' }]), /vacaciones|invalid/i);
  assert.throws(
    () => saveTermEvents(USER, '1930', [
      { event: 'notas', startsOn: '2026-12-10' },
      { event: 'notas', endsOn: '2026-12-18' },
    ]),
    /dos veces/i,
    'la misma etapa dos veces en el mismo envío es ambigua'
  );
  assert.equal(readTermEvents(USER, '1930').length, 1, 'ningún intento fallido dejó filas a medias');

  // ── 5. Los dos vocabularios de ciclo encuentran las mismas fechas ────────
  saveTermEvents(USER, 'Septiembre de 2026', [{ event: 'notas', startsOn: '2026-12-15', endsOn: '2026-12-20' }]);
  assert.ok(
    readTermEvents(USER, '1930').some((e) => e.event === 'notas'),
    'lo guardado bajo la etiqueta se encuentra pidiéndolo por el STRM'
  );

  // ── 6. La composición que consume el frontend ────────────────────────────
  assert.deepEqual(resolveTermTarget(null, on('2026-09-15')), {
    term: '1930',
    termLabel: 'Septiembre de 2026',
    startDate: '2026-09-01',
    endDate: '2026-12-07',
  });
  const phase = termPhase(USER, { term: '1930', today: on('2026-08-01') });
  assert.equal(phase.phase, 'inscripcion-regular');
  assert.equal(phase.termLabel, 'Septiembre de 2026');
  assert.equal(phase.capabilities.planear.state, 'habilitada');
  assert.ok(phase.events.length >= 2, 'la respuesta trae las fechas con que se resolvió');

  // Un ciclo que la base no conoce responde vacío, no rompe la pantalla.
  const desconocido = termPhase(USER, { term: '1940', today: on('2026-08-01') });
  assert.deepEqual([desconocido.phase, desconocido.events.length], ['desconocida', 0]);
  assert.equal(desconocido.capabilities.recomendar.state, 'habilitada', 'un ciclo desconocido no apaga recomendar');

  console.log('✓ calendario del ciclo: portal proyectado, corrección del estudiante intocable, alias de ciclo respetados');
} finally {
  await rm(dir, { recursive: true, force: true });
}
