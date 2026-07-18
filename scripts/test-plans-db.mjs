// Capa de planes contra una DB desechable. Lo que protege: el invariante
// estado↔sección (nunca un 'planned' sin sección ni un 'desired' con una),
// que una sección de otra materia u otro término no pueda colgarse de un item
// (el grid dibujaría un bloque que no es lo que iría al carrito), y que
// duplicar/borrar no deje items huérfanos.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-test-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');

const { db } = await import('../src/db.js');
const plans = await import('../src/plans.js');
const { planDetailSchema, planSummarySchema } = await import('../src/shared/schemas.ts');

db.exec(`
  INSERT INTO courses (id, code, subject, catalog_nbr, title, career, credits) VALUES
    (1, 'ICC-303', 'ICC', '303', 'Estructuras de Datos', 'GRDO', 4),
    (2, 'MAT-241', 'MAT', '241', 'Cálculo Vectorial', 'GRDO', 4);
  INSERT INTO sections (id, course_id, term, class_nbr, section, component, instructor, meetings) VALUES
    (10, 1, '1930', '4567', '101', 'LEC', 'M. Pérez', '[{"days":["Mo","We"],"start":"10:00","end":"13:00","room":"A-201"}]'),
    (11, 1, '1930', '4568', '102', 'LEC', 'J. Núñez', '[]'),
    (12, 2, '1930', '6100', '101', 'LEC', null, '[]'),
    (13, 1, '1931', '9001', '101', 'LEC', null, '[]');
  INSERT INTO seats_snapshot (section_id, status, seats_open, seats_cap) VALUES (10, 'open', 5, 40);
`);

try {
  // Crear y validar contra el contrato que consume el frontend.
  const plan = plans.createPlan({ term: '1930', name: 'Ago–Dic 2026' });
  planDetailSchema.parse(plan);
  assert.equal(plan.items.length, 0);
  assert.throws(() => plans.createPlan({ term: '', name: 'x' }), /término y nombre/);

  // Materia sin grupo: entra como 'desired'.
  let detail = plans.addPlanItem(plan.id, { courseId: 1, note: 'con Pérez si abre' });
  planDetailSchema.parse(detail);
  assert.equal(detail.items[0].status, 'desired');
  assert.equal(detail.items[0].section, null);
  assert.equal(detail.items[0].note, 'con Pérez si abre');

  // La misma materia no entra dos veces.
  assert.throws(() => plans.addPlanItem(plan.id, { courseId: 1 }), /ya está en el plan/);

  // Elegir sección → 'planned', con la sección en la forma del catálogo
  // (meetings parseadas y último snapshot de cupo).
  const itemId = detail.items[0].id;
  detail = plans.updatePlanItem(plan.id, itemId, { sectionId: 10 });
  assert.equal(detail.items[0].status, 'planned');
  assert.equal(detail.items[0].section.classNbr, '4567');
  assert.equal(detail.items[0].section.seats.status, 'open');
  assert.deepEqual(detail.items[0].section.meetings[0].days, ['Mo', 'We']);

  // Guardas: sección de otra materia y sección de otro término.
  assert.throws(() => plans.updatePlanItem(plan.id, itemId, { sectionId: 12 }), /otra materia/);
  assert.throws(() => plans.updatePlanItem(plan.id, itemId, { sectionId: 13 }), /otro término/);

  // Quitar la sección la vuelve 'desired'; tocar solo el candado no la toca.
  detail = plans.updatePlanItem(plan.id, itemId, { locked: true });
  assert.equal(detail.items[0].locked, true);
  assert.equal(detail.items[0].status, 'planned', 'el candado no toca la sección');
  detail = plans.updatePlanItem(plan.id, itemId, { sectionId: null });
  assert.equal(detail.items[0].status, 'desired');
  assert.equal(detail.items[0].section, null);

  // Resumen con créditos sumados.
  plans.updatePlanItem(plan.id, itemId, { sectionId: 11 });
  plans.addPlanItem(plan.id, { courseId: 2 });
  const [summary] = plans.listPlans();
  planSummarySchema.parse(summary);
  assert.equal(summary.itemCount, 2);
  assert.equal(summary.credits, 8);

  // El recomendador persiste su combinación completa en una transacción: cada
  // item nace planned, con sección y con el porqué como nota editable.
  const recommended = plans.createPlanWithItems({
    term: '1930',
    name: 'Plan recomendado',
    items: [
      { courseId: 1, sectionId: 10, note: 'Pendiente del período más viejo.' },
      { courseId: 2, sectionId: 12, note: 'Se oferta y cabe sin choques.' },
    ],
  });
  planDetailSchema.parse(recommended);
  assert.equal(recommended.items.length, 2);
  assert.ok(recommended.items.every((entry) => entry.status === 'planned' && entry.section));
  assert.match(recommended.items[0].note, /período más viejo/);
  const beforeInvalid = plans.listPlans().length;
  assert.throws(
    () => plans.createPlanWithItems({
      term: '1930', name: 'Inválido', items: [{ courseId: 1, sectionId: 13 }],
    }),
    /otro término/
  );
  assert.equal(plans.listPlans().length, beforeInvalid, 'una propuesta inválida no deja plan parcial');

  // Duplicar copia items con sección, nota y candado.
  const copy = plans.duplicatePlan(plan.id);
  assert.equal(copy.name, 'Ago–Dic 2026 (copia)');
  assert.equal(copy.items.length, 2);
  assert.equal(copy.items[0].section.id, 11);
  assert.equal(copy.items[0].locked, true);

  // Borrar el plan no deja items huérfanos (CASCADE).
  plans.deletePlan(copy.id);
  const orphans = db.prepare('SELECT COUNT(*) AS n FROM plan_items WHERE plan_id = ?').get(copy.id).n;
  assert.equal(orphans, 0);
  assert.throws(() => plans.readPlan(copy.id), /no existe/);

  console.log('✓ Capa de planes OK (estado↔sección, recomendado transaccional, guardas, duplicado, cascade).');
} finally {
  await rm(dir, { recursive: true, force: true });
}
