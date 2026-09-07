import { db, logSync } from '../db.js';
import { callPva } from './session.js';
import { moodleUserId } from './identity.js';
import { bool01, int, nowSeconds, real, text, textOrNull, triState } from './shape.js';

// Libro de calificaciones. Dos funciones con costes muy distintos:
// `gradereport_overview_get_course_grades` es UNA llamada con el total de todos
// los cursos, y `gradereport_user_get_grade_items` es una por curso con el
// detalle. Por eso el overview es el disparador barato: marca qué cursos
// cambiaron y solo esos gastan una llamada de detalle.
//
// Las cuatro cosas que se hacen distinto de lo obvio, todas del recon:
//
//   1. Se compara `rawgrade` EN TEXTO. `grade` depende de los decimales de
//      visualización del sitio: dos totales distintos pueden redondear igual, y
//      que el admin cambie el formato dispararía falsos positivos en todo.
//   2. El overview OMITE EN SILENCIO los cursos sin permiso, sin un warning. Un
//      parser que asuma paridad con la lista de materias cruza notas con cursos
//      equivocados.
//   3. Los dos centinelas de "sin nota" significan cosas distintas: `'-'` con
//      rango numérico es calificable y todavía sin nota, `''` con rango sin
//      dígitos es un item que NO califica. Tratarlos igual deja un item colgado
//      como pendiente para siempre.
//   4. Cuando falla no manda `warnings`: lanza excepción con
//      `nopermissiontoviewgrades`. Tratar eso como libro vacío equivale a
//      borrar todas las notas del curso.

/**
 * Un item califica cuando su rango trae dígitos y su máximo no es 0. `grademax`
 * solo no alcanza: un item que no califica reporta igual `grademax: 100`.
 */
export function isGradable(item) {
  const range = text(item.rangeformatted);
  return /\d/.test(range) && Number(item.grademax) !== 0 ? 1 : 0;
}

// ── El disparador barato: totales por curso ────────────────────────────────

