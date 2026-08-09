// Señales (Fase 10, §12.7). El gate tiene dos mitades: cada señal dice el hecho
// correcto, y NINGUNA se emite por debajo de su umbral de datos.

import assert from 'node:assert/strict';
import {
  recentChange,
  rollingTrend,
  areaPerformance,
  loadVsResult,
  repeatedCourses,
  withdrawnCourses,
  computeInsights,
} from '../src/shared/insights.ts';

const term = (label, sortKey, gpa, unitsTowardGpa) => ({ term: label, sortKey, gpa, unitsTowardGpa });
const course = (code, subject, term, grade, units, status = 'taken') => ({ code, subject, term, grade, units, status });

// ── Tendencia del índice ─────────────────────────────────────────────────────
const subiendo = [
  term('Enero 2025', '2025-01', 2.5, 15),
  term('Abril 2025', '2025-04', 2.8, 15),
  term('Septiembre 2025', '2025-09', 3.2, 15),
];
const t = rollingTrend(subiendo);
assert.equal(t.kind, 'rolling-trend');
assert.equal(t.direction, 'rising');
assert.ok(Math.abs(t.delta - 0.7) < 1e-9, 'delta = 3.2 − 2.5');
assert.equal(t.points.length, 3);

assert.equal(rollingTrend(subiendo.slice(0, 2)), null, 'dos términos no son tendencia');

// El cambio reciente es otra señal y tiene su propio umbral: dos ciclos bastan.
const cambio = recentChange(subiendo.slice(0, 2));
assert.ok(cambio, 'con dos ciclos ya hay cambio reciente');
assert.equal(cambio.kind, 'recent-change');
assert.equal(
  rollingTrend([term('a', '2025-01', 3.0, 15), term('b', '2025-04', 3.05, 15), term('c', '2025-09', 3.02, 15)]).direction,
  'flat',
  'un movimiento menor a un decimal es plano'
);
// Un término en curso (gpa null) no cuenta y no dispara la señal por sí solo.
assert.equal(rollingTrend([...subiendo.slice(0, 2), term('curso', '2026-01', null, 0)]), null);

// ── Rendimiento por área ─────────────────────────────────────────────────────
const areas = [
  course('ICC-101', 'ICC', 'x', 'A', 3),
  course('ICC-102', 'ICC', 'y', 'A', 3),
  course('MAT-101', 'MAT', 'x', 'C', 3),
  course('MAT-102', 'MAT', 'y', 'C', 3),
];
const a = areaPerformance(areas);
assert.equal(a.best.subject, 'ICC');
assert.equal(a.best.gpa, 4.0);
assert.equal(a.worst.subject, 'MAT');
assert.equal(a.worst.gpa, 2.0);
assert.equal(a.best.count, 2);

// Un solo subject con ≥2 materias → no hay con qué comparar.
assert.equal(areaPerformance(areas.slice(0, 2)), null);
// Dos áreas que rinden parejo (diff < 0.3) → no es señal.
assert.equal(
  areaPerformance([
    course('ICC-1', 'ICC', 'x', 'A', 3),
    course('ICC-2', 'ICC', 'y', 'B', 3),
    course('MAT-1', 'MAT', 'x', 'B', 3),
    course('MAT-2', 'MAT', 'y', 'A', 3),
  ]),
  null,
  'áreas parejas no generan señal'
);
// Una materia por subject no llega al umbral.
assert.equal(areaPerformance([course('ICC-1', 'ICC', 'x', 'A', 3), course('MAT-1', 'MAT', 'y', 'F', 3)]), null);

// ── Carga vs. resultado ──────────────────────────────────────────────────────
const carga = [
  term('a', '2024-01', 3.5, 12),
  term('b', '2024-04', 3.4, 13),
  term('c', '2024-09', 2.6, 18),
  term('d', '2025-01', 2.5, 19),
];
const l = loadVsResult(carga);
assert.equal(l.kind, 'load-vs-result');
assert.ok(l.heavy.avgCredits > l.light.avgCredits, 'el grupo pesado carga más créditos');
assert.ok(l.heavy.avgGpa < l.light.avgGpa, 'en estos datos, más carga rinde menos');

assert.equal(loadVsResult(carga.slice(0, 3)), null, 'menos de cuatro términos: sin señal');
// Sin rango de carga real (todos con créditos casi iguales) → no se afirma nada.
assert.equal(
  loadVsResult([
    term('a', '2024-01', 3.5, 15),
    term('b', '2024-04', 2.5, 15),
    term('c', '2024-09', 3.5, 16),
    term('d', '2025-01', 2.5, 16),
  ]),
  null,
  'sin rango de carga no hay carga-vs-resultado'
);

