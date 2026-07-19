// Proyecciones de índice (Fase 10, §12.7). El gate: los números cuadran a mano
// contra el histórico real (402 puntos / 143 créditos al índice, 81 créditos
// faltantes del advisement), y el veredicto "inalcanzable" solo aparece cuando
// de verdad ni todo A alcanza — la política de repetición ya está verificada
// (PUCMM promedia; ver src/shared/gpa.ts y test-grades-parser.mjs).

import assert from 'node:assert/strict';
import { projectGpa, projectFinalGpa, feasibilityForGoal, roundGpa } from '../src/shared/gpa.ts';

const real = { gradePoints: 402, unitsTowardGpa: 143 };
const FALTAN = 81;

// ── El abanico honesto ───────────────────────────────────────────────────────
const fan = projectFinalGpa(real, FALTAN);
assert.equal(fan.remainingCredits, 81);
assert.equal(fan.current, 2.8, 'índice actual redondeado como el portal (402/143 = 2.811 → 2.8)');
// todo A: (402 + 81·4) / (143 + 81) = 726/224 = 3.241 → 3.2
assert.equal(fan.best, 3.2, 'mejor caso: todo A en lo que falta');
// mantener histórico es un punto fijo: terminás en tu mismo índice
assert.equal(fan.maintain, 2.8, 'si mantenés tu promedio, terminás igual');
// todo C: (402 + 81·2) / 224 = 564/224 = 2.518 → 2.5
assert.equal(fan.floor, 2.5, 'piso razonable: todo C, no todo F');
assert.ok(fan.floor <= fan.maintain && fan.maintain <= fan.best, 'el abanico está ordenado');

// projectGpa exacto (sin redondear) para el caso "mantener"
const exactMaintain = projectGpa(real, FALTAN, real.gradePoints / real.unitsTowardGpa);
assert.ok(Math.abs(exactMaintain - real.gradePoints / real.unitsTowardGpa) < 1e-9, 'mantener es punto fijo exacto');

// ── Veredictos de meta ───────────────────────────────────────────────────────
// req(T) = (T·224 − 402) / 81
const t30 = feasibilityForGoal(real, FALTAN, 3.0);
assert.equal(t30.verdict, 'reachable');
assert.ok(Math.abs(t30.requiredAverage - 270 / 81) < 1e-9, '3.0 exige 3.33 de promedio (≈ B+)');

const t32 = feasibilityForGoal(real, FALTAN, 3.2);
assert.equal(t32.verdict, 'tight', '3.2 exige 3.89 — casi todo A');

const t35 = feasibilityForGoal(real, FALTAN, 3.5);
assert.equal(t35.verdict, 'unreachable', '3.5 exige 4.72 > 4: ni con todo A');
assert.ok(t35.requiredAverage > 4, 'el promedio exigido supera el máximo de la escala');

const t15 = feasibilityForGoal(real, FALTAN, 1.5);
assert.equal(t15.verdict, 'secured', '1.5 se sostiene aunque saques F en todo lo que falta');

// ── Bordes ───────────────────────────────────────────────────────────────────
// Sin créditos por delante: la meta ya está decidida contra el índice del portal.
const done = feasibilityForGoal(real, 0, 2.8);
assert.equal(done.verdict, 'met');
assert.equal(done.requiredAverage, null, 'sin créditos restantes no hay promedio que exigir');
assert.equal(feasibilityForGoal(real, 0, 3.0).verdict, 'unreachable', 'sin créditos, 3.0 ya no se alcanza');

// Estudiante sin notas (onboarding): no hay índice, pero sí se puede proyectar.
const fresh = { gradePoints: 0, unitsTowardGpa: 0 };
const fanFresh = projectFinalGpa(fresh, FALTAN);
assert.equal(fanFresh.current, null, 'sin créditos calificados no hay índice, no es 0.00');
assert.equal(fanFresh.best, 4.0, 'todo A desde cero da 4.0');
assert.equal(fanFresh.maintain, null, 'no hay histórico que mantener');
assert.equal(projectGpa(fresh, 0, 4), null, 'sin créditos de ningún tipo no hay proyección');

console.log('✓ proyecciones: abanico 3.2/2.8/2.5 sobre 81 faltantes, veredictos reachable/tight/unreachable/secured/met');
