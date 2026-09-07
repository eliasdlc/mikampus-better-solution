import { db } from '../db.js';
import { activeCourses, courseTree } from './courses.js';
import { readAlerts } from './alerts.js';
import { upcoming } from './calendar.js';
import { completionLabel, submissionState } from '../shared/pva.ts';
import { nowSeconds } from './shape.js';

// Lo que la pantalla Aula necesita, compuesto de una vez.
//
// Las tablas pva_* están normalizadas por dominio (materias, tareas, notas,
// archivos, avisos) porque cada una se sincroniza con su propio ritmo. La
// pantalla no piensa en dominios: piensa en "qué le debo a esta materia" y
// "qué hay en la unidad 3". Este archivo es esa traducción, y vive del lado
// del agente porque compone varias tablas y las lee con la conexión que ya
// tiene abierta.
//
// Dos reglas que se ven abajo:
//   * Un dato que no está se dice, no se rellena. El libro que el profesor
//     ocultó devuelve `hidden: true` con su razón, nunca un cero.
//   * `submitted: null` es "no se consultó", que no es "sin entregar". La
//     pantalla los pinta distinto porque son cosas distintas.

const iso = (seconds) => (seconds == null ? null : new Date(seconds * 1000).toISOString());

/** El estado de una materia: lo que se muestra sin entrar en ella. */
function courseStatus(userId, courseId, { now = Date.now() } = {}) {
  const seconds = nowSeconds(now);
  const total = db
    .prepare('SELECT grade_display AS display FROM pva_course_total WHERE user_id = ? AND course_id = ?')
    .get(userId, courseId);
  const access = db
    .prepare('SELECT show_grades AS showGrades, reachable, last_errorcode AS errorcode FROM pva_gradebook_access WHERE user_id = ? AND course_id = ?')
    .get(userId, courseId);
  // El total del curso y los subtotales de categoría son items del libro,
  // pero no son cosas que se entregan: contarlos infla "3 de 7 calificados".
  const items = db
    .prepare(
      `SELECT COUNT(1) AS total, SUM(CASE WHEN v.graderaw_src IS NOT NULL THEN 1 ELSE 0 END) AS graded
       FROM pva_grade_item i LEFT JOIN pva_grade_value v ON v.item_id = i.item_id
       WHERE i.user_id = ? AND i.course_id = ? AND i.is_gradable = 1
         AND i.itemtype NOT IN ('course', 'category')`
    )
    .get(userId, courseId);

  // Lo próximo de ESTA materia: la entrega sin hacer más cercana. Una tarea
  // entregada no es lo próximo que hay que hacer.
  const next = db
    .prepare(
      `SELECT a.assignment_id AS assignmentId, a.cmid, a.name, a.duedate, a.cutoffdate, a.submissiondrafts,
              s.status, s.timemodified AS submittedAt, s.grading_status AS gradingStatus,
              s.can_edit AS canEdit, s.extensionduedate AS extensionAt
       FROM pva_assignment a
       LEFT JOIN pva_submission s ON s.assignment_id = a.assignment_id AND s.is_latest = 1
       WHERE a.user_id = ? AND a.course_id = ? AND a.duedate IS NOT NULL
         AND (s.status IS NULL OR s.status <> 'submitted')
         AND COALESCE(s.extensionduedate, a.duedate) >= ?
       ORDER BY COALESCE(s.extensionduedate, a.duedate)
       LIMIT 1`
    )
    .get(userId, courseId, seconds);

  const pending = db
    .prepare(
      `SELECT COUNT(1) AS n FROM pva_assignment a
       LEFT JOIN pva_submission s ON s.assignment_id = a.assignment_id AND s.is_latest = 1
       WHERE a.user_id = ? AND a.course_id = ? AND a.duedate IS NOT NULL
         AND (s.status IS NULL OR s.status <> 'submitted')
         AND COALESCE(s.extensionduedate, a.duedate) >= ?`
    )
    .get(userId, courseId, seconds).n;

  return {
    grade: {
      // Sin fila de acceso el libro nunca se consultó, y eso no es un libro
      // vacío: decir "no tiene items calificables" ahí es inventar.
      checked: access != null,
      // El libro puede estar deshabilitado por el sitio o cerrado por el
      // profesor: son dos ausencias distintas y las dos se nombran.
      hidden: access?.showGrades === 0 || access?.reachable === 0,
      reason:
        access?.showGrades === 0
          ? 'Esta materia tiene el libro deshabilitado en la PVA.'
          : access?.reachable === 0
            ? 'El profesor tiene su libro oculto. La nota puede existir igual y verse tarea por tarea.'
            : null,
      total: total?.display ?? null,
      gradedItems: items?.graded ?? 0,
      gradableItems: items?.total ?? 0,
    },
    next: next
      ? {
          assignmentId: next.assignmentId,
          cmid: next.cmid,
          name: next.name,
          dueAt: iso(next.extensionAt ?? next.duedate),
          submitted: next.status == null ? null : next.status === 'submitted',
        }
      : null,
    pending,
  };
}

