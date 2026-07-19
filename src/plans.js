import { db } from './db.js';

// Planes de ciclo (plan §5.3): la antesala de la inscripción. Un plan junta
// materias de un término en dos niveles de compromiso: 'desired' (la quiero
// pero no elegí grupo — no aparece en el grid) y 'planned' (con sección
// concreta elegida). El estado no se guarda por su cuenta: lo dicta section_id,
// y estas funciones lo mantienen — así nunca puede haber un item "planned" sin
// sección ni un "desired" con una.

const touchStmt = db.prepare(`UPDATE plans SET updated_at = datetime('now') WHERE id = ?`);

const latestSeatStmt = db.prepare(`
  SELECT status, seats_open, seats_cap, wait_total, captured_at
  FROM seats_snapshot WHERE section_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1
`);

// La misma forma de sección que sirve /api/catalog: la UI reutiliza los mismos
// componentes (SeatBadge, WeeklyGrid) sin re-mapear nada.
function sectionShape(row) {
  if (!row.section_id) return null;
  const seat = latestSeatStmt.get(row.section_id);
  return {
    id: row.section_id,
    term: row.section_term,
    classNbr: row.class_nbr,
    section: row.section,
    component: row.component,
    instructor: row.instructor,
    meetings: row.meetings ? JSON.parse(row.meetings) : [],
    seats: seat
      ? { status: seat.status, open: seat.seats_open, capacity: seat.seats_cap, waitTotal: seat.wait_total }
      : null,
    seatsUpdatedAt: seat?.captured_at ?? null,
  };
}

export function listPlans(userId) {
  return db
    .prepare(
      `SELECT p.id, p.term, p.name, p.updated_at,
              COUNT(i.id) AS item_count,
              COALESCE(SUM(c.credits), 0) AS credits
       FROM plans p
       LEFT JOIN plan_items i ON i.plan_id = p.id
       LEFT JOIN courses c ON c.id = i.course_id
       WHERE p.user_id = ?
       GROUP BY p.id
       ORDER BY p.term DESC, p.created_at`
    )
    .all(userId)
    .map((row) => ({
      id: row.id,
      term: row.term,
      name: row.name,
      itemCount: row.item_count,
      credits: row.credits,
      updatedAt: row.updated_at,
    }));
}

export function readPlan(userId, planId) {
  const plan = db
    .prepare('SELECT id, term, name, updated_at FROM plans WHERE id = ? AND user_id = ?')
    .get(planId, userId);
  if (!plan) throw new Error('Ese plan no existe');

  const items = db
    .prepare(
      `SELECT i.id, i.status, i.note, i.locked, i.section_id,
              c.id AS course_id, c.code, c.subject, c.title, c.credits, c.career, c.catalog_nbr,
              s.term AS section_term, s.class_nbr, s.section, s.component, s.instructor, s.meetings
       FROM plan_items i
       JOIN courses c ON c.id = i.course_id
       LEFT JOIN sections s ON s.id = i.section_id
       WHERE i.plan_id = ?
       ORDER BY i.created_at, i.id`
    )
    .all(planId)
    .map((row) => ({
      id: row.id,
      courseId: row.course_id,
      code: row.code,
      subject: row.subject,
      title: row.title,
      credits: row.credits,
      career: row.career,
      catalogNbr: row.catalog_nbr,
      status: row.status,
      note: row.note,
      locked: !!row.locked,
      section: sectionShape(row),
    }));

  return { id: plan.id, term: plan.term, name: plan.name, updatedAt: plan.updated_at, items };
}

export function createPlan(userId, { term, name }) {
  if (!term?.trim() || !name?.trim()) throw new Error('Un plan necesita término y nombre');
  const { lastInsertRowid } = db
    .prepare('INSERT INTO plans (user_id, term, name) VALUES (?, ?, ?)')
    .run(userId, term.trim(), name.trim());
  return readPlan(userId, lastInsertRowid);
}

