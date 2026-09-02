// Solver del builder: que enumere exactamente las combinaciones sin choque,
// que las métricas midan lo que dicen medir (huecos, madrugones, días), y que
// mover un peso cambie el ranking en la dirección esperada.
import assert from 'node:assert/strict';
import {
  solveCombinations,
  computeMetrics,
  penaltyOf,
  applyConstraints,
  sectionViolation,
  NO_CONSTRAINTS,
} from '../src/shared/solver.ts';

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

// ── Condiciones duras ──────────────────────────────────────────────────────
// Son la diferencia entre "prefiero" y "no puedo": una condición no penaliza un
// horario, lo elimina. Y cuando elimina TODAS las secciones de una materia, eso
// tiene que salir por la respuesta, no morir en silencio.

const cond = (over) => ({ ...NO_CONSTRAINTS, ...over });

// Sin condiciones, nada cambia respecto del comportamiento de siempre.
{
  const a = section('ICC-303', [meet(['Mo'], '07:00', '09:00')]);
  const { combinations, dropped, blocked } = solveCombinations([course('ICC-303', [a])]);
  assert.equal(combinations.length, 1);
  assert.deepEqual(dropped, []);
  assert.deepEqual(blocked, []);
}

// Hora mínima y hora máxima, cada una con su motivo.
{
  const temprana = section('A', [meet(['Mo'], '07:00', '09:00')]);
  const tardia = section('A', [meet(['Mo'], '19:00', '22:00')]);
  assert.equal(sectionViolation(temprana, cond({ earliestStart: '10:00' })), 'antes-de-la-hora');
  assert.equal(sectionViolation(tardia, cond({ latestEnd: '18:00' })), 'despues-de-la-hora');
  assert.equal(sectionViolation(temprana, cond({ latestEnd: '18:00' })), null, 'termina 09:00, entra');
}

// Un día pedido libre mata la sección aunque la hora sea cómoda.
{
  const sabado = section('A', [meet(['Sa'], '10:00', '13:00')]);
  assert.equal(sectionViolation(sabado, cond({ freeDays: ['Sa'] })), 'dia-que-querias-libre');
  assert.equal(sectionViolation(sabado, cond({ freeDays: ['Fr'] })), null);
}

// Campus: solo excluye lo que se SABE de otro campus. Una sección sin campus
// conocido nunca se descarta, porque no saber no es motivo para descartar.
{
  const santiago = section('A', [meet(['Mo'], '10:00', '12:00')], { campus: 'CSTI' });
  const capital = section('A', [meet(['Mo'], '10:00', '12:00')], { campus: 'CSTA' });
  const sinDato = section('A', [meet(['Mo'], '10:00', '12:00')], { campus: null });
  assert.equal(sectionViolation(santiago, cond({ campuses: ['CSTI'] })), null);
  assert.equal(sectionViolation(capital, cond({ campuses: ['CSTI'] })), 'otro-campus');
  assert.equal(sectionViolation(sinDato, cond({ campuses: ['CSTI'] })), null, 'sin campus no se descarta');
}

// Un meeting TBA (sin hora) no puede violar una condición de hora.
{
  const tba = section('A', [{ days: ['Mo'], start: null, end: null, room: null }]);
  assert.equal(sectionViolation(tba, cond({ earliestStart: '10:00', latestEnd: '12:00' })), null);
}

// Una materia que se queda sin ninguna sección sale en `blocked`, con el motivo,
// y no en `courses`: el estudiante tiene que poder aflojar la condición.
{
  const a1 = section('ICC-303', [meet(['Mo'], '07:00', '09:00')]);
  const a2 = section('ICC-303', [meet(['Tu'], '07:00', '09:00')]);
  const b1 = section('MAT-241', [meet(['We'], '14:00', '16:00')]);

  const { courses, dropped, blocked } = applyConstraints(
    [course('ICC-303', [a1, a2]), course('MAT-241', [b1])],
    cond({ earliestStart: '10:00' })
  );
  assert.equal(courses.length, 1, 'solo sobrevive MAT-241');
  assert.equal(courses[0].code, 'MAT-241');
  assert.equal(dropped.length, 2);
  assert.deepEqual(blocked, [{ code: 'ICC-303', title: 'ICC-303', reasons: ['antes-de-la-hora'] }]);
}

// maxDays se evalúa sobre la combinación entera, no sobre una sección: dos
// clases en días distintos son 2 días aunque cada una por separado sea 1.
{
  const a = section('A', [meet(['Mo'], '10:00', '12:00')]);
  const b = section('B', [meet(['Tu'], '10:00', '12:00')]);
  const bMismoDia = section('B', [meet(['Mo'], '14:00', '16:00')]);

  const dosDias = solveCombinations([course('A', [a]), course('B', [b])], { constraints: cond({ maxDays: 1 }) });
  assert.equal(dosDias.combinations.length, 0, 'dos días no entra en un techo de 1');

  const unDia = solveCombinations([course('A', [a]), course('B', [bMismoDia])], {
    constraints: cond({ maxDays: 1 }),
  });
  assert.equal(unDia.combinations.length, 1);
  assert.equal(unDia.combinations[0].metrics.daysUsed, 1);
}

console.log(
  '✓ Solver OK (enumeración, choques, métricas, ranking por pesos, límite, condiciones duras y materias bloqueadas).'
);
