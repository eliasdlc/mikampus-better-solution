// Parser del carrito contra HTML real (fixtures/recon-cart.html), sin portal.
// Lo que protege: que cada fila salga con horario parseado y código canónico
// (de eso depende proyectar el carrito en el WeeklyGrid de /inscripcion), que
// las filas "atadas" (prácticos sin link propio) no se pierdan, y que el
// título venga del diccionario local cuando existe.
import { chromium } from 'playwright';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

// enrichCartRows toca la DB (subjects + títulos): DB desechable, nunca la real.
const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-test-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');

const { db } = await import('../src/db.js');
const { extractCartRows, enrichCartRows } = await import('../src/peoplesoft/cart.js');

db.exec(`
  INSERT INTO subjects (code) VALUES ('FIS'), ('ICC');
  INSERT INTO courses (code, subject, catalog_nbr, title) VALUES
    ('FIS-139', 'FIS', '139', 'Física II'),
    ('ICC-321', 'ICC', '321', 'Análisis y Diseño de Algoritmos');
`);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(await readFile('fixtures/recon-cart.html', 'utf8'));
const raw = await page.evaluate(extractCartRows);
await browser.close();

try {
  // El fixture tiene 6 filas: 4 con link y 2 atadas (índices 2 y 4).
  assert.equal(raw.length, 6, '6 filas, contando las atadas sin link');
  assert.deepEqual(raw.map((r) => r.index), [0, 1, 2, 3, 4, 5]);

  assert.equal(raw[0].classLabel, 'FIS FIS139-101 (3656)');
  assert.equal(raw[0].dayTime, 'MoWe 8:00AM - 10:00AM');
  assert.equal(raw[0].instructor, 'A. Rivero');
  assert.equal(raw[0].units, '4.00');
  assert.equal(raw[0].campus, 'Campus Santiago');
  assert.equal(raw[0].status, 'CLOSED', 'el estado sale del src del icono, no del alt');

  // Fila atada (práctico de ICC321): sin link, sin créditos propios.
  assert.match(raw[2].classLabel, /^ICC ICC321-171/);
  assert.equal(raw[2].units, '', 'los créditos son de la materia, no del práctico');

  const rows = enrichCartRows(raw);

  assert.equal(rows[0].courseCode, 'FIS-139', 'código canónico con la regla compartida');
  assert.equal(rows[0].title, 'Física II', 'el título sale del diccionario local');
  assert.equal(rows[0].section, '101');
  assert.equal(rows[0].classNbr, '3656', 'el class number sale del paréntesis del label');
  assert.equal(rows[0].credits, 4);
  assert.equal(rows[0].status, 'closed');
  assert.deepEqual(rows[0].meetings, [{ days: ['Mo', 'We'], start: '08:00', end: '10:00', room: null }]);

  assert.equal(rows[2].courseCode, 'ICC-321');
  assert.equal(rows[2].title, 'Análisis y Diseño de Algoritmos');
  assert.equal(rows[2].section, '171');
  assert.equal(rows[2].credits, null);
  assert.deepEqual(rows[2].meetings, [{ days: ['We'], start: '10:00', end: '13:00', room: null }]);

  // Materia que el diccionario local no conoce: el código hace de título.
  const unknown = rows.find((r) => r.courseCode && !['FIS-139', 'ICC-321'].includes(r.courseCode));
  assert.ok(unknown, 'el fixture trae materias fuera del diccionario sembrado');
  assert.equal(unknown.title, unknown.courseCode, 'sin diccionario, el código hace de título');

  console.log('✓ Parser del carrito OK contra HTML real (filas atadas, horario, código canónico).');
} finally {
  await rm(dir, { recursive: true, force: true });
}
