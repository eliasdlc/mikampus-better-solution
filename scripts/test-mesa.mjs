// La mesa de inscripción contra una DB desechable. Lo que protege:
//
//   1. Que una materia ya inscrita NO se ofrezca como candidata (sería
//      proponerte inscribir dos veces lo mismo).
//   2. Que los créditos salgan del pénsum y no de `courses.credits`, que en el
//      catálogo real está en NULL 900 de 907 veces: sumar desde ahí daría cero.
//   3. Que la frescura del cupo sea un veredicto y no una opinión de la UI: una
//      observación vieja llega marcada como vieja, con su antigüedad en horas.
//   4. Que el par teórica + práctica sobreviva la ida y vuelta por la selección.
//   5. Que las condiciones duras eliminen secciones y digan qué materia quedó
//      sin salida.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-mesa-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');

const { db } = await import('../src/db.js');
const { readMesa, mesaPlan, SEAT_FRESH_HOURS } = await import('../src/mesa.js');
const plans = await import('../src/plans.js');
const { setHomeCampus } = await import('../src/peoplesoft/catalog.js');

const HOY = new Date('2026-09-01T12:00:00Z');

db.exec(`
  INSERT INTO courses (id, code, subject, catalog_nbr, title, career, credits) VALUES
    (1, 'ICC-321', 'ICC', '321', 'Inteligencia de Negocios', 'GRDO', NULL),
    (2, 'ICC-451', 'ICC', '451', 'Desarrollo de Aplicaciones Móviles', 'GRDO', NULL),
    (3, 'ICC-233', 'ICC', '233', 'Seguridad en TI', 'GRDO', NULL);

  -- ICC-321: teórica y práctica en Santiago (1xx) y en Santo Domingo (2xx).
  INSERT INTO sections (id, course_id, term, class_nbr, section, component, instructor, meetings, campus, campus_source) VALUES
    (10, 1, '1930', '5227', '101', 'LEC', 'L. Beato', '[{"days":["Mo"],"start":"10:00","end":"13:00","room":null}]', 'CSTI', 'seccion'),
    (11, 1, '1930', '5228', '171', 'PRA', 'L. Beato', '[{"days":["We"],"start":"10:00","end":"13:00","room":null}]', 'CSTI', 'seccion'),
    (12, 1, '1930', '1083', '201', 'LEC', 'Otro', '[{"days":["Tu"],"start":"19:00","end":"22:00","room":null}]', 'CSTA', 'seccion'),
    (13, 2, '1930', '5234', '101', 'LEC', 'F. Peña', '[{"days":["Mo"],"start":"18:00","end":"21:00","room":null}]', 'CSTI', 'seccion'),
    (14, 3, '1930', '5225', '101', 'LEC', 'R. Dorville', '[{"days":["Sa"],"start":"10:00","end":"13:00","room":null}]', 'CSTI', 'seccion');

  -- Una observación vieja (julio) y una de hace un rato: la mesa tiene que
  -- distinguirlas sin que la UI haga cuentas.
  INSERT INTO seats_snapshot (section_id, status, captured_at) VALUES
    (10, 'open',   '2026-07-22 15:16:36'),
    (11, 'open',   '2026-07-22 15:16:36'),
    (12, 'closed', '2026-07-22 15:16:36'),
    (13, 'open',   '2026-09-01 09:00:00');

  -- El pénsum es la fuente real de créditos. Sin filas en requirement_progress
  -- ningún grupo está satisfecho y sin filas en pensum toda materia está
  -- pendiente, que es exactamente el estado que la mesa tiene que manejar.
  -- plan_key es la identidad del pénsum compartido y el perfil es lo que la
  -- resuelve para este usuario (ver userPlanId en peoplesoft/advisement.js).
  INSERT INTO pensum_plans (id, plan_key, career, pensum_no, plan_label)
    VALUES (1, 'ICC|2020', 'ICC', '2020', 'Pénsum No. 2020');
  INSERT INTO profile (user_id, career, pensum_no, plan_label) VALUES (1, 'ICC', '2020', 'Pénsum No. 2020');
  INSERT INTO requirement_groups (id, plan_id, parent_id, kind, label, position, year, period) VALUES
    (1, 1, NULL, 'plan',    'Pénsum 2020',      0, NULL, NULL),
    (2, 1, 1,    'periodo', 'Año 3 Período 1',  1, 3,    1),
    (3, 1, 2,    'grupo',   'Obligatorias',     2, NULL, NULL);
  INSERT INTO requirement_courses (group_id, code, title, units, is_candidate) VALUES
    (3, 'ICC-321', 'Inteligencia de Negocios', 4, 0),
    (3, 'ICC-451', 'Desarrollo de Aplicaciones Móviles', 4, 0),
    (3, 'ICC-233', 'Seguridad en TI', 4, 0);

  -- ICC-233 ya inscrita: es el piso de choques y de créditos.
  INSERT INTO enrollments (user_id, term, course_id, section_id, status, units) VALUES
    (1, '1930', 3, 14, 'enrolled', 4);
`);

