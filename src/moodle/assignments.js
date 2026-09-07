import { db, logSync } from '../db.js';
import { callPva } from './session.js';
import { bool01, epoch, int, nowSeconds, real, text, textOrNull } from './shape.js';

// Tareas y estado de entrega.
//
// `mod_assign_get_assignments(courseids[])` es una sola llamada para toda la
// matrícula activa: trae el catálogo con fechas, configuración de plugins y los
// avisos de módulos que el estudiante no puede ver.
// `mod_assign_get_submission_status(assignid)` es una llamada por tarea y es la
// única fuente de si todavía se puede tocar.
//
// Lo que este archivo trata con cuidado, todo verificado en el recon:
//
//   * El `0` de una fecha es "no hay fecha", y en `cutoffdate` los dos extremos
//     se distinguen solo por ese cero: `0` acepta tarde indefinidamente,
//     `cutoffdate == duedate` no acepta nada tarde.
//   * La respuesta de estado es una unión discriminada: con `gradingstatus`
//     distinto de `graded` la clave `feedback` NO EXISTE. No llega null ni {}.
//   * `extensionduedate` llega `0` en unas respuestas y `null` en otras, y las
//     dos significan lo mismo: sin prórroga.
//   * `feedback.grade.grade` es un string decimal de 5 decimales, no un número.
//   * `cansubmit` fue `false` en las tres respuestas del volcado, incluso en las
//     editables: con `submissiondrafts = 0` no hay paso de confirmación, así que
//     un botón atado a `cansubmit` no se habilita nunca. La edición se rige por
//     `canedit`.

const STATUSES = new Set(['new', 'draft', 'submitted', 'reopened']);

