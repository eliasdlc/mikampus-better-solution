// Verifica el viaje completo de las notas contra una DB desechable:
// parser → saveGrades → readGrades → la forma que sirve /api/grades.
//
// Lo que protege: el parser tenía subject y catalogNbr, la tabla no los
// guardaba, y readGrades los devolvía en undefined. El sync se veía perfecto
// (los datos venían del parser) y la pantalla se rompía recién al recargar,
// leyendo de la base. Un test del parser solo jamás lo hubiera visto.
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-test-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');

const { extractCourseHistory, parseCourseHistory, saveGrades, readGrades, termSummaries } = await import(
  '../src/peoplesoft/grades.js'
);
const { gradesResponseSchema } = await import('../src/shared/schemas.ts');
const { summarizeGrades } = await import('../src/shared/gpa.ts');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(await readFile('fixtures/recon-course-history.html', 'utf8'));
const raw = await page.evaluate(extractCourseHistory);
await browser.close();

const courses = parseCourseHistory(raw.rows, { knownSubjects: ['ICC', 'ESG', 'ART', 'DEP', 'ET', 'ILE', 'GFA', 'IIS'] });
saveGrades(1, courses);

const leidas = readGrades(1);
assert.equal(leidas.length, courses.length, 'vuelve de la base todo lo que entró');

// La respuesta que sirve el endpoint, validada con el mismo esquema que el
// frontend exige. Acá es donde saltaba el bug.
const respuesta = gradesResponseSchema.parse({
  generatedAt: new Date().toISOString(),
  syncedAt: null,
  terms: termSummaries(leidas),
  summary: summarizeGrades(leidas),
});
assert.equal(respuesta.terms.length, 10, 'los 10 términos sobreviven al viaje por la base');

// Ningún campo se pierde en el camino: leído de la base tiene que valer lo
// mismo que recién parseado.
const desdeBase = respuesta.terms.flatMap((t) => t.courses).find((c) => c.code === 'ICC-302');
const delParser = courses.find((c) => c.code === 'ICC-302');
assert.equal(desdeBase.subject, 'ICC');
assert.equal(desdeBase.catalogNbr, '302');
assert.equal(desdeBase.grade, delParser.grade);
assert.equal(desdeBase.units, delParser.units);
assert.equal(desdeBase.status, delParser.status);
assert.equal(desdeBase.term, delParser.term);

// El índice calculado desde la base es el mismo que desde el parser: si la
// base perdiera el estado o los créditos, el índice cambiaría en silencio.
assert.deepEqual(summarizeGrades(leidas), summarizeGrades(courses), 'el índice no cambia al pasar por la base');
assert.equal(respuesta.summary.unitsTowardGpa, 143);
assert.equal(respuesta.summary.gradePoints, 402);

// El sync reemplaza el histórico entero: una materia en curso pasa a
// calificada, no se agrega una segunda fila.
saveGrades(1, courses);
assert.equal(readGrades(1).length, courses.length, 're-sincronizar no duplica el histórico');

await rm(dir, { recursive: true, force: true });
console.log(`✓ capa de escritura de notas (${courses.length} materias, ida y vuelta sin pérdidas)`);
