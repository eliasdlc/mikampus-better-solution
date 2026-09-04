// El horario keyeado por identificador de ciclo (§P0.2, §P0.5): un horario
// guardado SOLO por etiqueta (View My Classes no expone el STRM) aparece y se
// reporta como sincronizado; y cuando el STRM aparece después, las inscripciones
// convergen al STRM sin duplicarse.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-sched-id-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.MIKAMPUS_DIAGNOSTICS = 'off'; // el test no ejercita la telemetría a disco

const { db, logSync } = await import('../src/db.js');
const { reconcileTerms, readTerms, upsertTerm } = await import('../src/terms.js');
const { readSchedule } = await import('../src/peoplesoft/mySchedule.js');

const hoy = new Date(2026, 6, 17); // 17-jul-2026 → el ciclo de Abril está corriendo

// Horario inscrito SOLO por etiqueta: no se conoce el STRM del ciclo actual.
const courseId = db
  .prepare("INSERT INTO courses (code, subject, catalog_nbr, title) VALUES ('ICC-101','ICC','101','Intro') RETURNING id")
  .get().id;
const sectionId = db
  .prepare("INSERT INTO sections (course_id, term, class_nbr, section) VALUES (?, 'Abril de 2026', '4000', '01-LEC') RETURNING id")
  .get(courseId).id;
db.prepare(
  "INSERT INTO enrollments (term, course_id, section_id, status, units, start_date, end_date) VALUES ('Abril de 2026', ?, ?, 'enrolled', 3, '2026-05-05', '2026-08-15')"
).run(courseId, sectionId);
// Y el registro de que ESE ciclo se sincronizó, keyeado por la etiqueta.
logSync({ userId: 1, kind: 'mySchedule', term: 'Abril de 2026', status: 'ok', rows: 1 });

reconcileTerms();

// El bug corregido: la etiqueta NO se escribió en la columna `code`.
const abril = db.prepare("SELECT code FROM terms WHERE label = 'Abril de 2026'").get();
assert.equal(abril.code, null, 'reconcile no trata la etiqueta de enrollments como STRM');

// El ciclo actual se resuelve por etiqueta, y su identificador es la etiqueta.
const { current } = readTerms(hoy);
assert.equal(current.label, 'Abril de 2026');
assert.equal(current.code, null);
assert.equal(current.term, 'Abril de 2026', 'sin STRM, el identificador del ciclo es su etiqueta');

// Aceptación #1: el horario guardado solo por etiqueta APARECE, y se reporta
// sincronizado por el registro de sync (no por cuántas filas devolvió la query).
const sched = readSchedule(1, current.term);
assert.equal(sched.courses.length, 1, 'el horario por etiqueta aparece');
assert.equal(sched.courses[0].code, 'ICC-101');
assert.ok(sched.syncedAt, 'el ciclo por etiqueta figura como sincronizado');

// ── El STRM aparece después (lo aporta el catálogo) ─────────────────────────
upsertTerm({ code: '1920', label: 'Abril de 2026' });
reconcileTerms();

// Aceptación #3: el ciclo se enriquece (una sola fila con STRM), no se duplica.
assert.equal(
  db.prepare("SELECT COUNT(*) AS n FROM terms WHERE label = 'Abril de 2026'").get().n,
  1,
  'aparecer el STRM enriquece la fila, no crea otra'
);

// Convergencia: la inscripción se re-keyeó al STRM, no quedó huérfana bajo la etiqueta.
assert.equal(
  db.prepare("SELECT term FROM enrollments WHERE section_id = ?").get(sectionId).term,
  '1920',
  'la inscripción converge al STRM cuando se conoce'
);

// Y sigue apareciendo y sincronizada pedida por el nuevo identificador (STRM),
// aunque el registro de sync siga bajo la etiqueta: el alias lo encuentra.
const after = readTerms(hoy).current;
assert.equal(after.term, '1920', 'ahora el identificador del ciclo es el STRM');
const sched2 = readSchedule(1, after.term);
assert.equal(sched2.courses.length, 1, 'el horario sobrevive al cambio de identificador');
assert.ok(sched2.syncedAt, 'la frescura sobrevive: el alias encuentra el sync hecho por etiqueta');

await rm(dir, { recursive: true, force: true });
console.log('✓ horario por identificador: aparece por etiqueta, se reporta sincronizado y converge al STRM sin duplicar');
