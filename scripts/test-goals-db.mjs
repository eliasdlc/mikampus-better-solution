// Capa de metas (Fase 10, §12.7) contra una DB desechable. Lo que protege: el
// CRUD guarda y valida el rango de la escala, y la evaluación cruza la meta con
// las notas reales para dar el veredicto en vivo (nunca guardado en la fila).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-test-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');

const goals = await import('../src/goals.js');

try {
  // Crear y leer.
  const g = goals.createGoal({ target: 3.0, deadlineTerm: 'Septiembre de 2027' });
  assert.equal(g.kind, 'gpa');
  assert.equal(g.target, 3.0);
  assert.equal(g.deadlineTerm, 'Septiembre de 2027');
  assert.equal(g.achievedAt, null, 'el veredicto no se guarda: la fila no lo lleva');
  assert.equal(goals.listGoals().length, 1);

  // La escala es 0–4: fuera de rango es error de entrada.
  assert.throws(() => goals.createGoal({ target: 5 }), /entre 0 y 4/);
  assert.throws(() => goals.createGoal({ target: 0 }), /entre 0 y 4/);
  assert.throws(() => goals.createGoal({ kind: 'gpa-por-area', target: 3 }), /solo se pueden fijar metas de índice/);

  // Actualizar y borrar.
  const up = goals.updateGoal(g.id, { target: 3.2 });
  assert.equal(up.target, 3.2);
  assert.throws(() => goals.updateGoal(9999, { target: 3 }), /no existe/);
  goals.deleteGoal(g.id);
  assert.equal(goals.listGoals().length, 0);
  assert.throws(() => goals.deleteGoal(g.id), /no existe/);

  // Evaluación en vivo contra el histórico real (402/143, 81 faltantes).
  const context = { summary: { gradePoints: 402, unitsTowardGpa: 143 }, remainingCredits: 81 };
  const reach = goals.evaluateGoal(goals.createGoal({ target: 3.0 }), context);
  assert.equal(reach.verdict, 'reachable');
  assert.ok(Math.abs(reach.requiredAverage - 270 / 81) < 1e-3, 'exige ~3.33 de promedio');
  assert.equal(reach.projectedIfMaintain, 2.8, 'si mantenés el ritmo terminás en 2.8');

  const impossible = goals.evaluateGoal(goals.createGoal({ target: 3.5 }), context);
  assert.equal(impossible.verdict, 'unreachable', '3.5 no se alcanza ni con todo A en lo que falta');

  const all = goals.evaluateGoals(goals.listGoals(), context);
  assert.equal(all.length, 2);
  assert.ok(all.every((x) => 'verdict' in x));

  console.log('✓ metas: CRUD con rango de escala validado + veredicto en vivo (reachable/unreachable)');
} finally {
  await rm(dir, { recursive: true, force: true });
}
