// Solver del builder: que enumere exactamente las combinaciones sin choque,
// que las métricas midan lo que dicen medir (huecos, madrugones, días), y que
// mover un peso cambie el ranking en la dirección esperada.
import assert from 'node:assert/strict';
import { solveCombinations, computeMetrics, penaltyOf } from '../src/shared/solver.ts';

let nextId = 1;
const section = (code, meetings, over = {}) => ({
  id: nextId++,
  courseId: code.charCodeAt(0),
  code,
  title: code,
  classNbr: String(1000 + nextId),
  section: '101',
  component: 'LEC',
  instructor: null,
  meetings,
  ...over,
});
const meet = (days, start, end) => ({ days, start, end, room: null });
const course = (code, sections) => ({ courseId: code.charCodeAt(0), code, title: code, sections });

// Dos materias, dos secciones cada una; una pareja choca → 3 combos válidos.
{
  const a1 = section('ICC-303', [meet(['Mo', 'We'], '10:00', '13:00')]);
  const a2 = section('ICC-303', [meet(['Tu', 'Th'], '10:00', '13:00')]);
  const b1 = section('MAT-241', [meet(['Mo'], '11:00', '14:00')]); // choca con a1
  const b2 = section('MAT-241', [meet(['Fr'], '08:00', '11:00')]);

  const { combinations, truncated } = solveCombinations([course('ICC-303', [a1, a2]), course('MAT-241', [b1, b2])]);
  assert.equal(truncated, false);
  assert.equal(combinations.length, 3, 'a1+b1 choca → quedan 3 de 4');
  assert.ok(
    combinations.every((c) => c.sections.length === 2),
    'cada combinación tiene una sección por materia'
  );
  assert.ok(
    !combinations.some((c) => c.sections.includes(a1) && c.sections.includes(b1)),
    'la pareja que choca no aparece'
  );
}

// Métricas: hueco de 60min entre clases del mismo día, madrugón de 60min
// (8:00 con corte a las 9:00), y conteo de días.
{
  const m = computeMetrics([
    section('A', [meet(['Mo'], '08:00', '10:00')]),
    section('B', [meet(['Mo'], '11:00', '13:00'), meet(['We'], '15:00', '17:00')]),
  ]);
  assert.equal(m.gapMinutes, 60, 'hueco 10:00→11:00');
  assert.equal(m.earlyMinutes, 60, '8:00 madruga una hora');
  assert.equal(m.daysUsed, 2);
}

// Secciones TBA (sin horario) nunca chocan ni ocupan días.
{
  const tba = section('LAB-1', [meet(['Th'], null, null)]);
  const fixed = section('ICC-303', [meet(['Th'], '10:00', '13:00')]);
  const { combinations } = solveCombinations([course('LAB-1', [tba]), course('ICC-303', [fixed])]);
  assert.equal(combinations.length, 1, 'la TBA no puede chocar');
  assert.equal(combinations[0].metrics.daysUsed, 1, 'la TBA no cuenta como día usado');
}

// El ranking responde a los pesos: una opción compacta con madrugón contra una
// regada sin madrugar. Subir 'earlyStarts' favorece la segunda; subir
// 'fewDays' favorece la primera.
{
  const compactaMadruga = section('X', [meet(['Mo'], '07:00', '13:00')]);
  const regadaTarde = section('X', [meet(['Mo'], '14:00', '16:00'), meet(['We'], '14:00', '16:00'), meet(['Fr'], '14:00', '16:00')]);
  const c = [course('X', [compactaMadruga, regadaTarde])];

  const porMadrugon = solveCombinations(c, { weights: { gaps: 0, earlyStarts: 1, fewDays: 0 } });
  assert.equal(porMadrugon.combinations[0].sections[0], regadaTarde, 'sin madrugar gana si solo pesan los madrugones');

  const porDias = solveCombinations(c, { weights: { gaps: 0, earlyStarts: 0, fewDays: 1 } });
  assert.equal(porDias.combinations[0].sections[0], compactaMadruga, 'compactar gana si solo pesan los días');
}

// Un candado se expresa dejando una sola candidata: el solver no lo sabe y
// aun así el resultado lo respeta.
{
  const lockA = section('A', [meet(['Mo'], '10:00', '12:00')]);
  const b1 = section('B', [meet(['Mo'], '11:00', '13:00')]); // choca con el candado
  const b2 = section('B', [meet(['Tu'], '11:00', '13:00')]);
  const { combinations } = solveCombinations([course('A', [lockA]), course('B', [b1, b2])]);
  assert.equal(combinations.length, 1);
  assert.deepEqual(combinations[0].sections.map((s) => s.id), [lockA.id, b2.id]);
}

// El límite corta la enumeración y lo dice.
{
  const many = (code) => course(code, Array.from({ length: 4 }, () => section(code, [])));
  const { combinations, truncated } = solveCombinations([many('A'), many('B'), many('C')], { limit: 10 });
  assert.equal(combinations.length, 10);
  assert.equal(truncated, true);
}

// Dos clases solapadas que el caller permitió no producen hueco negativo.
{
  const m = computeMetrics([
    section('A', [meet(['Mo'], '10:00', '14:00')]),
    section('B', [meet(['Mo'], '11:00', '12:00'), meet(['Mo'], '15:00', '16:00')]),
  ]);
  assert.equal(m.gapMinutes, 60, 'el hueco se mide contra el fin acumulado (14:00→15:00)');
}

// La penalidad es lineal en los pesos (sanity de la fórmula).
{
  const metrics = { gapMinutes: 30, earlyMinutes: 60, daysUsed: 2 };
  assert.equal(penaltyOf(metrics, { gaps: 1, earlyStarts: 0, fewDays: 0 }), 30);
  assert.equal(penaltyOf(metrics, { gaps: 0, earlyStarts: 1, fewDays: 0 }), 60);
  assert.equal(penaltyOf(metrics, { gaps: 0, earlyStarts: 0, fewDays: 1 }), 360);
}

console.log('✓ Solver OK (enumeración, choques, métricas, ranking por pesos, límite).');
