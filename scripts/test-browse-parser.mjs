import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { extractSubjects, extractCourses, parseCourseRows, cleanTitle } from '../src/peoplesoft/browseCatalog.js';

// Corre los parsers del Browse Catalog contra HTML real volcado por el recon,
// sin tocar el portal. Misma red de seguridad que test-catalog-parser.mjs: si
// PeopleSoft cambia los IDs, esto falla antes que un sync en vivo.
const browser = await chromium.launch();
const page = await browser.newPage();

async function load(file) {
  await page.setContent(await readFile(file, 'utf8'));
}

await load('fixtures/recon-browse-landing.html');
const subjects = await page.evaluate(extractSubjects);
assert.ok(subjects.length > 10, `la landing lista subjects (vio ${subjects.length})`);
assert.ok(
  subjects.every((s) => /^[A-Z0-9-]{1,6}$/.test(s.code)),
  'todo código de subject es alfanumérico corto'
);
assert.ok(
  subjects.some((s) => s.code === 'ACC'),
  'ACC está entre los subjects de la letra A'
);
// PUCMM no llenó la descripción del subject: el label es "ACC - ACC". Lo
// dejamos asentado para que si algún día la llenan, este test lo cante.
assert.equal(subjects.find((s) => s.code === 'ACC').description, 'ACC');

await load('fixtures/recon-browse-ICC-expanded.html');
const rows = await page.evaluate(extractCourses);
assert.ok(rows.length > 5, `ICC expandido lista materias (vio ${rows.length})`);
assert.ok(
  rows.every((r) => r.rawNbr && r.title),
  'cada fila trae código y título'
);

const courses = parseCourseRows(rows, { subject: 'ICC', knownSubjects: ['ICC', 'ITE'] });
assert.ok(
  courses.every((c) => c.title && c.title !== c.subject + c.catalogNbr),
  'toda materia trae título real, no el código repetido'
);

const byCode = new Map(courses.map((c) => [`${c.subject}-${c.catalogNbr}`, c.title]));
assert.equal(byCode.get('ICC-223'), 'Bases de Datos', 'el dato que el Class Search no da');
// Los formatos raros del catálogo real de PUCMM, que la regex vieja perdía.
assert.equal(byCode.get('ICC-E01'), 'Electiva de ICC', 'la electiva no se pierde por tener letras en el número');
assert.equal(byCode.get('ITE-326'), 'Introducción Sistemas Digitales', 'ITE326 sale bajo ICC pero se guarda como ITE');
assert.equal(byCode.get('ITE-1ITE326'), 'Lab. ITE-326', 'el lab conserva el dígito y no pisa a su teoría');
assert.equal(byCode.get('ICC-1ICC473'), 'Proyecto de Grado ICC');

// La trampa del wrapper $span$: si el filtro por id exacto se rompe, cada
// materia aparecería dos veces.
assert.equal(new Set(byCode.keys()).size, courses.length, 'sin materias duplicadas por el wrapper $span$');

// El cartel que el portal le pega al título cuando la materia tiene varias
// entradas de catálogo. No está en la fixture de ICC, pero sí llegó a la base:
// 42 materias quedaron tituladas "Cine Latinoamericano*** view multiple
// offerings". Es navegación del portal, no el nombre de la materia.
assert.equal(cleanTitle('Cine Latinoamericano*** view multiple offerings'), 'Cine Latinoamericano');
assert.equal(cleanTitle('Educación Artística Integrada I*** view multiple offerings'), 'Educación Artística Integrada I');
assert.equal(cleanTitle('Bases de Datos'), 'Bases de Datos', 'un título normal no se toca');
// Sin anclar al final, un título que hablara de ofertas perdería texto real.
assert.equal(cleanTitle('*** view multiple offerings de la Materia'), '*** view multiple offerings de la Materia');

await browser.close();
console.log(`✓ browse parser: ${subjects.length} subjects, ${courses.length} materias ICC con título`);
