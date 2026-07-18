import { db } from './db.js';
import { feasibilityForGoal, projectGpa, roundGpa } from './shared/gpa.ts';

// Metas de índice (Fase 10, §12.7). La capa es CRUD puro sobre la tabla goals;
// el veredicto de cada meta NO vive en la fila —se calcula en vivo contra las
// notas del momento con la aritmética verificada de shared/gpa.ts— para que una
// meta no muestre "alcanzable" con notas de hace tres meses.

// La escala de la PUCMM es 0–4; una meta fuera de ese rango es un error de
// entrada, no algo que el motor deba proyectar.
function assertTarget(target) {
  const n = Number(target);
  if (!Number.isFinite(n) || n <= 0 || n > 4) {
    throw new Error('El índice objetivo tiene que estar entre 0 y 4');
  }
  return Math.round(n * 1000) / 1000;
}

export function listGoals() {
  return db
    .prepare(
      `SELECT id, kind, target, deadline_term AS deadlineTerm, created_at AS createdAt, achieved_at AS achievedAt
       FROM goals ORDER BY created_at DESC, id DESC`
    )
    .all();
}

export function createGoal({ kind = 'gpa', target, deadlineTerm = null } = {}) {
  if (kind !== 'gpa') throw new Error('Por ahora solo se pueden fijar metas de índice');
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO goals (kind, target, deadline_term) VALUES (?, ?, ?)`)
    .run(kind, assertTarget(target), deadlineTerm?.trim() || null);
  return getGoal(Number(lastInsertRowid));
}

export function getGoal(id) {
  const row = db
    .prepare(
      `SELECT id, kind, target, deadline_term AS deadlineTerm, created_at AS createdAt, achieved_at AS achievedAt
       FROM goals WHERE id = ?`
    )
    .get(id);
  if (!row) throw new Error('La meta no existe');
  return row;
}

export function updateGoal(id, { target, deadlineTerm } = {}) {
  getGoal(id); // 404 si no existe, con el mensaje de siempre
  if (target !== undefined) db.prepare(`UPDATE goals SET target = ? WHERE id = ?`).run(assertTarget(target), id);
  if (deadlineTerm !== undefined) {
    db.prepare(`UPDATE goals SET deadline_term = ? WHERE id = ?`).run(deadlineTerm?.trim() || null, id);
  }
  return getGoal(id);
}

export function deleteGoal(id) {
  const { changes } = db.prepare(`DELETE FROM goals WHERE id = ?`).run(id);
  if (!changes) throw new Error('La meta no existe');
  return { deleted: id };
}

// Cruza una meta con el estado real: los totales del índice (summary) y los
// créditos que faltan del pénsum. Devuelve la meta enriquecida con el veredicto
// y el promedio que exige lo restante — el mismo cálculo que las proyecciones.
export function evaluateGoal(goal, { summary, remainingCredits }) {
  const feas = feasibilityForGoal(summary, remainingCredits, goal.target);
  // Dónde terminarías si mantenés tu ritmo actual: contexto para leer el veredicto.
  const current = summary.unitsTowardGpa > 0 ? summary.gradePoints / summary.unitsTowardGpa : null;
  const projectedIfMaintain = current === null ? null : roundGpa(projectGpa(summary, remainingCredits, current) ?? current);
  return {
    ...goal,
    verdict: feas.verdict,
    requiredAverage: feas.requiredAverage === null ? null : Math.round(feas.requiredAverage * 1000) / 1000,
    projectedIfMaintain,
  };
}

export function evaluateGoals(goals, context) {
  return goals.map((goal) => evaluateGoal(goal, context));
}
