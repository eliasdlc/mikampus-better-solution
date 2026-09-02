// El viaje del modelo de tiempo contra una DB desechable: los dos vocabularios
// de término que viven en disco (STRM en enrollments, etiquetas en grades) se
// cruzan en la tabla `terms` y readTerms los resuelve contra una fecha fija.
//
// Reproduce el bug que motiva la Fase 6: en julio de 2026 el ciclo actual es
// "Abril de 2026" (solo en grades, sin STRM), no 1930/"Septiembre de 2026" (lo
// único inscrito). Si reconcile no cruzara ambos, 1930 saldría como actual.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-terms-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');

const { db } = await import('../src/db.js');
const { reconcileTerms, readTerms, currentTermCode, upsertTerm } = await import('../src/terms.js');

// STRM 1930 inscrito, con sus fechas (sep–dic 2026). Hacen falta course y
// section por las FK de enrollments.
const courseId = db
  .prepare("INSERT INTO courses (code, subject, catalog_nbr, title) VALUES ('ICC-233','ICC','233','Seg. en Tec. Info.') RETURNING id")
  .get().id;
const sectionId = db
  .prepare("INSERT INTO sections (course_id, term, class_nbr, section) VALUES (?, '1930', '4567', '01-LEC') RETURNING id")
  .get(courseId).id;
db.prepare(
  "INSERT INTO enrollments (term, course_id, section_id, status, units, start_date, end_date) VALUES ('1930', ?, ?, 'enrolled', 4, '2026-09-01', '2026-12-07')"
).run(courseId, sectionId);

// Histórico de notas: etiquetas en español, incluyendo el ciclo que corre hoy
// ("Abril de 2026") y el que 1930 representa ("Septiembre de 2026").
for (const term of ['Septiembre de 2025', 'Enero de 2026', 'Abril de 2026', 'Septiembre de 2026']) {
  db.prepare("INSERT INTO grades (term, course_code, grade, credits, status) VALUES (?, 'X-1', 'A', 3, 'taken')").run(term);
}

reconcileTerms();

const hoy = new Date(2026, 6, 17); // 17 de julio de 2026
const { terms, current, next } = readTerms(hoy);

// El cruce funcionó: 1930 y "Septiembre de 2026" son UNA fila, no dos.
const septiembre = terms.filter((t) => t.label === 'Septiembre de 2026');
assert.equal(septiembre.length, 1, '1930 y su etiqueta se unificaron en una sola fila');
assert.equal(septiembre[0].code, '1930', 'la fila unificada conserva el STRM');

// El ciclo actual es Abril (contiene a hoy por ventana implícita), sin STRM.
assert.equal(current?.label, 'Abril de 2026');
assert.equal(current?.code, null, 'el ciclo actual todavía no tiene STRM conocido');
assert.equal(current?.hasSchedule, false, 'y por eso no tiene horario inscrito');

// El siguiente es Septiembre = 1930, y sí tiene horario.
assert.equal(next?.code, '1930');
assert.equal(next?.hasSchedule, true, '1930 tiene enrollments');
assert.equal(next?.hasSections, true, '1930 tiene secciones en el catálogo');

// currentTermCode devuelve null (no hay STRM del actual): un GET sin término no
// debe caer en 1930, que es justo el bug que arregla la fase.
assert.equal(currentTermCode(hoy), null);

// Idempotencia y COALESCE: reconciliar de nuevo no duplica ni borra el STRM/
// fechas ya conocidos con los nulls que aporta la etiqueta de grades.
reconcileTerms();
const despues = readTerms(hoy);
assert.equal(despues.terms.length, terms.length, 'reconciliar no duplica términos');
const sept2 = despues.terms.find((t) => t.label === 'Septiembre de 2026');
assert.equal(sept2.code, '1930', 'el STRM sigue');
assert.equal(sept2.startDate, '2026-09-01', 'las fechas no se pisaron con null');

// upsertTerm sin etiqueta ni fecha derivable no guarda basura.
assert.equal(upsertTerm({ code: '9999' }), false, 'un STRM anónimo no entra a la tabla');

await rm(dir, { recursive: true, force: true });
console.log('✓ capa de disco del tiempo (cruce STRM↔etiqueta, current/next, COALESCE idempotente)');