/** La raíz del Aula: las materias del ciclo y lo que pasa esta semana. */
export function aulaOverview(userId, { now = Date.now(), days = 7 } = {}) {
  const courses = activeCourses(userId).map((course) => ({
    courseId: course.courseId,
    shortname: course.shortname,
    fullname: course.fullname,
    ...courseStatus(userId, course.courseId, { now }),
  }));

  // El feed mezcla lo que vence con lo que ya pasó (una nota publicada, un
  // anuncio): son la misma pregunta, "qué está pasando en mis materias".
  const feed = [
    ...upcoming(userId, { now, days }).map((event) => ({
      id: `due:${event.cmid ?? event.eventId}`,
      kind: 'vence',
      courseId: event.courseId,
      courseShortname: event.courseShortname ?? null,
      title: event.activityName ?? event.name,
      detail: event.submissionStatus == null ? 'No se consultó el estado' : event.submissionStatus === 'submitted' ? 'Entregada' : 'Sin entregar',
      at: iso(event.timesort),
      submitted: event.submissionStatus == null ? null : event.submissionStatus === 'submitted',
      url: event.url ?? null,
    })),
    ...readAlerts(userId, { limit: 20 })
      .filter((alert) => alert.kind !== 'tarea_por_vencer')
      .map((alert) => ({
        id: `alert:${alert.alertId}`,
        kind: alert.kind,
        courseId: alert.courseId,
        courseShortname: null,
        title: alert.title,
        detail: null,
        at: iso(alert.occurredAt),
        submitted: null,
        url: alert.url,
      })),
  ]
    .filter((entry) => entry.at)
    .sort((left, right) => right.at.localeCompare(left.at));

  // Lo que vence va primero aunque sea futuro: el feed contesta "qué tengo que
  // hacer" antes que "qué pasó".
  const porVencer = feed.filter((entry) => entry.kind === 'vence' && entry.submitted !== true).sort((a, b) => a.at.localeCompare(b.at));
  const resto = feed.filter((entry) => !porVencer.includes(entry));

  const shortById = new Map(courses.map((course) => [course.courseId, course.shortname]));
  const items = [...porVencer, ...resto].map((entry) => ({
    ...entry,
    courseShortname: entry.courseShortname ?? shortById.get(entry.courseId) ?? null,
  }));

  return { courses, items };
}

