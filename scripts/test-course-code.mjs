import assert from 'node:assert/strict';
import { splitCourseCode, courseCodeToString, portalCatalogNbr } from '../src/shared/courseCode.ts';

// Los casos son los del catálogo real de ICC (fixtures/recon-browse-ICC-expanded.html).
const SUBJECTS = ['ICC', 'ITE', 'MAT', 'FIS'];
const split = (raw, hint) => splitCourseCode(raw, { subjectHint: hint, knownSubjects: SUBJECTS });
const code = (raw, hint) => {
  const c = split(raw, hint);
  return c && courseCodeToString(c);
};

assert.equal(code('ICC223', 'ICC'), 'ICC-223', 'el caso normal: subject pegado al número');
assert.equal(code('ICCE01', 'ICC'), 'ICC-E01', 'electiva: el número lleva letras');
assert.equal(code('ITE326', 'ICC'), 'ITE-326', 'otro subject listado bajo ICC: manda el código, no el grupo');

// "1ITE326" es "Lab. ITE-326" e "ITE326" es la teoría: dos materias, dos
// códigos. Fusionarlas perdía una y le pisaba el título a la otra.
assert.equal(code('1ITE326', 'ICC'), 'ITE-1ITE326', 'el dígito de delante es parte del código');
assert.notEqual(code('1ITE326', 'ICC'), code('ITE326', 'ICC'), 'el lab no colisiona con su teoría');
assert.equal(code('1ICC473', 'ICC'), 'ICC-1ICC473', 'el subject sale del código, no del grupo');

// El Class Search llega sin hint del grupo pero con la lista de subjects.
assert.equal(courseCodeToString(splitCourseCode('ICC223', { knownSubjects: SUBJECTS })), 'ICC-223');
// Y sin nada: las letras de la cabeza son el subject.
assert.equal(courseCodeToString(splitCourseCode('ICC223')), 'ICC-223');
assert.equal(courseCodeToString(splitCourseCode('ICCE01')), 'ICCE-01', 'sin pistas, ICCE01 es ambiguo y se parte mal');

// Lo que de verdad importa: las dos pantallas producen el MISMO código para el
// mismo dato, o el join título↔secciones falla en silencio. El Browse Catalog
// llega con el subject del grupo; el Class Search, con la lista de subjects.
for (const raw of ['ICC223', 'ICCE01', 'ITE326', '1ITE326', '1ICC473']) {
  const desdeBrowse = splitCourseCode(raw, { subjectHint: 'ICC', knownSubjects: SUBJECTS });
  const desdeClassSearch = splitCourseCode(raw, { knownSubjects: SUBJECTS });
  assert.deepEqual(desdeBrowse, desdeClassSearch, `las dos pantallas coinciden en ${raw}`);
  assert.equal(code(raw, 'ICC'), code(` ${raw.toLowerCase()} `, 'icc'), `espacios y minúsculas dan igual (${raw})`);
}

// La vuelta al portal: canónico → lo que el formulario del class search espera.
assert.equal(portalCatalogNbr(split('ICC223', 'ICC')), 'ICC223');
assert.equal(portalCatalogNbr(split('ICCE01', 'ICC')), 'ICCE01');
assert.equal(portalCatalogNbr(split('1ITE326', 'ICC')), '1ITE326', 'con dígito, el catalogNbr ya es el código entero');
for (const raw of ['ICC223', 'ICCE01', 'ITE326', '1ITE326', '1ICC473']) {
  assert.equal(portalCatalogNbr(split(raw, 'ICC')), raw, `ida y vuelta sin pérdida (${raw})`);
}

assert.equal(split('', 'ICC'), null, 'campo vacío');
assert.equal(split('Course Nbr', 'ICC'), null, 'una fila de encabezado no es una materia');
assert.equal(split('ICC', 'ICC'), null, 'el subject solo no es una materia');

console.log('✓ courseCode: ICC223 / ICCE01 / ITE326 / 1ITE326, y las dos pantallas coinciden');
