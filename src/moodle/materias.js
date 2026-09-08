import { db } from '../db.js';
import { splitCourseTitle } from '../shared/pva.ts';
import { nowSeconds } from './shape.js';

// Las materias del ciclo, con lo que la PVA no sabe.
//
// La universidad crea DOS clases por materia y el profesor usa una. Para Moodle
// son dos inscripciones sin relación; para el estudiante es la misma materia
// duplicada. Acá el par se reconoce con dos señales que ya están en la base:
// el mismo nombre y el número de clase pegado.
//
// Dos límites que este módulo respeta:
//
//   1. Esconder es una preferencia LOCAL. Nunca toca la PVA, siempre se puede
//      deshacer, y lo que la persona ya escondió en la plataforma se sigue
//      respetando por separado.
//   2. "Sin contenido" no prueba que sea la copia. Un profesor puede empezar a
//      usar la otra clase en la semana cinco, así que mikampus propone con la
//      evidencia a la vista y no decide solo.

/** El nombre sin código, en minúsculas y sin acentos: la llave de un par. */
export function pairKey(fullname, shortname) {
  return splitCourseTitle(fullname, shortname)
    .name.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const COURSE_FIELDS = `
  c.course_id AS courseId, c.shortname, c.fullname, c.progress, c.last_access AS lastAccess,
  c.hidden AS hiddenRemote, c.startdate AS startDate,
  p.hidden_at AS hiddenAt,
  (SELECT COUNT(1) FROM pva_module m WHERE m.course_id = c.course_id AND m.user_id = c.user_id) AS modules,
  (SELECT COUNT(1) FROM pva_assignment a WHERE a.course_id = c.course_id AND a.user_id = c.user_id) AS assignments,
  (SELECT COUNT(1) FROM pva_file f WHERE f.course_id = c.course_id AND f.user_id = c.user_id AND f.deleted_at IS NULL) AS files
`;

function shape(row) {
  const { name } = splitCourseTitle(row.fullname, row.shortname);
  return {
    courseId: row.courseId,
    shortname: row.shortname,
    fullname: row.fullname,
    name,
    progress: row.progress ?? null,
    lastAccess: row.lastAccess ?? null,
    startDate: row.startDate ?? null,
    hiddenRemote: row.hiddenRemote === 1,
    hiddenLocal: row.hiddenAt != null,
    // La evidencia con la que se decide un par, y la misma que se le muestra a
    // la persona: números, no una conclusión.
    modules: row.modules,
    assignments: row.assignments,
    files: row.files,
  };
}

/** Las materias del ciclo que se muestran: ni escondidas allá ni escondidas acá. */
export function visibleCourses(userId) {
  return db
    .prepare(
      `SELECT ${COURSE_FIELDS}
       FROM pva_course c LEFT JOIN pva_course_pref p ON p.user_id = c.user_id AND p.course_id = c.course_id
       WHERE c.user_id = ? AND c.hidden = 0 AND c.missing_since IS NULL AND p.hidden_at IS NULL
       ORDER BY c.shortname`
    )
    .all(userId)
    .map(shape);
}

/**
 * Las materias escondidas, agrupadas por de dónde vienen.
 *
 * Dos grupos distintos que la pantalla no puede mezclar: la copia sin usar de
 * una materia que estás cursando, y las materias de un ciclo que terminó.
 */
export function archivedCourses(userId) {
  const visibles = new Set(visibleCourses(userId).map((course) => pairKey(course.fullname, course.shortname)));
  const rows = db
    .prepare(
      `SELECT ${COURSE_FIELDS}
       FROM pva_course c LEFT JOIN pva_course_pref p ON p.user_id = c.user_id AND p.course_id = c.course_id
       WHERE c.user_id = ? AND c.missing_since IS NULL AND (c.hidden = 1 OR p.hidden_at IS NOT NULL)
       ORDER BY c.startdate DESC, c.shortname`
    )
    .all(userId)
    .map(shape);

  // Dos grupos y no uno por mes: las fechas de inicio de un mismo cuatrimestre
  // no coinciden entre cursos, así que agrupar por ellas parte el archivo en
  // cinco montoncitos que no significan nada. El mes viaja en cada materia.
  const conCiclo = rows.map((course) => ({ ...course, cycle: cycleLabel(course.startDate) }));
  const esCopia = (course) => visibles.has(pairKey(course.fullname, course.shortname));
  return {
    copies: conCiclo.filter(esCopia),
    previous: conCiclo.filter((course) => !esCopia(course)),
  };
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/**
 * De cuándo es un ciclo, con lo único que la PVA da: la fecha de inicio del
 * curso. No es el nombre oficial del cuatrimestre y por eso no se inventa uno.
 */
export function cycleLabel(startDate) {
  if (!startDate) return 'sin fecha de inicio';
  const fecha = new Date(startDate * 1000);
  return `${MESES[fecha.getMonth()]} de ${fecha.getFullYear()}`;
}

/**
 * Los pares vivos: dos materias visibles con el mismo nombre.
 *
 * Devuelve la evidencia de cada una y cuál parece la copia, sin esconder nada.
 * Un par sobre el que ya se decidió no vuelve a aparecer.
 */
export function coursePairs(userId) {
  const decididos = new Set(
    db
      .prepare('SELECT DISTINCT pair_key AS key FROM pva_course_pref WHERE user_id = ? AND pair_key IS NOT NULL')
      .all(userId)
      .map((row) => row.key)
  );
  const porNombre = new Map();
  for (const course of visibleCourses(userId)) {
    const key = pairKey(course.fullname, course.shortname);
    if (!porNombre.has(key)) porNombre.set(key, []);
    porNombre.get(key).push(course);
  }

  const peso = (course) => course.modules + course.assignments * 3 + course.files;
  return [...porNombre.entries()]
    .filter(([key, courses]) => courses.length > 1 && !decididos.has(key))
    .map(([key, courses]) => {
      const ordenadas = [...courses].sort((left, right) => peso(right) - peso(left));
      const usada = ordenadas[0];
      const otras = ordenadas.slice(1);
      return {
        key,
        name: usada.name,
        courses: ordenadas,
        // Solo se señala una copia cuando la diferencia es evidente: con las dos
        // vacías, o las dos con contenido, mikampus no sabe y lo dice.
        suggested: otras.every((course) => peso(course) === 0) && peso(usada) > 0 ? otras.map((course) => course.courseId) : [],
      };
    });
}

/** Esconder una materia acá. No toca la PVA y se deshace. */
export function hideCourse(userId, courseId, { key = null, now = Date.now() } = {}) {
  db.prepare(
    `INSERT INTO pva_course_pref (user_id, course_id, hidden_at, pair_key, decision, updated_at)
     VALUES (?, ?, ?, ?, 'escondida', ?)
     ON CONFLICT(user_id, course_id) DO UPDATE SET
       hidden_at = excluded.hidden_at, pair_key = COALESCE(excluded.pair_key, pva_course_pref.pair_key),
       decision = 'escondida', updated_at = excluded.updated_at`
  ).run(userId, courseId, nowSeconds(now), key, nowSeconds(now));
}

/** Devolverla a la lista. La fila queda con el rastro de la decisión. */
export function showCourse(userId, courseId, { now = Date.now() } = {}) {
  db.prepare(
    `INSERT INTO pva_course_pref (user_id, course_id, hidden_at, decision, updated_at)
     VALUES (?, ?, NULL, 'conservada', ?)
     ON CONFLICT(user_id, course_id) DO UPDATE SET
       hidden_at = NULL, decision = 'conservada', updated_at = excluded.updated_at`
  ).run(userId, courseId, nowSeconds(now));
}

/** "Dejar las dos": el par no se vuelve a proponer. */
export function keepPair(userId, key, courseIds, { now = Date.now() } = {}) {
  for (const courseId of courseIds) {
    db.prepare(
      `INSERT INTO pva_course_pref (user_id, course_id, hidden_at, pair_key, decision, updated_at)
       VALUES (?, ?, NULL, ?, 'conservada', ?)
       ON CONFLICT(user_id, course_id) DO UPDATE SET
         pair_key = excluded.pair_key, decision = 'conservada', updated_at = excluded.updated_at`
    ).run(userId, courseId, key, nowSeconds(now));
  }
}