setHomeCampus(1, 'CSTI');

try {
  const mesa = readMesa(1, '1930', { now: HOY });

  // 1. Lo inscrito arriba, y fuera de las candidatas.
  assert.deepEqual(
    mesa.enrolled.map((c) => c.code),
    ['ICC-233'],
    'ICC-233 entra como inscrita'
  );
  assert.ok(
    !mesa.candidates.some((c) => c.code === 'ICC-233'),
    'una materia ya inscrita nunca se ofrece como candidata'
  );
  assert.deepEqual(mesa.candidates.map((c) => c.code).sort(), ['ICC-321', 'ICC-451']);

  // 2. Créditos del pénsum, no del catálogo (que los tiene en NULL).
  assert.equal(mesa.candidates.find((c) => c.code === 'ICC-321').credits, 4);
  assert.equal(mesa.totals.enrolledCredits, 4, 'los créditos inscritos salen de enrollments.units');
  assert.equal(mesa.totals.selectedCredits, 0);

  // 3. Frescura: la observación de julio llega marcada como vieja, con horas.
  const icc321 = mesa.candidates.find((c) => c.code === 'ICC-321');
  const lec101 = icc321.sections.find((s) => s.classNbr === '5227');
  assert.equal(lec101.seatsFresh, false, 'una observación de julio no es un estado de hoy');
  assert.ok(lec101.seatsAgeHours > 24 * 30, `${lec101.seatsAgeHours}h de antigüedad`);
  const icc451 = mesa.candidates.find((c) => c.code === 'ICC-451');
  assert.equal(icc451.sections[0].seatsFresh, true, 'la de hace tres horas sí es un estado');
  assert.ok(icc451.sections[0].seatsAgeHours <= SEAT_FRESH_HOURS);

  // Campus: Santiago primero, y la procedencia viaja al lado.
  assert.equal(icc321.campusGroups[0].label, 'Campus Santiago');
  assert.equal(icc321.campusGroups[0].isHome, true);
  assert.equal(icc321.campusGroups[1].label, 'Campus Santo Domingo');
  assert.equal(lec101.campusSource, 'seccion', 'el campus es inferencia y lo dice');

  // 4. El par teórica + práctica sobrevive la selección.
  assert.equal(mesa.plan, null, 'la mesa no crea plan hasta que elijas algo');
  const plan = mesaPlan(1, '1930', { create: true });
  plans.addPlanItem(1, plan.id, { courseId: 1, sectionId: 10, relatedSectionId: 11 });

  const conSeleccion = readMesa(1, '1930', { now: HOY });
  const item = conSeleccion.plan.items[0];
  assert.equal(item.section.classNbr, '5227');
  assert.equal(item.relatedSection.classNbr, '5228', 'la práctica queda pegada a su teórica');
  assert.equal(item.relatedSection.component, 'PRA');
  assert.equal(conSeleccion.totals.selectedCredits, 4);
  assert.equal(conSeleccion.totals.credits, 8, 'inscrito más seleccionado');

  // Quitar la teórica se lleva la práctica: una práctica huérfana no se puede
  // mandar al carrito ni dibujar como materia elegida.
  plans.updatePlanItem(1, plan.id, item.id, { sectionId: null });
  const suelta = plans.readPlan(1, plan.id).items[0];
  assert.equal(suelta.section, null);
  assert.equal(suelta.relatedSection, null, 'sin teórica no queda práctica colgando');
  assert.equal(suelta.status, 'desired');

  // Y una práctica sin teórica se rechaza de entrada.
  assert.throws(
    () => plans.updatePlanItem(1, plan.id, item.id, { relatedSectionId: 11 }),
    /teórica elegida primero/
  );

  // 5. La fase existe aunque no haya una sola fecha cargada, y no apaga nada.
  assert.equal(conSeleccion.phase.phase, 'desconocida');
  assert.equal(conSeleccion.phase.capabilities.planear.state, 'habilitada');
  assert.equal(conSeleccion.phase.capabilities.recomendar.state, 'habilitada');

  console.log(
    '✓ mesa: lo inscrito fuera de candidatas, créditos del pénsum, frescura de cupo con su antigüedad, par teórica+práctica y fase sin fechas'
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