/** Una materia: su estado arriba y las unidades del profesor abajo. */
export function aulaCourse(userId, courseId, { now = Date.now() } = {}) {
  const course = db
    .prepare(
      `SELECT course_id AS courseId, shortname, fullname, progress, hidden
       FROM pva_course WHERE user_id = ? AND course_id = ?`
    )
    .get(userId, courseId);
  if (!course) return null;

  const assignments = new Map(
    db
      .prepare(
        `SELECT a.cmid, a.assignment_id AS assignmentId, a.duedate, a.cutoffdate, a.submissiondrafts,
                s.status, s.timemodified AS submittedAt, s.grading_status AS gradingStatus,
                s.can_edit AS canEdit, s.extensionduedate AS extensionAt,
                f.grade_raw_text AS gradeText, f.grade_for_display AS gradeDisplay
         FROM pva_assignment a
         LEFT JOIN pva_submission s ON s.assignment_id = a.assignment_id AND s.is_latest = 1
         LEFT JOIN pva_submission_feedback f ON f.assignment_id = a.assignment_id AND f.attemptnumber = s.attemptnumber
         WHERE a.user_id = ? AND a.course_id = ?`
      )
      .all(userId, courseId)
      .map((row) => [row.cmid, row])
  );

  const filesByCmid = new Map();
  for (const file of db
    .prepare(
      `SELECT f.file_id AS fileId, f.cmid, f.filename, f.mimetype, f.filesize AS declaredBytes,
              t.file_id AS textId, t.content
       FROM pva_file f LEFT JOIN pva_file_text t ON t.file_id = f.file_id
       WHERE f.user_id = ? AND f.course_id = ? AND f.deleted_at IS NULL
       ORDER BY f.filename`
    )
    .all(userId, courseId)) {
    if (!filesByCmid.has(file.cmid)) filesByCmid.set(file.cmid, []);
    filesByCmid.get(file.cmid).push({
      fileId: file.fileId,
      filename: file.filename,
      mimetype: file.mimetype ?? null,
      downloaded: file.textId != null,
      indexed: Boolean(file.content),
    });
  }

  const linksByCmid = new Map();
  for (const link of db
    .prepare('SELECT cmid, name, url, host FROM pva_link WHERE user_id = ? AND course_id = ? ORDER BY name')
    .all(userId, courseId)) {
    if (!linksByCmid.has(link.cmid)) linksByCmid.set(link.cmid, []);
    linksByCmid.get(link.cmid).push({ name: link.name, url: link.url, host: link.host });
  }

  const seconds = nowSeconds(now);
  const sections = courseTree(userId, courseId).map((section) => ({
    sectionId: section.sectionId,
    number: section.sectionNumber,
    name: section.name,
    summary: section.summaryHtml || null,
    modules: section.modules.map((module) => {
      const assignment = assignments.get(module.cmid) ?? null;
      const state = assignment
        ? submissionState({
            duedate: assignment.duedate ?? null,
            cutoffdate: assignment.cutoffdate ?? null,
            extensionAt: assignment.extensionAt ?? null,
            submissionDrafts: assignment.submissiondrafts ?? 0,
            status: assignment.status ?? null,
            submittedAt: assignment.submittedAt ?? null,
            canEdit: assignment.canEdit === 1,
            gradingStatus: assignment.gradingStatus ?? null,
            nowSeconds: seconds,
          })
        : null;
      return {
        cmid: module.cmid,
        modname: module.modname,
        name: module.name,
        url: module.url ?? null,
        // Los label se pintan y no se abren: presentarlos como enlace lleva a
        // un 404.
        inlineOnly: module.noViewLink === 1,
        completion: completionLabel(module.completionRule, module.completionState),
        dueAt: assignment ? iso(assignment.extensionAt ?? assignment.duedate) : null,
        assignment: assignment
          ? {
              assignmentId: assignment.assignmentId,
              status: assignment.status ?? null,
              submitted: assignment.status == null ? null : assignment.status === 'submitted',
              graded: assignment.gradingStatus === 'graded',
              // Moodle da el número crudo ('92.00000') y el formateado
              // ('92,00 / 100,00'). Al estudiante se le muestra el segundo.
              gradeText: assignment.gradeDisplay ?? assignment.gradeText ?? null,
              isLate: state?.isLate ?? false,
              isOverdue: state?.isOverdue ?? false,
            }
          : null,
        files: filesByCmid.get(module.cmid) ?? [],
        links: linksByCmid.get(module.cmid) ?? [],
      };
    }),
  }));

  return {
    course: { courseId: course.courseId, shortname: course.shortname, fullname: course.fullname, progress: course.progress ?? null },
    ...courseStatus(userId, courseId, { now }),
    sections,
    // Sin contenido bajado no hay unidades que pintar, y eso no es lo mismo
    // que un curso vacío.
    contentsSynced: sections.length > 0,
  };
}
