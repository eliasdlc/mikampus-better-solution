import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { extractSearchResults } from '../src/peoplesoft/catalog.js';
import { parseMeetings } from '../src/shared/meetings.ts';

// Corre el parser del class search contra HTML real volcado por el recon, sin
// tocar el portal. Es la red de seguridad de los selectores: si PeopleSoft
// cambia IDs en un parche, este test falla antes que un barrido en vivo.
// Los fixtures salen de scripts/make-fixture.mjs (volcado real, sin tokens).
const FIXTURES = {
  // Búsqueda "contains ICC3": 4 materias, 12 secciones.
  'fixtures/recon-catalog-ICC3.html': (r) => {
    assert.equal(r.exceeds, false, 'ICC3 no debería exceder el límite');
    assert.equal(r.courses.length, 4, '4 materias');
    assert.deepEqual(
      r.courses.map((c) => `${c.subject}-${c.catalogNbr}`),
      ['ICC-321', 'ICC-331', 'ICC-341', 'ICC-342'],
      'el subject se quita del catalog_nbr ("ICC321" → 321)'
    );

    const total = r.courses.reduce((n, c) => n + c.sections.length, 0);
    assert.equal(total, 12, '12 secciones sin duplicar por el wrapper $span$');

    const first = r.courses[0].sections[0];
    assert.equal(first.classNbr, '5227');
    assert.equal(first.classNameCell, '101-LEC Ordinaria');
    assert.equal(first.status, 'CLOSED', 'el estado sale del src del icono');
    assert.equal(first.instructor, 'Lisibonny Eustina Beato');
    assert.deepEqual(parseMeetings(first.dayTime, first.room), [
      { days: ['Mo'], start: '10:00', end: '13:00', room: null },
    ]);

    // El portal no da título en el listado: por eso courses es el diccionario.
    assert.ok(
      r.courses.every((c) => c.titleFromPortal === null),
      'ninguna materia trae título en el class search'
    );

    const statuses = r.courses.flatMap((c) => c.sections.map((s) => s.status));
    assert.equal(statuses.filter((s) => s === 'OPEN').length, 7);
    assert.equal(statuses.filter((s) => s === 'CLOSED').length, 5);
  },

  // Búsqueda "contains ICC": el portal se niega por exceder 50 secciones.
  'fixtures/recon-catalog-ICC.html': (r) => {
    assert.equal(r.exceeds, true, 'ICC entero excede → hay que trocear');
    assert.equal(r.courses.length, 0, 'una búsqueda excedida no trae resultados');
  },
};

const browser = await chromium.launch();
const page = await browser.newPage();
let failed = 0;

for (const [fixture, check] of Object.entries(FIXTURES)) {
  await page.setContent(await readFile(fixture, 'utf8'));
  const result = await page.evaluate(extractSearchResults);
  try {
    check(result);
    console.log(`✓ ${fixture}`);
  } catch (err) {
    failed++;
    console.error(`✗ ${fixture}\n  ${err.message}`);
  }
}

await browser.close();
if (failed) {
  console.error(`\n${failed} fixture(s) fallaron — probablemente PeopleSoft cambió los IDs.`);
  process.exit(1);
}
console.log('\nParser del class search OK contra HTML real.');