// Persiste de una vez la combinación que devolvió el recomendador. Se valida
// todo antes de abrir la transacción para que nunca quede un "plan recomendado"
// a medias si una sección desapareció o pertenece a otro término.
export function createPlanWithItems(userId, { term, name, items }) {
  if (!term?.trim() || !name?.trim()) throw new Error('Un plan necesita término y nombre');
  if (!Array.isArray(items) || items.length === 0) throw new Error('No hay materias recomendadas para crear el plan');

  const seen = new Set();
  const planShape = { term: term.trim() };
  for (const item of items) {
    if (!Number.isInteger(item.courseId) || !Number.isInteger(item.sectionId)) {
      throw new Error('La recomendación tiene una materia o sección inválida');
    }
    if (seen.has(item.courseId)) throw new Error('La recomendación repite una materia');
    seen.add(item.courseId);
    assertSectionBelongs(planShape, item.courseId, item.sectionId);
  }

  db.exec('BEGIN');
  try {
    const { lastInsertRowid: planId } = db
      .prepare('INSERT INTO plans (user_id, term, name) VALUES (?, ?, ?)')
      .run(userId, term.trim(), name.trim());
    const insert = db.prepare(
      `INSERT INTO plan_items (plan_id, course_id, section_id, status, note)
       VALUES (?, ?, ?, 'planned', ?)`
    );
    for (const item of items) insert.run(planId, item.courseId, item.sectionId, item.note ?? null);
    db.exec('COMMIT');
    return readPlan(userId, planId);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function updatePlan(userId, planId, { name }) {
  if (!name?.trim()) throw new Error('El nombre no puede quedar vacío');
  const { changes } = db
    .prepare(`UPDATE plans SET name = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
    .run(name.trim(), planId, userId);
  if (!changes) throw new Error('Ese plan no existe');
  return readPlan(userId, planId);
}

export function deletePlan(userId, planId) {
  // Los items caen por ON DELETE CASCADE.
  const { changes } = db.prepare('DELETE FROM plans WHERE id = ? AND user_id = ?').run(planId, userId);
  if (!changes) throw new Error('Ese plan no existe');
}

export function duplicatePlan(userId, planId) {
  const source = readPlan(userId, planId);
  db.exec('BEGIN');
  try {
    const { lastInsertRowid: newId } = db
      .prepare('INSERT INTO plans (user_id, term, name) VALUES (?, ?, ?)')
      .run(userId, source.term, `${source.name} (copia)`);
    const insert = db.prepare(
      'INSERT INTO plan_items (plan_id, course_id, section_id, status, note, locked) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const item of source.items) {
      insert.run(newId, item.courseId, item.section?.id ?? null, item.status, item.note, item.locked ? 1 : 0);
    }
    db.exec('COMMIT');
    return readPlan(userId, newId);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Una sección solo puede colgarse de un item si es de la materia del item y
// del término del plan: si no, el grid dibujaría un bloque que no corresponde
// a lo que después se mandaría al carrito.
function assertSectionBelongs(plan, courseId, sectionId) {
  const section = db.prepare('SELECT course_id, term FROM sections WHERE id = ?').get(sectionId);
  if (!section) throw new Error('Esa sección no existe');
  if (section.course_id !== courseId) throw new Error('Esa sección es de otra materia');
  if (section.term !== plan.term) throw new Error(`Esa sección es de otro término (${section.term})`);
}

export function addPlanItem(userId, planId, { courseId, sectionId = null, note = null }) {
  const plan = db.prepare('SELECT id, term FROM plans WHERE id = ? AND user_id = ?').get(planId, userId);
  if (!plan) throw new Error('Ese plan no existe');
  if (!db.prepare('SELECT id FROM courses WHERE id = ?').get(courseId)) {
    throw new Error('Esa materia no existe en el catálogo');
  }
  if (db.prepare('SELECT id FROM plan_items WHERE plan_id = ? AND course_id = ?').get(planId, courseId)) {
    throw new Error('Esa materia ya está en el plan');
  }
  if (sectionId != null) assertSectionBelongs(plan, courseId, sectionId);

  db.prepare(
    'INSERT INTO plan_items (plan_id, course_id, section_id, status, note) VALUES (?, ?, ?, ?, ?)'
  ).run(planId, courseId, sectionId, sectionId != null ? 'planned' : 'desired', note);
  touchStmt.run(planId);
  return readPlan(userId, planId);
}

// sectionId acepta tres valores: un id (elegir/cambiar grupo), null (volver la
// materia a "deseada") y undefined (no tocar la sección, solo nota/candado).
export function updatePlanItem(userId, planId, itemId, { sectionId, note, locked }) {
  const plan = db.prepare('SELECT id, term FROM plans WHERE id = ? AND user_id = ?').get(planId, userId);
  if (!plan) throw new Error('Ese plan no existe');
  const item = db
    .prepare('SELECT id, course_id FROM plan_items WHERE id = ? AND plan_id = ?')
    .get(itemId, planId);
  if (!item) throw new Error('Esa materia no está en el plan');

  if (sectionId !== undefined) {
    if (sectionId != null) assertSectionBelongs(plan, item.course_id, sectionId);
    db.prepare('UPDATE plan_items SET section_id = ?, status = ? WHERE id = ?').run(
      sectionId,
      sectionId != null ? 'planned' : 'desired',
      itemId
    );
  }
  if (note !== undefined) db.prepare('UPDATE plan_items SET note = ? WHERE id = ?').run(note, itemId);
  if (locked !== undefined) {
    db.prepare('UPDATE plan_items SET locked = ? WHERE id = ?').run(locked ? 1 : 0, itemId);
  }
  touchStmt.run(planId);
  return readPlan(userId, planId);
}

export function removePlanItem(userId, planId, itemId) {
  readPlan(userId, planId); // 404 si el plan no es de este usuario
  const { changes } = db
    .prepare('DELETE FROM plan_items WHERE id = ? AND plan_id = ?')
    .run(itemId, planId);
  if (!changes) throw new Error('Esa materia no está en el plan');
  touchStmt.run(planId);
  return readPlan(userId, planId);
}
