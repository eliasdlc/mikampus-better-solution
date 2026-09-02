// El orden canónico de campus: el del estudiante primero, lo desconocido
// después de lo conocido, y Virtual al final. Vive en el backend para que
// ninguna pantalla lo reimplemente, así que se prueba puro, sin DB.
import assert from 'node:assert/strict';
import {
  campusFromSectionNumber,
  campusLabel,
  campusRank,
  groupByCampus,
  orderByCampus,
  UNKNOWN_CAMPUS_LABEL,
} from '../src/shared/campus.ts';

// Una sección reducida a lo que el orden mira. El resto de sus campos no
// participa: por eso las funciones son genéricas.
const s = (id, campus) => ({ id, campus });

// ── 1. La inferencia por número de sección, y sobre todo lo que NO infiere ───
{
  assert.equal(campusFromSectionNumber('101'), 'CSTI');
  assert.equal(campusFromSectionNumber('171'), 'CSTI', 'las prácticas siguen el mismo dígito');
  assert.equal(campusFromSectionNumber('201'), 'CSTA');
  assert.equal(campusFromSectionNumber('271'), 'CSTA');
  // Sin evidencia no se inventa: la única 0xx atribuida volvió en la búsqueda de
  // Santo Domingo, no en la de Virtual.
  assert.equal(campusFromSectionNumber('030'), null, '0xx no es Virtual: no hay evidencia');
  assert.equal(campusFromSectionNumber('888'), null);
  assert.equal(campusFromSectionNumber(null), null);
  assert.equal(campusFromSectionNumber(''), null);
}

// ── 2. El rango: el campus propio manda, lo desconocido no se disfraza ──────
{
  assert.equal(campusRank('CSTI', 'CSTI'), 0);
  assert.equal(campusRank('CSTA', 'CSTI'), 1);
  assert.equal(campusRank(null, 'CSTI'), 2, 'sin confirmar va después de lo conocido');
  assert.equal(campusRank('CVIR', 'CSTI'), 3, 'Virtual no compite por ubicación');
  // Sin campus elegido, los dos presenciales empatan: nadie es "el primero".
  assert.equal(campusRank('CSTI', null), campusRank('CSTA', null));
  assert.equal(campusLabel(null), UNKNOWN_CAMPUS_LABEL);
  assert.equal(campusLabel('CVIR'), 'Campus Virtual');
}

// ── 3. El orden conserva el criterio de quien llama dentro de cada campus ────
{
  const sections = [s('101', 'CSTI'), s('201', 'CSTA'), s('030', null), s('901', 'CVIR'), s('102', 'CSTI')];

  assert.deepEqual(
    orderByCampus(sections, 'CSTI').map((x) => x.id),
    ['101', '102', '201', '030', '901'],
    'las del campus propio primero, y adentro el orden de entrada intacto'
  );
  assert.deepEqual(
    orderByCampus(sections, 'CSTA').map((x) => x.id),
    ['201', '101', '102', '030', '901'],
    'con el otro campus elegido, se invierten los presenciales y nada más'
  );
  assert.deepEqual(
    orderByCampus(sections, null).map((x) => x.id),
    ['101', '201', '102', '030', '901'],
    'sin campus elegido el orden de entrada manda entre presenciales'
  );
  // No muta la lista que recibe: el orden es una vista, no un efecto.
  assert.equal(sections[0].id, '101');
}

// ── 4. Agrupación: encabezado por campus, en el mismo orden ─────────────────
{
  const groups = groupByCampus([s('201', 'CSTA'), s('101', 'CSTI'), s('030', null)], 'CSTI');
  assert.deepEqual(
    groups.map((g) => [g.campus, g.label, g.isHome, g.items.map((x) => x.id)]),
    [
      ['CSTI', 'Campus Santiago', true, ['101']],
      ['CSTA', 'Campus Santo Domingo', false, ['201']],
      [null, UNKNOWN_CAMPUS_LABEL, false, ['030']],
    ]
  );

  // Una materia de un solo campus da un solo grupo: si la UI le pusiera
  // encabezado sería ruido, y esa decisión es de la UI, no de acá.
  const single = groupByCampus([s('101', 'CSTI'), s('102', 'CSTI')], 'CSTI');
  assert.equal(single.length, 1);
  assert.equal(single[0].items.length, 2);

  // Sin campus elegido no hay grupo "propio": nada se marca como tuyo.
  assert.deepEqual(
    groupByCampus([s('101', 'CSTI')], null).map((g) => g.isHome),
    [false]
  );
}

console.log('✓ orden de campus: el propio primero, lo desconocido explícito, Virtual al final');
