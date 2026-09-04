// Proyecciones auditables (P5): dos horizontes separados y un guard que
// prefiere no dar número antes que dar uno plausible y falso.
//
// Todos los datos son sintéticos. Ningún fixture contiene historial real.
import assert from 'node:assert/strict';

const {
  reconcileGpa,
  buildProjection,
  creditsInProgressFor,
  projectHorizon,
  scenariosFor,
  OFFICIAL_PRECISION,
} = await import('../src/shared/projection.ts');

// ── Reconciliación ─────────────────────────────────────────────────────────
// El portal publica con un decimal real: 2.800 donde 402/143 da 2.8112. Esa
// diferencia NO es un desacuerdo, es precisión distinta del mismo número.
const oficial = { gpa: 2.8, unitsTowardGpa: 143, gradePoints: 402 };
const mio = { gradePoints: 402, unitsTowardGpa: 143 };

const coincide = reconcileGpa(oficial, mio);
assert.equal(coincide.status, 'match', '2.8112 contra 2.800 es el mismo índice');
assert.ok(coincide.difference <= OFFICIAL_PRECISION);

// Una diferencia real —la que produciría una política distinta de repetidas—
// sí es un desacuerdo y bloquea.
const discrepa = reconcileGpa({ gpa: 3.1, unitsTowardGpa: 143, gradePoints: 443 }, mio);
assert.equal(discrepa.status, 'mismatch');
assert.ok(discrepa.difference > OFFICIAL_PRECISION);
assert.match(discrepa.explanation, /repetidas/i, 'la explicación nombra la causa probable');
assert.match(discrepa.explanation, /3\.100/, 'y muestra las dos cifras');

// Sin datos no es un fallo: es no haber sincronizado.
assert.equal(reconcileGpa(null, mio).status, 'unknown');
assert.equal(reconcileGpa(oficial, null).status, 'unknown');
assert.equal(reconcileGpa(oficial, { gradePoints: 0, unitsTowardGpa: 0 }).status, 'unknown');
assert.match(reconcileGpa(null, mio).explanation, /Actualizá tus notas/);

// ── Créditos en curso: el bug que inflaba el mejor caso ────────────────────
const cursando = [
  { term: 'Abril de 2026', units: 4, status: 'in_progress' },
  { term: 'Abril de 2026', units: 3, status: 'in_progress' },
  // Una materia ya inscrita del ciclo QUE VIENE. Sumarla al "mejor caso de este
  // ciclo" era exactamente el error: son créditos de otro cuatrimestre.
  { term: 'Septiembre de 2026', units: 4, status: 'in_progress' },
  { term: 'Enero de 2026', units: 3, status: 'taken' },
];

assert.equal(creditsInProgressFor(cursando, 'Abril de 2026'), 7, 'solo los créditos en curso de ESE ciclo');
assert.equal(creditsInProgressFor(cursando, 'Septiembre de 2026'), 4);
assert.equal(creditsInProgressFor(cursando, null), 0, 'sin ciclo no se asume ninguno');
assert.equal(creditsInProgressFor(cursando, 'Enero de 2026'), 0, 'lo ya cursado no está en curso');

// ── Un horizonte concreto ──────────────────────────────────────────────────
// 143 créditos en 2.8, más 7 créditos en A: (2.8·143 + 7·4) / 150.
const todoA = projectHorizon({
  id: 'current-term',
  label: 'Al cerrar Abril de 2026',
  baseline: 2.8,
  baselineUnits: 143,
  futureCredits: 7,
  assumedAverage: 4,
});
const esperado = (2.8 * 143 + 7 * 4) / 150;
assert.equal(todoA.exact, Math.round(esperado * 100) / 100, 'el exacto va a dos decimales');
assert.equal(todoA.asPublished, 2.9, 'y se muestra también como lo publicaría PeopleSoft');
assert.equal(todoA.futureCredits, 7);
assert.equal(todoA.assumedAverage, 4);
assert.equal(todoA.baseline, 2.8, 'el baseline es el del portal, no el nuestro');

// Sin baseline no hay número, aunque haya créditos.
assert.equal(projectHorizon({ id: 'graduation', label: 'x', baseline: null, baselineUnits: 0, futureCredits: 20, assumedAverage: 4 }).exact, null);

// Créditos negativos no rompen ni inventan.
assert.equal(
  projectHorizon({ id: 'graduation', label: 'x', baseline: 3, baselineUnits: 10, futureCredits: -5, assumedAverage: 4 }).exact,
  3,
  'sin créditos futuros el índice es el actual'
);

// "Mantener" es un punto fijo: si asumís tu propio promedio, terminás igual.
const abanico = scenariosFor('graduation', 'Hasta graduarte', { baseline: 3.2, baselineUnits: 100, futureCredits: 40 });
assert.equal(abanico.maintain.exact, 3.2, 'mantener el ritmo deja el índice donde está');
assert.ok(abanico.best.exact > abanico.maintain.exact, 'todo A sube');
assert.ok(abanico.floor.exact < abanico.maintain.exact, 'todo C baja');

// ── El informe completo ────────────────────────────────────────────────────
const bueno = buildProjection({
  official: oficial,
  reconstructed: mio,
  currentTermCredits: creditsInProgressFor(cursando, 'Abril de 2026'),
  remainingCredits: 40,
  currentTermLabel: 'Abril de 2026',
});
assert.equal(bueno.reconciliation.status, 'match');
assert.ok(bueno.currentTerm && bueno.graduation, 'con acumulados que cuadran, se proyecta');
assert.equal(bueno.currentTerm.best.futureCredits, 7, 'el ciclo actual solo pone en juego sus 7 créditos');
assert.equal(bueno.graduation.best.futureCredits, 40, 'graduación pone los 40 que faltan');
assert.notEqual(
  bueno.currentTerm.best.exact,
  bueno.graduation.best.exact,
  'los dos horizontes son números distintos, no el mismo repetido'
);
assert.match(bueno.formula, /créditos futuros/, 'la fórmula viaja para poder mostrarse');

// El guard: si no reconcilian, NO hay proyección. Ni el mejor caso, ni el peor.
const bloqueado = buildProjection({
  official: { gpa: 3.4, unitsTowardGpa: 143, gradePoints: 486 },
  reconstructed: mio,
  currentTermCredits: 7,
  remainingCredits: 40,
  currentTermLabel: 'Abril de 2026',
});
assert.equal(bloqueado.reconciliation.status, 'mismatch');
assert.equal(bloqueado.currentTerm, null, 'una discrepancia suspende el horizonte del ciclo');
assert.equal(bloqueado.graduation, null, 'y también el de graduación');
assert.ok(bloqueado.reconciliation.explanation.length > 40, 'y explica por qué en vez de callarse');

// Sin haber sincronizado tampoco se inventa un baseline.
const sinDatos = buildProjection({
  official: null,
  reconstructed: mio,
  currentTermCredits: 7,
  remainingCredits: 40,
  currentTermLabel: null,
});
assert.equal(sinDatos.currentTerm, null);
assert.equal(sinDatos.reconciliation.status, 'unknown');

console.log('✓ proyecciones: dos horizontes acotados, baseline del portal y suspensión honesta cuando no reconcilian');