export function saveCourseTotals(userId, payload, { now = Date.now() } = {}) {
  const stamp = nowSeconds(now);
  const previous = new Map(
    db
      .prepare('SELECT course_id AS courseId, rawgrade_src AS raw FROM pva_course_total WHERE user_id = ?')
      .all(userId)
      .map((row) => [row.courseId, row.raw])
  );
  const upsert = db.prepare(
    `INSERT INTO pva_course_total (user_id, course_id, grade_display, rawgrade_src, rawgrade, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, course_id) DO UPDATE SET
       grade_display = excluded.grade_display, rawgrade_src = excluded.rawgrade_src,
       rawgrade = excluded.rawgrade, fetched_at = excluded.fetched_at`
  );
  const seenInOverview = db.prepare(
    `INSERT INTO pva_gradebook_access (user_id, course_id, show_grades, reachable, last_try_at, in_overview)
     VALUES (?, ?, 1, 1, ?, 1)
     ON CONFLICT(user_id, course_id) DO UPDATE SET in_overview = 1, last_try_at = excluded.last_try_at`
  );

  const dirty = [];
  db.exec('BEGIN');
  try {
    // Un curso ausente del overview NO se marca como sin libro acá: la ausencia
    // es silenciosa y puede ser permiso, pero también un curso sin nada que
    // totalizar. Lo dice el detalle, que sí lanza excepción.
    db.prepare('UPDATE pva_gradebook_access SET in_overview = 0 WHERE user_id = ?').run(userId);
    for (const grade of payload.grades ?? []) {
      const courseId = int(grade.courseid);
      const raw = textOrNull(grade.rawgrade);
      upsert.run(userId, courseId, text(grade.grade, '-'), raw, real(grade.rawgrade), stamp);
      seenInOverview.run(userId, courseId, stamp);
      const before = previous.get(courseId);
      if (previous.has(courseId) ? before !== raw : raw != null) dirty.push(courseId);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { courses: payload.grades?.length ?? 0, dirty, seeded: previous.size === 0 };
}

export async function syncCourseTotals(userId, { call = callPva, now = Date.now() } = {}) {
  const userid = moodleUserId(userId);
  if (!userid) throw new Error('La PVA todavía no sabe quién sos: falta sincronizar la identidad');
  const payload = await call('gradereport_overview_get_course_grades', { userid });
  return saveCourseTotals(userId, payload, { now });
}

// ── Detalle por item ───────────────────────────────────────────────────────

// La bitácora es lo que hace posible avisar una sola vez, y lo que impide que
// el primer sync avise de todo el semestre de golpe.
function recordChange(userId, item, before, after, { now }) {
  const stamp = nowSeconds(now);
  // El total del curso se recalcula cada vez que se califica cualquier item: si
  // compartiera evento con las notas, cada nota publicada generaría dos avisos.
  if (item.itemtype !== 'mod') {
    if (item.itemtype === 'course' && before && before.graderaw_src !== after.rawSrc) {
      return insertChange(item.id, 'total_moved', before, after, stamp);
    }
    return null;
  }
  if (!isGradable(item)) return null;
  // Un valor provisional lo va a mover el cron del sitio solo: avisar ahora es
  // avisar de algo que todavía no es.
  if (bool01(item.gradeneedsupdate)) return null;
  // El primer sync siembra y nunca avisa.
  if (!before) return null;

  const hadGrade = before.graderaw_src != null;
  const hasGrade = after.rawSrc != null;
  if (!hadGrade && hasGrade) return insertChange(item.id, 'published', before, after, stamp);
  if (hadGrade && !hasGrade) return insertChange(item.id, 'removed', before, after, stamp);
  if (hasGrade && before.gradedategraded !== after.gradedAt) return insertChange(item.id, 'regraded', before, after, stamp);
  if (hasGrade && before.graderaw_src !== after.rawSrc) return insertChange(item.id, 'regraded', before, after, stamp);
  if (hasGrade && before.is_hidden === 1 && after.isHidden === 0) return insertChange(item.id, 'unhidden', before, after, stamp);
  return null;
}

function insertChange(itemId, kind, before, after, stamp) {
  // El índice único sobre (item_id, kind, graded_at, raw_src) hace idempotente
  // la corrida: el mismo hecho no entra dos veces.
  db.prepare(
    `INSERT OR IGNORE INTO pva_grade_change
       (item_id, kind, old_raw_src, new_raw_src, old_graded_at, new_graded_at, detected_at, notified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
  ).run(itemId, kind, before?.graderaw_src ?? null, after.rawSrc, before?.gradedategraded ?? null, after.gradedAt, stamp);
  return kind;
}

export function saveGradeItems(userId, courseId, payload, { now = Date.now() } = {}) {
  const stamp = nowSeconds(now);
  const usergrade = payload.usergrades?.[0];
  if (!usergrade) return { items: 0, changes: [] };
  const items = usergrade.gradeitems ?? [];

  const before = new Map(
    db
      .prepare(
        `SELECT v.item_id AS id, v.graderaw_src, v.gradedategraded, v.is_hidden
         FROM pva_grade_value v JOIN pva_grade_item i ON i.item_id = v.item_id
         WHERE i.user_id = ? AND i.course_id = ?`
      )
      .all(userId, courseId)
      .map((row) => [row.id, row])
  );

  const upsertItem = db.prepare(
    `INSERT INTO pva_grade_item (
       item_id, user_id, course_id, itemtype, itemmodule, iteminstance, itemnumber, cmid,
       category_id, idnumber, itemname, grademin, grademax, scaleid, outcomeid, locked,
       sort_index, is_gradable, first_seen_at, last_seen_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET
       course_id = excluded.course_id, itemtype = excluded.itemtype, itemmodule = excluded.itemmodule,
       iteminstance = excluded.iteminstance, itemnumber = excluded.itemnumber, cmid = excluded.cmid,
       category_id = excluded.category_id, idnumber = excluded.idnumber, itemname = excluded.itemname,
       grademin = excluded.grademin, grademax = excluded.grademax, scaleid = excluded.scaleid,
       outcomeid = excluded.outcomeid, locked = excluded.locked, sort_index = excluded.sort_index,
       is_gradable = excluded.is_gradable, last_seen_at = excluded.last_seen_at`
  );
  const upsertValue = db.prepare(
    `INSERT INTO pva_grade_value (
       item_id, graderaw, graderaw_src, gradedatesubmitted, gradedategraded, grade_display,
       percentage_display, range_display, feedback_html, feedback_format, is_hidden, hidden_by_date,
       needs_update, is_locked, is_overridden, fetched_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET
       graderaw = excluded.graderaw, graderaw_src = excluded.graderaw_src,
       gradedatesubmitted = excluded.gradedatesubmitted, gradedategraded = excluded.gradedategraded,
       grade_display = excluded.grade_display, percentage_display = excluded.percentage_display,
       range_display = excluded.range_display, feedback_html = excluded.feedback_html,
       feedback_format = excluded.feedback_format, is_hidden = excluded.is_hidden,
       hidden_by_date = excluded.hidden_by_date, needs_update = excluded.needs_update,
       is_locked = excluded.is_locked, is_overridden = excluded.is_overridden, fetched_at = excluded.fetched_at`
  );

  const changes = [];
  db.exec('BEGIN');
  try {
    items.forEach((item, index) => {
      const id = int(item.id);
      upsertItem.run(
        id,
        userId,
        courseId,
        text(item.itemtype),
        textOrNull(item.itemmodule),
        int(item.iteminstance, 0),
        int(item.itemnumber),
        // La clave `cmid` no viene en el total del curso: acceder sin guardia
        // es undefined, no null.
        Object.hasOwn(item, 'cmid') ? int(item.cmid) : null,
        int(item.categoryid),
        textOrNull(item.idnumber),
        textOrNull(item.itemname),
        real(item.grademin) ?? 0,
        real(item.grademax) ?? 0,
        int(item.scaleid),
        int(item.outcomeid),
        triState(item.locked),
        // El orden no es por id ni alfabético: es el sortorder del libro que
        // define el profesor, y es el que el estudiante ve en la web.
        index,
        isGradable(item),
        stamp,
        stamp
      );

      const after = {
        // `graderaw` en texto es lo que se compara; el número es para calcular.
        rawSrc: item.graderaw === null || item.graderaw === undefined ? null : String(item.graderaw),
        gradedAt: int(item.gradedategraded),
        isHidden: bool01(item.gradeishidden),
      };
      upsertValue.run(
        id,
        real(item.graderaw),
        after.rawSrc,
        int(item.gradedatesubmitted),
        after.gradedAt,
        text(item.gradeformatted),
        text(item.percentageformatted),
        text(item.rangeformatted),
        text(item.feedback),
        int(item.feedbackformat, 0),
        after.isHidden,
        bool01(item.gradehiddenbydate),
        bool01(item.gradeneedsupdate),
        triState(item.gradeislocked),
        triState(item.gradeisoverridden),
        stamp
      );

      const kind = recordChange(userId, item, before.get(id) ?? null, after, { now });
      if (kind) changes.push({ itemId: id, kind, name: textOrNull(item.itemname), courseId });
    });

    markGradebookAccess(userId, courseId, { reachable: 1, errorcode: null, now, insideTransaction: true });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Un item que desaparece del payload NO se borra: conserva su last_seen_at.
  // El profesor puede ocultarlo y reponerlo, y borrarlo haría que reaparezca
  // como nota nueva la próxima vez.
  return { items: items.length, changes };
}

export function markGradebookAccess(userId, courseId, { reachable, errorcode = null, now = Date.now(), insideTransaction = false } = {}) {
  const stamp = nowSeconds(now);
  const showGrades = db
    .prepare('SELECT show_grades AS showGrades FROM pva_course WHERE user_id = ? AND course_id = ?')
    .get(userId, courseId)?.showGrades;
  const run = () =>
    db
      .prepare(
        `INSERT INTO pva_gradebook_access (user_id, course_id, show_grades, reachable, last_errorcode, last_ok_at, last_try_at, in_overview)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(user_id, course_id) DO UPDATE SET
           show_grades = excluded.show_grades, reachable = excluded.reachable,
           last_errorcode = excluded.last_errorcode,
           last_ok_at = COALESCE(excluded.last_ok_at, pva_gradebook_access.last_ok_at),
           last_try_at = excluded.last_try_at`
      )
      .run(userId, courseId, showGrades ?? 1, reachable, errorcode, reachable ? stamp : null, stamp);
  if (insideTransaction) return run();
  db.exec('BEGIN');
  try {
    run();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return undefined;
}

/**
 * Qué cursos merecen una llamada de detalle. `showgrades = false` es una
 * precondición dura, y un curso que respondió `nopermissiontoviewgrades` no se
 * reintenta antes de 24 h: es por curso, no por token, y no va a cambiar
 * porque insistamos.
 */
export function gradebookTargets(userId, { now = Date.now(), dirty = [], staleAfterS = 6 * 3600 } = {}) {
  const stamp = nowSeconds(now);
  const dirtySet = new Set(dirty);
  return db
    .prepare(
      `SELECT c.course_id AS courseId, a.reachable, a.last_errorcode AS lastErrorcode,
              a.last_try_at AS lastTryAt, a.last_ok_at AS lastOkAt
       FROM pva_course c
       LEFT JOIN pva_gradebook_access a ON a.user_id = c.user_id AND a.course_id = c.course_id
       WHERE c.user_id = ? AND c.hidden = 0 AND c.missing_since IS NULL AND c.show_grades = 1
       ORDER BY c.course_id`
    )
    .all(userId)
    .filter((row) => {
      if (row.reachable === 0 && row.lastTryAt != null && stamp - row.lastTryAt < 24 * 3600) return false;
      if (dirtySet.has(row.courseId)) return true;
      return row.lastOkAt == null || stamp - row.lastOkAt >= staleAfterS;
    })
    .map((row) => row.courseId);
}

export async function syncGradeItems(userId, courseId, { call = callPva, now = Date.now() } = {}) {
  const userid = moodleUserId(userId);
  try {
    const payload = await call('gradereport_user_get_grade_items', { courseid: courseId, userid });
    return { ...saveGradeItems(userId, courseId, payload, { now }), reachable: true };
  } catch (err) {
    // Sin permiso en ESE curso es un estado válido del dominio: se registra, no
    // se reintenta en 24 h, y el ciclo sigue con el resto de las materias. Los
    // items ya guardados NO se invalidan.
    if (err?.kind === 'permission') {
      markGradebookAccess(userId, courseId, { reachable: 0, errorcode: err.errorcode ?? 'nopermission', now });
      return { items: 0, changes: [], reachable: false, errorcode: err.errorcode ?? 'nopermission' };
    }
    throw err;
  }
}

export async function syncGrades(userId, { call = callPva, now = Date.now() } = {}) {
  const totals = await syncCourseTotals(userId, { call, now });
  const targets = gradebookTargets(userId, { now, dirty: totals.dirty });
  const summary = { courses: totals.courses, dirty: totals.dirty.length, detailed: 0, unreachable: 0, changes: [] };
  for (const courseId of targets) {
    const result = await syncGradeItems(userId, courseId, { call, now });
    if (result.reachable) {
      summary.detailed += 1;
      summary.changes.push(...result.changes);
    } else {
      summary.unreachable += 1;
    }
  }
  logSync({
    userId,
    kind: 'pvaGrades',
    status: 'ok',
    detail: `${summary.courses} total(es), ${summary.detailed} libro(s) al detalle${summary.unreachable ? `, ${summary.unreachable} sin permiso` : ''}`,
    rows: summary.detailed,
  });
  return summary;
}

// ── Lectura ────────────────────────────────────────────────────────────────

export function readGradeItems(userId, courseId) {
  return db
    .prepare(
      `SELECT i.item_id AS itemId, i.itemtype, i.itemname AS name, i.cmid, i.grademax AS gradeMax,
              i.is_gradable AS isGradable, i.sort_index AS sortIndex,
              v.graderaw_src AS rawText, v.graderaw AS raw, v.grade_display AS display,
              v.range_display AS range, v.gradedategraded AS gradedAt, v.is_hidden AS isHidden
       FROM pva_grade_item i
       LEFT JOIN pva_grade_value v ON v.item_id = i.item_id
       WHERE i.user_id = ? AND i.course_id = ?
       ORDER BY i.sort_index`
    )
    .all(userId, courseId);
}

export function courseTotals(userId) {
  return db
    .prepare(
      `SELECT course_id AS courseId, grade_display AS display, rawgrade_src AS rawText, rawgrade AS raw
       FROM pva_course_total WHERE user_id = ? ORDER BY course_id`
    )
    .all(userId);
}

/** Cambios detectados y todavía no avisados. La emisión es de otra fase. */
export function pendingGradeChanges(userId) {
  return db
    .prepare(
      `SELECT c.change_id AS changeId, c.item_id AS itemId, c.kind, c.new_raw_src AS newRaw,
              c.detected_at AS detectedAt, i.itemname AS name, i.course_id AS courseId
       FROM pva_grade_change c JOIN pva_grade_item i ON i.item_id = c.item_id
       WHERE i.user_id = ? AND c.notified_at IS NULL
       ORDER BY c.detected_at DESC`
    )
    .all(userId);
}

export function gradebookAccess(userId) {
  return db
    .prepare(
      `SELECT course_id AS courseId, show_grades AS showGrades, reachable, last_errorcode AS lastErrorcode,
              in_overview AS inOverview
       FROM pva_gradebook_access WHERE user_id = ? ORDER BY course_id`
    )
    .all(userId);
}