export function saveAssignments(userId, payload, { now = Date.now() } = {}) {
  const stamp = nowSeconds(now);
  const upsert = db.prepare(
    `INSERT INTO pva_assignment (
       assignment_id, user_id, cmid, course_id, name, intro_html, intro_format,
       duedate, allowsubmissionsfromdate, cutoffdate, gradingduedate, timelimit_s, grade_max,
       nosubmissions, submissiondrafts, requiresubmissionstatement, attemptreopenmethod, maxattempts,
       completionsubmit, teamsubmission, blindmarking, markingworkflow, gradepenalty,
       sendstudentnotifications, remote_timemodified, fetched_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(assignment_id) DO UPDATE SET
       cmid = excluded.cmid, course_id = excluded.course_id, name = excluded.name,
       intro_html = excluded.intro_html, intro_format = excluded.intro_format,
       duedate = excluded.duedate, allowsubmissionsfromdate = excluded.allowsubmissionsfromdate,
       cutoffdate = excluded.cutoffdate, gradingduedate = excluded.gradingduedate,
       timelimit_s = excluded.timelimit_s, grade_max = excluded.grade_max,
       nosubmissions = excluded.nosubmissions, submissiondrafts = excluded.submissiondrafts,
       requiresubmissionstatement = excluded.requiresubmissionstatement,
       attemptreopenmethod = excluded.attemptreopenmethod, maxattempts = excluded.maxattempts,
       completionsubmit = excluded.completionsubmit, teamsubmission = excluded.teamsubmission,
       blindmarking = excluded.blindmarking, markingworkflow = excluded.markingworkflow,
       gradepenalty = excluded.gradepenalty, sendstudentnotifications = excluded.sendstudentnotifications,
       remote_timemodified = excluded.remote_timemodified, fetched_at = excluded.fetched_at`
  );
  const upsertConfig = db.prepare(
    `INSERT INTO pva_assignment_config (assignment_id, subtype, plugin, name, value)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(assignment_id, subtype, plugin, name) DO UPDATE SET value = excluded.value`
  );
  const upsertWarning = db.prepare(
    `INSERT INTO pva_assignment_inaccessible (user_id, course_id, cmid, warningcode, message, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, course_id, cmid) DO UPDATE SET
       warningcode = excluded.warningcode, message = excluded.message, fetched_at = excluded.fetched_at`
  );

  let assignments = 0;
  const seen = [];
  db.exec('BEGIN');
  try {
    for (const course of payload.courses ?? []) {
      for (const assignment of course.assignments ?? []) {
        const id = int(assignment.id);
        upsert.run(
          id,
          userId,
          int(assignment.cmid),
          int(assignment.course ?? course.id),
          text(assignment.name),
          text(assignment.intro),
          int(assignment.introformat, 1),
          epoch(assignment.duedate),
          epoch(assignment.allowsubmissionsfromdate),
          epoch(assignment.cutoffdate),
          epoch(assignment.gradingduedate),
          int(assignment.timelimit, 0),
          int(assignment.grade, 0),
          bool01(assignment.nosubmissions),
          bool01(assignment.submissiondrafts),
          bool01(assignment.requiresubmissionstatement),
          text(assignment.attemptreopenmethod, 'none'),
          int(assignment.maxattempts, 1),
          bool01(assignment.completionsubmit),
          bool01(assignment.teamsubmission),
          bool01(assignment.blindmarking),
          bool01(assignment.markingworkflow),
          bool01(assignment.gradepenalty),
          bool01(assignment.sendstudentnotifications, 1),
          int(assignment.timemodified, 0),
          stamp
        );
        // `value` es siempre string, incluso los números y los booleanos:
        // compararlo contra 1 o contra true da falso en todos los casos.
        for (const config of assignment.configs ?? []) {
          upsertConfig.run(id, text(config.subtype), text(config.plugin), text(config.name), text(config.value));
        }
        assignments += 1;
        seen.push(id);
      }
    }
    // Módulos que el servidor dice que existen y el estudiante no puede ver. Se
    // guardan para poder explicar el hueco en vez de fingir que no está.
    //
    // El warning no dice de qué curso es, y en un lote con varios courseids no
    // hay forma de atribuirlo por posición. Se intenta por cmid contra los
    // módulos ya sincronizados; como el mapa avisa que esos cmid no aparecen en
    // el contenido visible, lo normal es que no resuelva y quede en 0.
    const courseOfCmid = db.prepare('SELECT course_id AS courseId FROM pva_module WHERE user_id = ? AND cmid = ?');
    for (const warning of payload.warnings ?? []) {
      if (warning.item !== 'module') continue;
      const cmid = int(warning.itemid);
      const courseId = int(warning.courseid) ?? courseOfCmid.get(userId, cmid)?.courseId ?? 0;
      upsertWarning.run(userId, courseId, cmid, text(warning.warningcode), text(warning.message), stamp);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { assignments, courses: payload.courses?.length ?? 0, inaccessible: payload.warnings?.length ?? 0, seen };
}

export async function syncAssignments(userId, { call = callPva, courseIds, now = Date.now() } = {}) {
  if (!courseIds?.length) {
    logSync({ userId, kind: 'pvaAssignments', status: 'ok', detail: 'sin materias activas', rows: 0 });
    return { assignments: 0, courses: 0, inaccessible: 0, seen: [] };
  }
  // Un lote con todos los cursos: el objeto de curso llega aunque no tenga
  // tareas, así que la respuesta también dice cuáles están vacíos.
  const payload = await call('mod_assign_get_assignments', { courseids: courseIds });
  const result = saveAssignments(userId, payload, { now });
  logSync({
    userId,
    kind: 'pvaAssignments',
    status: 'ok',
    detail: `${result.assignments} tarea(s) en ${result.courses} materia(s)`,
    rows: result.assignments,
  });
  return result;
}

// ── Estado de entrega ──────────────────────────────────────────────────────

function commentFromFeedback(feedback) {
  const comments = (feedback?.plugins ?? []).find((plugin) => plugin.type === 'comments');
  const field = (comments?.editorfields ?? []).find((entry) => entry.name === 'comments');
  return field ? { html: text(field.text), format: int(field.format, 0) } : null;
}

export function saveSubmissionStatus(userId, assignmentId, payload, { now = Date.now() } = {}) {
  const stamp = nowSeconds(now);
  const attempt = payload?.lastattempt ?? null;
  if (!attempt) return { saved: false, reason: 'sin lastattempt' };

  const submission = attempt.submission ?? null;
  const status = text(submission?.status, 'new');
  if (!STATUSES.has(status)) throw new Error(`Estado de entrega desconocido: ${status}`);
  const attemptNumber = int(submission?.attemptnumber, 0);

  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO pva_submission (
         assignment_id, attemptnumber, submission_id, user_id, status, is_latest, group_id,
         timecreated, timemodified, timestarted, submissions_enabled, locked, graded,
         can_edit, can_edit_owner, can_submit, grading_status, extensionduedate, timelimit_s,
         blindmarking, fetched_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(assignment_id, attemptnumber) DO UPDATE SET
         submission_id = excluded.submission_id, status = excluded.status, is_latest = excluded.is_latest,
         group_id = excluded.group_id, timecreated = excluded.timecreated,
         timemodified = excluded.timemodified, timestarted = excluded.timestarted,
         submissions_enabled = excluded.submissions_enabled, locked = excluded.locked,
         graded = excluded.graded, can_edit = excluded.can_edit, can_edit_owner = excluded.can_edit_owner,
         can_submit = excluded.can_submit, grading_status = excluded.grading_status,
         extensionduedate = excluded.extensionduedate, timelimit_s = excluded.timelimit_s,
         blindmarking = excluded.blindmarking, fetched_at = excluded.fetched_at`
    ).run(
      assignmentId,
      attemptNumber,
      int(submission?.id),
      userId,
      status,
      bool01(submission?.latest, 1),
      int(submission?.groupid, 0),
      epoch(submission?.timecreated),
      epoch(submission?.timemodified),
      epoch(submission?.timestarted),
      bool01(attempt.submissionsenabled, 1),
      bool01(attempt.locked),
      bool01(attempt.graded),
      bool01(attempt.canedit),
      bool01(attempt.caneditowner),
      bool01(attempt.cansubmit),
      text(attempt.gradingstatus, 'notgraded'),
      // Llega 0 en unas respuestas y null en otras: las dos son "sin prórroga".
      epoch(attempt.extensionduedate),
      int(attempt.timelimit, 0),
      bool01(attempt.blindmarking),
      stamp
    );

    // La clave `feedback` solo existe cuando gradingstatus es 'graded'. Cuando
    // no está, la fila de nota se borra: la nota pudo haberse retirado.
    if (payload.feedback) {
      const grade = payload.feedback.grade ?? {};
      const comment = commentFromFeedback(payload.feedback);
      db.prepare(
        `INSERT INTO pva_submission_feedback (
           assignment_id, attemptnumber, grade_id, grade_value, grade_raw_text, grade_for_display,
           graded_date, grader_user_id, timecreated, timemodified, comment_html, comment_format
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(assignment_id, attemptnumber) DO UPDATE SET
           grade_id = excluded.grade_id, grade_value = excluded.grade_value,
           grade_raw_text = excluded.grade_raw_text, grade_for_display = excluded.grade_for_display,
           graded_date = excluded.graded_date, grader_user_id = excluded.grader_user_id,
           timecreated = excluded.timecreated, timemodified = excluded.timemodified,
           comment_html = excluded.comment_html, comment_format = excluded.comment_format`
      ).run(
        assignmentId,
        attemptNumber,
        int(grade.id),
        // El string original se conserva: parsearlo a REAL pierde precisión y
        // el centinela '-1.00000' de "sin nota".
        real(grade.grade),
        textOrNull(grade.grade),
        textOrNull(payload.feedback.gradefordisplay),
        epoch(payload.feedback.gradeddate),
        int(grade.grader),
        epoch(grade.timecreated),
        epoch(grade.timemodified),
        comment?.html ?? null,
        comment?.format ?? null
      );
    } else {
      db.prepare('DELETE FROM pva_submission_feedback WHERE assignment_id = ? AND attemptnumber = ?').run(
        assignmentId,
        attemptNumber
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { saved: true, attemptNumber, status, gradingStatus: text(attempt.gradingstatus, 'notgraded'), graded: Boolean(payload.feedback) };
}

export async function syncSubmission(userId, assignmentId, { call = callPva, now = Date.now() } = {}) {
  const payload = await call('mod_assign_get_submission_status', { assignid: assignmentId });
  return saveSubmissionStatus(userId, assignmentId, payload, { now });
}

/**
 * Qué tareas merecen una llamada de estado, con el TTL del mapa: 30 min si
 * vence en menos de 48 h, 6 h entregada sin calificar, 24 h ya calificada, y
 * nunca una vencida, cerrada y calificada.
 */
export function assignmentsNeedingStatus(userId, { now = Date.now(), limit = 25 } = {}) {
  const seconds = nowSeconds(now);
  const rows = db
    .prepare(
      `SELECT a.assignment_id AS assignmentId, a.name, a.duedate, a.cutoffdate,
              s.fetched_at AS fetchedAt, s.grading_status AS gradingStatus, s.status
       FROM pva_assignment a
       LEFT JOIN pva_submission s ON s.assignment_id = a.assignment_id AND s.is_latest = 1
       WHERE a.user_id = ?
       ORDER BY CASE WHEN a.duedate IS NULL THEN 1 ELSE 0 END, a.duedate`
    )
    .all(userId);

  const due = [];
  for (const row of rows) {
    const age = row.fetchedAt == null ? Infinity : seconds - row.fetchedAt;
    const closed = row.cutoffdate != null && row.cutoffdate < seconds;
    const overdue = row.duedate != null && row.duedate < seconds;
    const graded = row.gradingStatus === 'graded';
    if (overdue && closed && graded) continue;
    const soon = row.duedate != null && row.duedate - seconds < 48 * 3600 && row.duedate >= seconds;
    const ttl = soon ? 30 * 60 : graded ? 24 * 3600 : row.status === 'submitted' ? 6 * 3600 : 6 * 3600;
    if (age >= ttl) due.push(row.assignmentId);
    if (due.length >= limit) break;
  }
  return due;
}

export async function syncSubmissions(userId, { call = callPva, now = Date.now(), limit = 25 } = {}) {
  const pending = assignmentsNeedingStatus(userId, { now, limit });
  let saved = 0;
  let failed = 0;
  for (const assignmentId of pending) {
    try {
      await syncSubmission(userId, assignmentId, { call, now });
      saved += 1;
    } catch {
      // Una tarea que falla no puede tumbar el resto del lote.
      failed += 1;
    }
  }
  logSync({
    userId,
    kind: 'pvaSubmissions',
    status: failed && !saved ? 'error' : 'ok',
    detail: `${saved} estado(s) al día${failed ? `, ${failed} con error` : ''}`,
    rows: saved,
  });
  return { saved, failed, pending: pending.length };
}

// ── Derivación ─────────────────────────────────────────────────────────────

/**
 * El estado que ve el estudiante no es un campo: se deriva. La editabilidad
 * tampoco es un solo booleano, y la fecha efectiva de cierre depende de tres
 * campos con un centinela cada uno.
 */
export function deriveSubmissionState({ assignment, submission = null, now = Date.now() } = {}) {
  const seconds = nowSeconds(now);
  // La prórroga manda sobre el corte, y el corte sobre la entrega.
  const closesAt = submission?.extensionduedate ?? assignment.cutoffdate ?? assignment.duedate ?? null;
  const acceptsLate = assignment.cutoffdate == null;
  const submitted = submission?.status === 'submitted';
  const deadline = submission?.extensionduedate ?? assignment.duedate ?? null;
  return {
    submitted,
    graded: submission?.grading_status === 'graded',
    // `canedit` lo dice el servidor y no se recalcula: sigue al cutoff, pero la
    // fuente es la respuesta, no la fecha.
    canEdit: submission?.can_edit === 1,
    // `cansubmit` no sirve de condición: con submissiondrafts = 0 nunca es true.
    needsConfirmation: assignment.submissiondrafts === 1,
    isLate: Boolean(submitted && deadline && submission?.timemodified && submission.timemodified > deadline),
    isOverdue: Boolean(!submitted && deadline && deadline < seconds),
    closesAt,
    acceptsLate,
    closedForever: Boolean(assignment.cutoffdate && assignment.cutoffdate < seconds),
  };
}

export function readAssignments(userId, courseId) {
  return db
    .prepare(
      `SELECT a.assignment_id AS assignmentId, a.cmid, a.course_id AS courseId, a.name,
              a.duedate, a.cutoffdate, a.allowsubmissionsfromdate, a.grade_max AS gradeMax,
              a.submissiondrafts, s.status, s.grading_status AS gradingStatus, s.can_edit AS canEdit,
              s.timemodified AS submittedAt, s.extensionduedate,
              f.grade_raw_text AS gradeText, f.grade_value AS gradeValue, f.graded_date AS gradedAt
       FROM pva_assignment a
       LEFT JOIN pva_submission s ON s.assignment_id = a.assignment_id AND s.is_latest = 1
       LEFT JOIN pva_submission_feedback f ON f.assignment_id = a.assignment_id AND f.attemptnumber = s.attemptnumber
       WHERE a.user_id = ?${courseId == null ? '' : ' AND a.course_id = ?'}
       ORDER BY CASE WHEN a.duedate IS NULL THEN 1 ELSE 0 END, a.duedate`
    )
    .all(...(courseId == null ? [userId] : [userId, courseId]));
}
