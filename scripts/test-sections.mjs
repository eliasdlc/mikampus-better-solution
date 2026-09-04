import assert from 'node:assert/strict';
import { lectureSections, practiceSections, hasPractice, isPractice } from '../src/shared/sections.ts';

// Qué es un grupo y qué es una práctica.
//
// Existe porque el bug que este módulo cierra era invisible: listar
// `course.sections` crudo no falla, solo ofrece laboratorios como si fueran
// grupos alternativos de la misma materia. En un catálogo real eso es casi un
// tercio de las filas, y elegir "el grupo" podía guardar una práctica como si
// fuera la clase.

const s = (id, component, campus = 'Santiago') => ({ id, component, campus });

const ICC302 = [
  s(1, 'LEC'),
  s(2, 'PRA'),
  s(3, 'LEC', 'Santo Domingo'),
  s(4, 'PRA', 'Santo Domingo'),
  s(5, 'PRA'),
];

assert.deepEqual(
  lectureSections(ICC302).map((x) => x.id),
  [1, 3],
  'los grupos son las teóricas, en el orden en que vinieron'
);

assert.equal(hasPractice(ICC302), true);
assert.equal(hasPractice([s(1, 'LEC'), s(3, 'LEC')]), false, 'una materia sin laboratorio no tiene prácticas');
assert.equal(isPractice(s(9, 'PRA')), true);
assert.equal(isPractice(s(9, null)), false, 'un componente desconocido no se asume práctica');

// Una materia sin laboratorio devuelve sus secciones tal cual: el filtro no
// puede vaciar la lista de la mayoría de las materias.
const SIN_LAB = [s(10, 'LEC'), s(11, null)];
assert.deepEqual(lectureSections(SIN_LAB).map((x) => x.id), [10, 11]);

// ── Acotar la práctica al campus de su teórica ──────────────────────────────
// Una práctica en otra ciudad no es una opción real: ofrecerla es ofrecer un
// par que el portal va a rechazar.
assert.deepEqual(
  practiceSections(ICC302, s(1, 'LEC', 'Santiago')).map((x) => x.id),
  [2, 5],
  'solo las prácticas del campus de la teórica'
);
assert.deepEqual(
  practiceSections(ICC302, s(3, 'LEC', 'Santo Domingo')).map((x) => x.id),
  [4],
  'y cambian con la teórica elegida'
);

// Sin campus conocido no se filtra. Descartar por un dato ausente escondería
// opciones válidas, que es peor que mostrar una de más.
assert.deepEqual(
  practiceSections(ICC302, s(1, 'LEC', null)).map((x) => x.id),
  [2, 4, 5],
  'una teórica sin campus no puede acotar nada'
);
assert.deepEqual(
  practiceSections([s(20, 'PRA', null), s(21, 'PRA', 'Santo Domingo')], s(1, 'LEC', 'Santiago')).map((x) => x.id),
  [20],
  'una práctica sin campus se conserva; una de otro campus no'
);
assert.deepEqual(practiceSections(SIN_LAB, s(10, 'LEC')), [], 'sin prácticas no hay nada que ofrecer');
assert.deepEqual(practiceSections(ICC302, null).map((x) => x.id), [2, 4, 5], 'sin teórica elegida no se acota');

console.log('✓ secciones: el grupo es la teórica, la práctica se acota a su campus y nunca se ofrece como grupo');
