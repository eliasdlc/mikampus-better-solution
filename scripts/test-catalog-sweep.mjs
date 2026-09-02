// El árbol de búsquedas del barrido de catálogo, con un portal falso. Es lo
// único que se puede probar sin PeopleSoft: que el campus sea el PRIMER eje del
// troceo y que no se pierda al bajar por los dígitos.
//
// Lo que no puede probar ningún test y hay que decirlo: que el portal siga
// respondiendo así. Eso se verifica corriendo el barrido de verdad.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

// catalog.js abre la base al importarse: se le da una desechable, aunque este
// test no escriba una sola fila.
const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-test-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
const { sweepSubject } = await import('../src/peoplesoft/catalog.js');

// Un portal de mentira con el corte real de 50 secciones por búsqueda. Las
// cantidades salen de lo que la base ya midió del ciclo 1930: ICC entra entero
// en cada campus, ART no, y LET101 es un código completo que excede él solo.
const CATALOG = {
  CSTI: { ICC321: 39, ART107: 39, ART116: 38, LET101: 60 },
  CSTA: { ICC321: 45, ART107: 24, LET101: 29 },
  CVIR: {},
};

function fakePortal() {
  const searches = [];
  const search = async ({ prefix, campus }) => {
    searches.push({ prefix, campus });
    const matches = Object.entries(CATALOG[campus]).filter(([code]) => code.startsWith(prefix));
    const total = matches.reduce((sum, [, count]) => sum + count, 0);
    if (total > 50) return { exceeds: true, courses: [] };
    return { exceeds: false, courses: matches.map(([code, count]) => ({ code, count })) };
  };
  return { searches, search };
}

function run(subject, options = {}) {
  const portal = fakePortal();
  const saved = [];
  const save = (courses, campus) => {
    for (const course of courses) saved.push({ code: course.code, campus });
    return courses.length;
  };
  return sweepSubject({ subject, ...options }, { search: portal.search, save }).then((result) => ({
    ...result,
    searches: portal.searches,
    saved,
  }));
}

// ── 1. Un subject que entra en cada campus cuesta exactamente tres búsquedas ─
{
  const { searches, saved, skipped } = await run('ICC');
  assert.deepEqual(
    searches,
    [
      { prefix: 'ICC', campus: 'CSTI' },
      { prefix: 'ICC', campus: 'CSTA' },
      { prefix: 'ICC', campus: 'CVIR' },
    ],
    'el campus es el primer eje: mismo prefijo, una vez por campus'
  );
  assert.deepEqual(skipped, []);
  // Y cada fila queda atribuida al campus de la búsqueda que la trajo: el dato
  // lo dice el portal, no el número de sección.
  assert.deepEqual(saved, [
    { code: 'ICC321', campus: 'CSTI' },
    { code: 'ICC321', campus: 'CSTA' },
  ]);
}

// ── 2. El dígito solo entra DENTRO de un campus, y el campus no se pierde ────
{
  const { searches, saved } = await run('ART');
  const santiago = searches.filter((s) => s.campus === 'CSTI').map((s) => s.prefix);
  // CSTI excede (77), así que se subdivide por dígito; CSTA (24) entra directo.
  assert.equal(santiago[0], 'ART');
  assert.ok(santiago.includes('ART1'), 'baja un nivel dentro del campus que excede');
  assert.deepEqual(
    searches.filter((s) => s.campus === 'CSTA').map((s) => s.prefix),
    ['ART'],
    'el campus que entra no paga la subdivisión del otro'
  );
  assert.ok(
    saved.filter((row) => row.campus === 'CSTI').every((row) => row.code.startsWith('ART')),
    'lo que trae la búsqueda filtrada queda atribuido a ese campus'
  );
  assert.deepEqual(
    saved.filter((row) => row.code === 'ART107').map((row) => row.campus).sort(),
    ['CSTA', 'CSTI'],
    'la misma materia aparece en los dos campus, atribuida a cada uno'
  );
}

// ── 3. Un código completo que excede en un campus se reporta con el campus ──
{
  const { skipped, saved } = await run('LET');
  assert.deepEqual(skipped, ['LET101@CSTI'], 'sin dígitos que agregar, se reporta con el campus adentro');
  // El otro campus no se pierde por el que falló.
  assert.deepEqual(saved, [{ code: 'LET101', campus: 'CSTA' }]);
}

// ── 4. La lista de campus es un parámetro: el watcher barre uno solo ─────────
{
  const { searches } = await run('ICC', { campuses: ['CSTI'] });
  assert.deepEqual(searches, [{ prefix: 'ICC', campus: 'CSTI' }], 'con campus elegido cuesta una sola navegación');
}

await rm(dir, { recursive: true, force: true });

console.log('✓ barrido de catálogo: campus como primer eje, dígitos adentro, campus preservado al bajar');
