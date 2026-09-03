import { SEAT_FRESH_HOURS, seatAgeHours } from './shared/sections.ts';
import { readCatalog, readHomeCampus } from './peoplesoft/catalog.js';
import { readGrades } from './peoplesoft/grades.js';
import { readRequirementTree } from './peoplesoft/advisement.js';
import { readSchedule } from './peoplesoft/mySchedule.js';
import { pendingOfferedCourses } from './shared/recommend.ts';
import { termPhase } from './termEvents.js';
import { db } from './db.js';
import * as plans from './plans.js';

// La mesa de inscripción: todo lo que hace falta para decidir qué materias
// inscribir en un ciclo, resuelto de una sola vez.
//
// Es un endpoint compuesto y no cinco llamadas sueltas porque las cinco piezas
// solo significan algo juntas: lo ya inscrito define los choques y la carga
// base, lo pendiente define las candidatas, el campus define el orden, la fase
// define qué botones sirven, y la antigüedad del cupo define cuánto de todo eso
// se puede creer. Repartirlas obligaba a cada pantalla a re-derivar la misma
// composición, y a equivocarse distinto en cada una.

// Cuánto puede envejecer una observación de cupo antes de dejar de dibujarse
// como estado. El número y la regla viven en shared/sections.ts porque la etapa
// de grupos del cliente aplica exactamente la misma: dos definiciones hacían que
// la misma sección se leyera "Abierta" en una pantalla y "sin dato reciente" en
// la otra, y la que mentía era justo aquella desde la que se decide.
export { SEAT_FRESH_HOURS };

function ageHours(capturedAt, now) {
  const hours = seatAgeHours(capturedAt, now);
  return hours == null ? null : Math.max(0, hours);
}

// La sección tal como la mesa la muestra: la del catálogo más el veredicto de
// frescura ya resuelto. `seats` se conserva crudo a propósito: esconder el
// estado viejo sería tan deshonesto como pintarlo de verde.
function decorateSection(section, now) {
  const hours = ageHours(section.seatsUpdatedAt, now);
  return {
    ...section,
    seatsAgeHours: hours,
    seatsFresh: hours != null && hours <= SEAT_FRESH_HOURS,
  };
}

function decorateCourse(course, now) {
  return {
    ...course,
    sections: course.sections.map((section) => decorateSection(section, now)),
    campusGroups: course.campusGroups.map((group) => ({
      ...group,
      sections: group.sections.map((section) => decorateSection(section, now)),
    })),
  };
}

// Lo que ya está inscrito en el ciclo, con la forma de sección del catálogo.
// No es editable desde la mesa (dar de baja es otra operación, en Inscripción):
// entra como piso fijo de choques y de créditos.
function enrolledForTerm(userId, term, now) {
  const schedule = readSchedule(userId, term);
  return (schedule?.courses ?? []).map((course) => ({
    ...course,
    sections: (course.sections ?? []).map((section) => decorateSection(section, now)),
  }));
}

// El plan sobre el que trabaja la mesa. Hay uno por ciclo y se crea al primer
// toque: obligar a nombrar un plan antes de poder elegir una materia era justo
// la fricción que hizo que la tabla `plans` siguiera vacía.
//
// `planId` explícito manda sobre todo lo demás, y es lo que hace que la hoja
// para secretaría muestre EL plan que estás armando. Cuando la mesa vivía en su
// propia pantalla se conformaba con un plan propio llamado "Mesa"; desde que
// elegir el grupo y armar el plan son el mismo paso, ese plan aparte sería una
// segunda selección que contradice la que estás viendo.
export const MESA_PLAN_NAME = 'Mesa';