// ── Repetidas y retiradas ────────────────────────────────────────────────────
const historial = [
  course('IIS-223', 'IIS', 'Abril de 2025', 'F', 3),
  course('IIS-223', 'IIS', 'Enero de 2026', 'D', 3),
  // Mismo año, orden alfabético ≠ cronológico: Enero (01) va antes que Abril (04).
  course('MAT-229', 'MAT', 'Abril de 2025', 'F', 4),
  course('MAT-229', 'MAT', 'Enero de 2025', 'R', 4),
  course('FIS-139', 'FIS', 'Septiembre de 2025', 'R', 3),
  course('ICC-303', 'ICC', 'Enero de 2026', 'A', 4),
];
const rep = repeatedCourses(historial);
assert.equal(rep.courses.length, 2, 'IIS-223 y MAT-229 tienen dos intentos');
const iis = rep.courses.find((c) => c.code === 'IIS-223');
assert.deepEqual(iis.attempts.map((x) => x.grade), ['F', 'D'], 'IIS-223: F (2025) antes que D (2026)');
const mat = rep.courses.find((c) => c.code === 'MAT-229');
assert.deepEqual(mat.attempts.map((x) => x.grade), ['R', 'F'], 'MAT-229: Enero antes que Abril del mismo año');
assert.equal(repeatedCourses([course('ICC-303', 'ICC', 'x', 'A', 4)]), null, 'sin repetidas no hay señal');

const wd = withdrawnCourses(historial);
assert.equal(wd.count, 2);
assert.deepEqual(wd.codes.sort(), ['FIS-139', 'MAT-229']);
assert.equal(withdrawnCourses([course('ICC-303', 'ICC', 'x', 'A', 4)]), null, 'sin retiradas no hay señal');

// ── El agregador solo devuelve lo que pasó su umbral ─────────────────────────
const pocas = computeInsights(subiendo.slice(0, 1), [course('ICC-303', 'ICC', 'x', 'A', 4)]);
assert.deepEqual(pocas, [], 'sin datos suficientes, cero señales (nada de consejos genéricos)');

const varias = computeInsights(subiendo, [...areas, ...historial]);
const kinds = varias.map((s) => s.kind);
assert.ok(kinds.includes('rolling-trend') && kinds.includes('area-performance') && kinds.includes('repeated-courses'));

console.log('✓ señales: tendencia/área/carga/repetidas/retiradas, cada una respeta su umbral de datos');

// ── Orden por prioridad (P5 §7) ────────────────────────────────────────────
// El criterio del plan: lo accionable y reciente va antes que el contexto. El
// caso que importa es una CAÍDA del último ciclo — no puede quedar sepultada
// bajo un patrón histórico ni bajo una tendencia de tres ciclos que promedia
// hacia arriba.
{
  const cayendo = [
    term('a', '2025-01', 2.0, 15),
    term('b', '2025-04', 3.5, 15),
    term('c', '2025-09', 3.8, 15),
    term('d', '2026-01', 2.9, 15), // el último ciclo cae casi un punto
  ];
  const cursos = [
    { code: 'IIS-223', subject: 'IIS', term: 'Enero de 2025', grade: 'F', units: 3, status: 'taken' },
    { code: 'IIS-223', subject: 'IIS', term: 'Abril de 2025', grade: 'D', units: 3, status: 'taken' },
    { code: 'MAT-119', subject: 'MAT', term: 'Enero de 2025', grade: 'R', units: 4, status: 'taken' },
    { code: 'ICC-201', subject: 'ICC', term: 'Abril de 2025', grade: 'A', units: 4, status: 'taken' },
    { code: 'ICC-311', subject: 'ICC', term: 'Septiembre de 2025', grade: 'A', units: 4, status: 'taken' },
  ];

  const ordenadas = computeInsights(cayendo, cursos);
  assert.equal(ordenadas[0].kind, 'recent-change', 'una caída reciente encabeza la lista');
  assert.equal(ordenadas[0].direction, 'down');
  assert.equal(ordenadas[0].severity, 'risk', 'una caída material se gana el color de alarma');
  assert.equal(ordenadas[0].actionability, 'act');

  // La tendencia de tres ciclos dice otra cosa y convive sin taparla.
  const tendencia = ordenadas.find((s) => s.kind === 'rolling-trend');
  assert.ok(tendencia, 'la tendencia sigue estando');
  assert.ok(
    ordenadas.indexOf(tendencia) > 0,
    'pero no puede desplazar a la caída del último ciclo, que es lo que la persona siente'
  );

  // Nada marcado como contexto puede colarse delante de algo accionable.
  const primerContexto = ordenadas.findIndex((s) => s.actionability === 'context');
  const ultimoAccionable = ordenadas.map((s) => s.actionability).lastIndexOf('act');
  assert.ok(ultimoAccionable < primerContexto, 'lo accionable va antes que el contexto');

  // Sin deterioro, nada se pinta de alarma.
  const subiendoTodo = computeInsights(
    [term('a', '2025-01', 3.0, 15), term('b', '2025-04', 3.2, 15), term('c', '2025-09', 3.6, 15)],
    cursos.filter((c) => c.grade === 'A')
  );
  assert.ok(subiendoTodo.every((s) => s.severity !== 'risk'), 'el rojo se gana, no se reparte');
}

console.log('✓ señales: una caída del último ciclo encabeza y la tendencia no la tapa');
