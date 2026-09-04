import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { browserLaunchOptions } from '../src/browser.js';

// Los plazos de baja por clase, contra el HTML real del modal.
//
// Este scraper se escribió a ciegas y el recon del 2026-09-03 desmintió su
// premisa entera: "Enrollment Deadlines" no publica las etapas del ciclo, sino
// tres fechas de UNA clase que dicen qué le pasa a tu récord si la das de baja.
// El fixture es esa pantalla, así que el test protege lo que de verdad hay.

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-test-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');

const {
  extractEnrollmentDeadlines,
  parseEnrollmentDeadlines,
  saveClassDropDeadlines,
  readClassDropDeadlines,
} = await import('../src/peoplesoft/enrollmentDeadlines.js');
const { dropConsequence, mapDropDeadlineLabel, resolveNumericDateOrder, numericDateToISO } = await import(
  '../src/shared/dropDeadlines.ts'
);

try {
  // ── La pantalla real ──────────────────────────────────────────────────────
  const browser = await chromium.launch(await browserLaunchOptions());
  const page = await browser.newPage();
  await page.setContent(await readFile('fixtures/recon-enrollment-deadlines.html', 'utf8'));
  const raw = await page.evaluate(extractEnrollmentDeadlines);
  await browser.close();

  assert.equal(raw.title, 'Enrollment Deadlines');
  assert.equal(raw.session, 'Regular Academic Session');
  // Sin el NRC la fila no se puede guardar: los plazos son de la clase, y dos
  // clases distintas se pisarían bajo la misma llave.
  assert.equal(raw.classNbr, '5225', 'el NRC sale de "Full Class Specifications"');
  assert.match(raw.classLabel, /^ICC ICC233/, 'y la materia, del encabezado del modal');
  assert.equal(raw.rows.length, 3, 'la pantalla publica exactamente tres plazos');

  const { deadlines, unmapped, unreadable } = parseEnrollmentDeadlines(raw);
  assert.deepEqual(unmapped, [], 'las tres etiquetas reales se reconocen');
  assert.deepEqual(unreadable, [], 'y sus fechas se leen');
  assert.deepEqual(
    { deleteBy: deadlines.deleteBy, retainBy: deadlines.retainBy, penaltyFrom: deadlines.penaltyFrom },
    { deleteBy: '2026-08-25', retainBy: '2026-09-04', penaltyFrom: '2026-09-05' }
  );

  // ── El orden de la fecha numérica se deduce, no se asume ──────────────────
  // "08/25/2026" resuelve el conjunto entero: 25 solo puede ser el día.
  assert.equal(resolveNumericDateOrder(['08/25/2026', '09/04/2026', '09/05/2026']), 'month-first');
  assert.equal(resolveNumericDateOrder(['25/08/2026', '04/09/2026']), 'day-first');
  // Con todas ambiguas no se elige: una fecha equivocada acá le diría al
  // estudiante que su baja no deja rastro cuando sí lo deja.
  assert.equal(resolveNumericDateOrder(['03/09/2026', '04/09/2026']), null);
  assert.equal(resolveNumericDateOrder(['25/08/2026', '08/25/2026']), null, 'un portal que se contradice no se resuelve');
  assert.equal(numericDateToISO('08/25/2026', 'month-first'), '2026-08-25');
  assert.equal(numericDateToISO('25/08/2026', 'day-first'), '2026-08-25');

  // Una pantalla con las tres fechas ambiguas se reporta ilegible entera.
  const ambigua = parseEnrollmentDeadlines({
    session: 'Regular Academic Session',
    classNbr: '9999',
    rows: [
      { label: 'Drop - Delete Record', value: '03/09/2026' },
      { label: 'Drop - Retain Record', value: '04/09/2026' },
    ],
  });
  assert.equal(ambigua.unreadable.length, 2, 'sin nada que desambigüe, no se adivina');
  assert.equal(ambigua.deadlines.deleteBy, null);

  // Una etiqueta que no conocemos se reporta, no se acomoda a la más parecida.
  assert.equal(mapDropDeadlineLabel('Withdraw from all classes'), null);
  assert.equal(mapDropDeadlineLabel('Drop - Delete Record'), 'delete-record');
  assert.equal(mapDropDeadlineLabel('drop with penalty'), 'with-penalty');

  // ── Qué pasa si la doy de baja hoy ────────────────────────────────────────
  // Es lo único que estas fechas contestan y el calendario institucional no.
  assert.equal(dropConsequence(deadlines, '2026-08-20').level, 'delete');
  assert.equal(dropConsequence(deadlines, '2026-08-25').level, 'delete', 'el borde es inclusivo: "on or before"');
  assert.equal(dropConsequence(deadlines, '2026-08-26').level, 'retain');
  assert.equal(dropConsequence(deadlines, '2026-09-04').level, 'retain');
  assert.equal(dropConsequence(deadlines, '2026-09-05').level, 'penalty');
  assert.equal(dropConsequence(deadlines, '2026-11-01').level, 'penalty');
  assert.equal(
    dropConsequence({ classNbr: '1', session: 'x', deleteBy: null, retainBy: null, penaltyFrom: null }, '2026-09-04').level,
    'desconocida',
    'sin fechas no se afirma ninguna consecuencia'
  );

  // ── Persistencia por clase ────────────────────────────────────────────────
  saveClassDropDeadlines(1, '1930', deadlines);
  saveClassDropDeadlines(1, '1930', { ...deadlines, classNbr: '5226', retainBy: '2026-09-10' });
  const guardados = readClassDropDeadlines(1, '1930');
  assert.equal(guardados.length, 2, 'una fila por clase, no una por ciclo');
  assert.equal(guardados[0].classNbr, '5225');
  assert.equal(guardados[1].retainBy, '2026-09-10');

  // Releer la misma clase actualiza en vez de duplicar.
  saveClassDropDeadlines(1, '1930', { ...deadlines, retainBy: '2026-09-07' });
  const releidos = readClassDropDeadlines(1, '1930');
  assert.equal(releidos.length, 2, 'el upsert es por (usuario, ciclo, clase)');
  assert.equal(releidos.find((row) => row.classNbr === '5225').retainBy, '2026-09-07');

  assert.throws(
    () => saveClassDropDeadlines(1, '1930', { ...deadlines, classNbr: null }),
    /NRC/,
    'sin NRC no se guarda: la fila se pisaría con la de otra clase'
  );

  console.log('✓ plazos de baja: tres fechas por clase, orden numérico deducido y la consecuencia de darla de baja hoy');
} finally {
  await rm(dir, { recursive: true, force: true });
}