export function mesaPlan(userId, term, { create = false, planId = null } = {}) {
  if (planId != null) {
    const explicito = plans.readPlan(userId, planId);
    // Un plan de otro ciclo no describe esta mesa: se ignora en vez de mezclar
    // dos términos en la misma pantalla.
    if (explicito && explicito.term === term) return explicito;
  }
  const row = db
    .prepare('SELECT id FROM plans WHERE user_id = ? AND term = ? ORDER BY (name = ?) DESC, id LIMIT 1')
    .get(userId, term, MESA_PLAN_NAME);
  if (row) return plans.readPlan(userId, row.id);
  if (!create) return null;
  // "Mi ciclo" y no "Mesa": desde que elegir el grupo es un paso del recorrido y
  // no una pantalla aparte, un plan que lleva el nombre de la pantalla que lo
  // creó no le dice nada a nadie. MESA_PLAN_NAME se conserva para reconocer los
  // que ya existen en bases viejas.
  return plans.createPlan(userId, { term, name: 'Mi ciclo' });
}

/**
 * Arma el estado completo de la mesa para un ciclo.
 *
 * `now` entra por parámetro y no se lee del reloj acá adentro: la frescura del
 * cupo y la fase del ciclo dependen de la fecha, y un cálculo que consulta el
 * reloj por dentro no se puede probar contra un día fijo.
 */
export function readMesa(userId, term, { now = new Date(), planId = null } = {}) {
  if (!term?.trim()) throw new Error('No hay un ciclo para armar la mesa');
  const cycle = term.trim();

  const catalog = readCatalog(cycle);
  const byId = new Map(catalog.courses.map((course) => [course.id, course]));

  const pending = pendingOfferedCourses({
    requirements: readRequirementTree(userId),
    history: readGrades(userId).map((course) => ({ courseCode: course.code, status: course.status })),
    catalog: catalog.courses,
  });

  const enrolled = enrolledForTerm(userId, cycle, now);
  const enrolledCodes = new Set(enrolled.map((course) => course.code));

  // Una materia ya inscrita no es candidata. El pénsum tarda en enterarse (su
  // sync es de otra pantalla), así que el filtro va acá y no en el motor.
  const candidates = pending
    .filter((course) => !enrolledCodes.has(course.code))
    .map((course) => {
      const full = byId.get(course.courseId);
      return { ...course, ...decorateCourse(full, now), credits: course.credits };
    });

  // Los créditos de una materia elegida salen del pénsum cuando existe, igual
  // que en las candidatas: `courses.credits` está casi siempre en NULL. El
  // crédito resuelto se pega al item y no solo al total, porque la hoja que se
  // lleva a la oficina imprime la columna por fila: si el item se queda con el
  // NULL crudo, el papel sale con la columna vacía y un total que no cuadra.
  // Sigue siendo null cuando de verdad no se sabe: un 0 dibujado es un dato
  // inventado.
  const creditsByCourse = new Map(pending.map((course) => [course.courseId, course.credits]));
  const creditsOf = (item) => creditsByCourse.get(item.courseId) ?? item.credits ?? null;

  const rawPlan = mesaPlan(userId, cycle, { planId });
  const plan = rawPlan
    ? { ...rawPlan, items: rawPlan.items.map((item) => ({ ...item, credits: creditsOf(item) })) }
    : null;
  const selected = (plan?.items ?? []).filter((item) => item.section);

  const enrolledCredits = enrolled.reduce((sum, course) => sum + (course.units ?? course.credits ?? 0), 0);
  const selectedCredits = selected.reduce((sum, item) => sum + (item.credits ?? 0), 0);

  const lastSeat = db.prepare('SELECT MAX(captured_at) AS at FROM seats_snapshot').get()?.at ?? null;

  return {
    term: cycle,
    generatedAt: now.toISOString(),
    homeCampus: readHomeCampus(userId),
    phase: termPhase(userId, { term: cycle, today: now }),
    enrolled,
    candidates,
    plan,
    seats: {
      capturedAt: lastSeat,
      ageHours: ageHours(lastSeat, now),
      fresh: (ageHours(lastSeat, now) ?? Infinity) <= SEAT_FRESH_HOURS,
      freshHours: SEAT_FRESH_HOURS,
    },
    totals: {
      enrolledCredits,
      selectedCredits,
      credits: enrolledCredits + selectedCredits,
      enrolledCourses: enrolled.length,
      selectedCourses: selected.length,
    },
  };
}
