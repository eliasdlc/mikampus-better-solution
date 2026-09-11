import { hasColumn, hasTable, readRow, readRows } from './db.js';

// Las lecturas del MCP. Todo el SQL del carril de lectura vive acá y pasa por
// readRows/readRow, que validan contra la allowlist: ningún otro módulo del MCP
// habla con SQLite.
//
// El SQL no se comparte con src/db.js a propósito: aquella conexión escribe y
// esta no puede. Lo que sí se comparte es el cálculo (src/shared/*.ts), que es
// puro y no toca disco, así el MCP y la web nunca contestan cosas distintas.

// La instalación local tiene una sola identidad. src/users.js exporta la misma
// constante, pero importarlo arrastraría src/db.js y con él la conexión de
// escritura, que es justo lo que este carril no puede tener.
export const LOCAL_USER_ID = 1;

// Cuánto puede envejecer cada dataset antes de que una respuesta lo marque
// viejo. Los cinco primeros son los mismos umbrales que usa el refresh del
// agente (REFRESH_POLICY en src/server.js); los dos últimos no tienen umbral
// allá y acá se declaran para que un agente sepa si el catálogo que está
// citando es de anteayer.
export const MAX_AGE_MINUTES = {
  mySchedule: 12 * 60,
  cart: 10,
  grades: 24 * 60,
  advisement: 7 * 24 * 60,
  holds: 12 * 60,
  catalog: 24 * 60,
  enrollmentWindows: 12 * 60,
};

function parseTimestamp(value) {
  if (!value) return null;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const at = new Date(normalized).getTime();
  return Number.isNaN(at) ? null : at;
}

export function lastSync(kind, { userId = LOCAL_USER_ID, term = null } = {}) {
  const row = readRow(
    `SELECT sl.finished_at AS finishedAt FROM sync_log sl
     WHERE sl.kind = ? AND sl.status = 'ok' AND (sl.user_id IS NULL OR sl.user_id = ?)
       AND (? IS NULL OR sl.term = ?)
     ORDER BY sl.id DESC LIMIT 1`,
    [kind, userId, term, term],
    { sl: 'sync_log' }
  );
  return row?.finishedAt ?? null;
}

// Nunca sincronizado y sincronizado sin resultados son estados distintos: el
// primero significa que esa pantalla del portal jamás se abrió.
export function everSynced(kind, userId = LOCAL_USER_ID) {
  const row = readRow(
    'SELECT COUNT(1) AS n FROM sync_log sl WHERE sl.kind = ? AND (sl.user_id IS NULL OR sl.user_id = ?)',
    [kind, userId],
    { sl: 'sync_log' }
  );
  return (row?.n ?? 0) > 0;
}

export function freshnessFor(kinds, { userId = LOCAL_USER_ID, now = Date.now() } = {}) {
  return kinds.map((kind) => {
    const syncedAt = lastSync(kind, { userId });
    const at = parseTimestamp(syncedAt);
    const maxAgeMinutes = MAX_AGE_MINUTES[kind] ?? null;
    const ageMinutes = at === null ? null : Math.round((now - at) / 60_000);
    return {
      kind,
      syncedAt,
      ageMinutes,
      stale: ageMinutes === null || (maxAgeMinutes !== null && ageMinutes > maxAgeMinutes),
      maxAgeMinutes,
      neverSynced: !everSynced(kind, userId),
    };
  });
}

// ── Identidad y ciclos ─────────────────────────────────────────────────────

export function readProfile(userId = LOCAL_USER_ID) {
  return readRow(
    `SELECT p.career, p.pensum_no AS pensumNo, p.plan_label AS planLabel,
            p.cohort_start_term AS cohortStartTerm, p.updated_at AS updatedAt
     FROM profile p WHERE p.user_id = ?`,
    [userId],
    { p: 'profile' }
  );
}

// hasAccount y nada más: si hay una cuenta del portal configurada es todo lo que
// una herramienta necesita saber. El username identifica a la persona y ninguna
// pregunta académica lo requiere, así que no sale por esta interfaz.
export function accountState(userId = LOCAL_USER_ID) {
  const row = readRow(
    'SELECT u.id, u.created_at AS createdAt, u.last_login_at AS lastLoginAt FROM users u WHERE u.id = ?',
    [userId],
    { u: 'users' }
  );
  return { hasAccount: Boolean(row), lastLoginAt: row?.lastLoginAt ?? null };
}

export function readTermRows() {
  return readRows(
    `SELECT t.code, t.label, t.start_date AS startDate, t.end_date AS endDate FROM terms t`,
    [],
    { t: 'terms' }
  );
}

// El identificador con el que el resto de la app nombra un ciclo: el STRM si se
// conoce, si no la etiqueta. Es la misma regla que usa /api/terms.
export function termIdOf(term) {
  return term.code ?? term.label ?? null;
}

export function termsWithSchedule(userId = LOCAL_USER_ID) {
  return new Set(
    readRows('SELECT DISTINCT e.term FROM enrollments e WHERE e.user_id = ?', [userId], { e: 'enrollments' }).map(
      (row) => row.term
    )
  );
}

export function termsWithSections() {
  return new Set(readRows('SELECT DISTINCT s.term FROM sections s', [], { s: 'sections' }).map((row) => row.term));
}

// La corrupción del vocabulario de ciclos es un hecho verificable, no una
// sospecha: una fila cuyo `code` no parece un STRM es una etiqueta metida en la
// columna del código, y enrollments repartidas entre STRM y etiquetas significa
// que dos pantallas escribieron vocabularios distintos. Cuando pasa, toda
// respuesta que dependa de ciclos lo dice en warnings en vez de afirmar con
// seguridad algo que la base no sostiene.
export function termIntegrityWarnings(userId = LOCAL_USER_ID) {
  const warnings = [];
  const suspicious = readRows(
    "SELECT t.code, t.label FROM terms t WHERE t.code IS NOT NULL AND t.code NOT GLOB '[0-9]*'",
    [],
    { t: 'terms' }
  );
  for (const row of suspicious) {
    warnings.push({
      kind: 'data_integrity',
      detail: `La tabla de ciclos tiene code="${row.code}" con label="${row.label}": una etiqueta guardada donde va el código STRM.`,
    });
  }
  const vocabularies = readRows(
    'SELECT DISTINCT e.term FROM enrollments e WHERE e.user_id = ?',
    [userId],
    { e: 'enrollments' }
  ).map((row) => row.term);
  const strm = vocabularies.filter((term) => /^\d+$/.test(term));
  if (strm.length > 0 && strm.length !== vocabularies.length) {
    warnings.push({
      kind: 'data_integrity',
      detail: `Las inscripciones mezclan dos vocabularios de ciclo (${strm.length} por código STRM y ${vocabularies.length - strm.length} por etiqueta).`,
    });
  }
  return warnings;
}

export function readEnrollmentWindows(userId = LOCAL_USER_ID) {
  return readRows(
    `SELECT ew.term_code AS termCode, ew.session, ew.starts_at AS startsAt, ew.ends_at AS endsAt,
            ew.precision, ew.synced_at AS syncedAt
     FROM enrollment_windows ew WHERE ew.user_id = ? ORDER BY ew.starts_at`,
    [userId],
    { ew: 'enrollment_windows' }
  );
}

// term_events la crea una migración posterior a la que puede tener una base
// instalada. Si no está, no hay eventos cargados: no es un error.
export function readTermEvents(userId = LOCAL_USER_ID) {
  if (!hasTable('term_events')) return [];
  return readRows(
    `SELECT te.term_code AS termCode, te.session, te.event, te.starts_on AS startsOn, te.ends_on AS endsOn,
            te.precision, te.source, te.source_note AS sourceNote
     FROM term_events te WHERE te.user_id = ? ORDER BY te.starts_on`,
    [userId],
    { te: 'term_events' }
  );
}

// ── Horario inscrito ───────────────────────────────────────────────────────

function parseMeetingsJson(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function readEnrollments(userId = LOCAL_USER_ID, term = null) {
  const rows = readRows(
    `SELECT e.term, e.status, e.units, e.grading, e.grade, e.start_date AS startDate, e.end_date AS endDate,
            c.id AS courseId, c.code, c.subject, c.catalog_nbr AS catalogNbr, c.title, c.credits,
            s.id AS sectionId, s.class_nbr AS classNbr, s.section, s.component, s.instructor, s.meetings
     FROM enrollments e
     JOIN courses c ON c.id = e.course_id
     JOIN sections s ON s.id = e.section_id
     WHERE e.user_id = ? AND (? IS NULL OR e.term = ?)
     ORDER BY c.code, s.component`,
    [userId, term, term],
    { e: 'enrollments', c: 'courses', s: 'sections' }
  );

  const byCourse = new Map();
  for (const row of rows) {
    const key = `${row.term}:${row.code}`;
    const course = byCourse.get(key) ?? {
      term: row.term,
      courseId: row.courseId,
      code: row.code,
      subject: row.subject,
      catalogNbr: row.catalogNbr,
      title: row.title,
      status: row.status,
      units: row.units ?? row.credits ?? null,
      grading: row.grading,
      grade: row.grade,
      startDate: row.startDate,
      endDate: row.endDate,
      sections: [],
    };
    course.sections.push({
      sectionId: row.sectionId,
      classNbr: row.classNbr,
      section: row.section,
      component: row.component,
      instructor: row.instructor,
      meetings: parseMeetingsJson(row.meetings),
    });
    byCourse.set(key, course);
  }
  return [...byCourse.values()];
}

// ── Notas ──────────────────────────────────────────────────────────────────

export function readGrades(userId = LOCAL_USER_ID) {
  return readRows(
    `SELECT g.term, g.course_code AS courseCode, g.subject, g.catalog_nbr AS catalogNbr, g.title,
            g.grade, g.credits, g.status
     FROM grades g WHERE g.user_id = ? ORDER BY g.term, g.course_code`,
    [userId],
    { g: 'grades' }
  );
}

export function readGoals(userId = LOCAL_USER_ID) {
  return readRows(
    `SELECT go.id, go.kind, go.target, go.deadline_term AS deadlineTerm, go.achieved_at AS achievedAt
     FROM goals go WHERE go.user_id = ? ORDER BY go.id`,
    [userId],
    { go: 'goals' }
  );
}

// ── Pénsum y árbol de requisitos ───────────────────────────────────────────

function userPlanId(userId) {
  const profile = readProfile(userId);
  if (!profile) return null;
  const key = profile.career && profile.pensumNo ? `${profile.career}|${profile.pensumNo}` : profile.planLabel;
  if (!key) return null;
  const row = readRow('SELECT pp.id FROM pensum_plans pp WHERE pp.plan_key = ?', [key], { pp: 'pensum_plans' });
  return row?.id ?? null;
}

// El mismo árbol que sirve /api/requirements, reconstruido desde la conexión de
// lectura. La forma se respeta al detalle porque shared/recommend.ts y
// shared/trajectory.ts la consumen tal cual.
export function readRequirementTree(userId = LOCAL_USER_ID) {
  const planId = userPlanId(userId);
  if (!planId) return null;

  const groups = readRows(
    `SELECT rg.id, rg.parent_id AS parentId, rg.kind, rg.label, rg.year, rg.period, rg.position,
            rg.collapsed, rg.units_required AS unitsRequired, rg.courses_required AS coursesRequired
     FROM requirement_groups rg WHERE rg.plan_id = ? ORDER BY rg.position`,
    [planId],
    { rg: 'requirement_groups' }
  );
  if (groups.length === 0) return null;

  const progress = new Map(
    readRows(
      `SELECT rp.position, rp.satisfied, rp.collapsed, rp.units_taken AS unitsTaken,
              rp.units_needed AS unitsNeeded, rp.courses_taken AS coursesTaken,
              rp.courses_needed AS coursesNeeded, rp.gpa_actual AS gpaActual
       FROM requirement_progress rp WHERE rp.user_id = ? AND rp.plan_id = ?`,
      [userId, planId],
      { rp: 'requirement_progress' }
    ).map((row) => [row.position, row])
  );

  const personal = new Map(
    readRows(
      `SELECT pe.code, pe.status, pe.taken_term AS takenTerm, pe.grade FROM pensum pe WHERE pe.user_id = ?`,
      [userId],
      { pe: 'pensum' }
    ).map((row) => [row.code, row])
  );

  const courses = readRows(
    `SELECT rc.group_id AS groupId, rc.code, rc.subject, rc.catalog_nbr AS catalogNbr, rc.title, rc.units,
            rc.is_candidate AS isCandidate
     FROM requirement_courses rc
     JOIN requirement_groups rg ON rg.id = rc.group_id
     WHERE rg.plan_id = ? ORDER BY rc.is_candidate, rc.code`,
    [planId],
    { rc: 'requirement_courses', rg: 'requirement_groups' }
  );

  const coursesByGroup = new Map();
  for (const row of courses) {
    const mine = personal.get(row.code);
    const list = coursesByGroup.get(row.groupId) ?? [];
    list.push({
      code: row.code,
      subject: row.subject,
      catalogNbr: row.catalogNbr,
      title: row.title,
      units: row.units,
      status: mine?.status ?? 'pending',
      isCandidate: row.isCandidate === 1,
      takenTerm: mine?.takenTerm ?? null,
      grade: mine?.grade ?? null,
    });
    coursesByGroup.set(row.groupId, list);
  }

  const nodes = new Map();
  for (const group of groups) {
    const mine = progress.get(group.position);
    nodes.set(group.id, {
      id: group.id,
      kind: group.kind,
      label: group.label,
      year: group.year,
      period: group.period,
      position: group.position,
      satisfied: mine ? mine.satisfied === 1 : false,
      collapsed: mine ? mine.collapsed === 1 : group.collapsed === 1,
      units: { required: group.unitsRequired, taken: mine?.unitsTaken ?? null, needed: mine?.unitsNeeded ?? null },
      courses: {
        required: group.coursesRequired,
        taken: mine?.coursesTaken ?? null,
        needed: mine?.coursesNeeded ?? null,
      },
      gpaActual: mine?.gpaActual ?? null,
      items: coursesByGroup.get(group.id) ?? [],
      children: [],
    });
  }

  let root = null;
  for (const group of groups) {
    const node = nodes.get(group.id);
    if (group.parentId == null) root = node;
    else nodes.get(group.parentId)?.children.push(node);
  }
  return root;
}

export function readPensum(userId = LOCAL_USER_ID) {
  return readRows(
    `SELECT pe.code, pe.subject, pe.catalog_nbr AS catalogNbr, pe.units, pe.status,
            pe.taken_term AS takenTerm, pe.grade
     FROM pensum pe WHERE pe.user_id = ? ORDER BY pe.code`,
    [userId],
    { pe: 'pensum' }
  );
}

// ── Catálogo ───────────────────────────────────────────────────────────────

// El campus de una sección solo existe si la base ya tiene la columna, y sale
// siempre con su procedencia al lado. La convención de que el número de sección
// codifica el campus NO se aplica acá: sin dato, campus es null y campusKnown
// es false, que es la verdad.
function sectionCampusColumns() {
  return hasColumn('sections', 'campus') && hasColumn('sections', 'campus_source')
    ? ', s.campus, s.campus_source AS campusSource'
    : '';
}

export function readSections(term, codes = null) {
  const campusColumns = sectionCampusColumns();
  const filter = codes && codes.length > 0 ? `AND c.code IN (${codes.map(() => '?').join(',')})` : '';
  const rows = readRows(
    `SELECT s.id AS sectionId, s.term, s.class_nbr AS classNbr, s.section, s.component, s.instructor,
            s.meetings${campusColumns},
            c.id AS courseId, c.code, c.subject, c.catalog_nbr AS catalogNbr, c.title, c.credits, c.career
     FROM sections s
     JOIN courses c ON c.id = s.course_id
     WHERE s.term = ? ${filter}
     ORDER BY c.code, s.section`,
    codes && codes.length > 0 ? [term, ...codes] : [term],
    { s: 'sections', c: 'courses' }
  );

  const seats = new Map(
    readRows(
      `SELECT ss.section_id AS sectionId, ss.status, ss.seats_open AS seatsOpen, ss.seats_cap AS seatsCap,
              ss.wait_total AS waitTotal, ss.captured_at AS capturedAt
       FROM seats_snapshot ss
       JOIN sections s ON s.id = ss.section_id
       WHERE s.term = ? AND ss.id = (
         SELECT MAX(inner_ss.id) FROM seats_snapshot inner_ss WHERE inner_ss.section_id = ss.section_id
       )`,
      [term],
      { ss: 'seats_snapshot', s: 'sections', inner_ss: 'seats_snapshot' }
    ).map((row) => [row.sectionId, row])
  );

  return rows.map((row) => ({
    sectionId: row.sectionId,
    courseId: row.courseId,
    term: row.term,
    code: row.code,
    subject: row.subject,
    catalogNbr: row.catalogNbr,
    title: row.title,
    credits: row.credits,
    career: row.career,
    classNbr: row.classNbr,
    section: row.section,
    component: row.component,
    instructor: row.instructor,
    meetings: parseMeetingsJson(row.meetings),
    campus: row.campus ?? null,
    campusSource: row.campusSource ?? null,
    campusKnown: Boolean(row.campus),
    seats: seats.get(row.sectionId)
      ? {
          status: seats.get(row.sectionId).status,
          open: seats.get(row.sectionId).seatsOpen,
          cap: seats.get(row.sectionId).seatsCap,
          waitTotal: seats.get(row.sectionId).waitTotal,
          capturedAt: seats.get(row.sectionId).capturedAt,
        }
      : null,
  }));
}

export function countCatalog() {
  const courses = readRow('SELECT COUNT(1) AS n FROM courses c', [], { c: 'courses' });
  const sections = readRow('SELECT COUNT(1) AS n FROM sections s', [], { s: 'sections' });
  return { courses: courses?.n ?? 0, sections: sections?.n ?? 0 };
}

// ── Holds, carrito, actividad y runtime ────────────────────────────────────

export function readHolds(userId = LOCAL_USER_ID) {
  return readRows(
    `SELECT h.code, h.title, h.description, h.severity, h.captured_at AS capturedAt
     FROM holds h WHERE h.user_id = ? ORDER BY h.id`,
    [userId],
    { h: 'holds' }
  );
}

export function readCart(userId = LOCAL_USER_ID) {
  return readRows(
    `SELECT cr.idx, cr.course_code AS courseCode, cr.title, cr.section, cr.class_nbr AS classNbr,
            cr.instructor, cr.credits, cr.campus, cr.meetings, cr.status, cr.captured_at AS capturedAt
     FROM cart_rows cr WHERE cr.user_id = ? ORDER BY cr.idx`,
    [userId],
    { cr: 'cart_rows' }
  ).map((row) => ({ ...row, meetings: parseMeetingsJson(row.meetings), campusSource: row.campus ? 'portal' : null }));
}

export function readActionLog(userId = LOCAL_USER_ID, limit = 20) {
  return readRows(
    `SELECT al.id, al.action, al.detail, al.portal_response AS portalResponse, al.ok,
            al.created_at AS createdAt
     FROM action_log al WHERE al.user_id = ? ORDER BY al.id DESC LIMIT ?`,
    [userId, limit],
    { al: 'action_log' }
  );
}

export function readSyncLog(userId = LOCAL_USER_ID, limit = 20) {
  return readRows(
    `SELECT sl.id, sl.kind, sl.term, sl.status, sl.detail, sl.rows, sl.finished_at AS finishedAt
     FROM sync_log sl WHERE sl.user_id IS NULL OR sl.user_id = ? ORDER BY sl.id DESC LIMIT ?`,
    [userId, limit],
    { sl: 'sync_log' }
  );
}

export function readWatcher(userId = LOCAL_USER_ID) {
  return readRow(
    `SELECT w.status, w.interval_ms AS intervalMs, w.last_check_at AS lastCheckAt,
            w.auto_enroll AS autoEnroll, w.appointment_at AS appointmentAt,
            w.next_check_at AS nextCheckAt, w.pause_reason AS pauseReason
     FROM watchers w WHERE w.user_id = ?`,
    [userId],
    { w: 'watchers' }
  );
}

export function readScheduledEnroll(userId = LOCAL_USER_ID) {
  return readRow(
    `SELECT sc.at_iso AS atIso, sc.state, sc.last_error AS lastError FROM schedules sc WHERE sc.user_id = ?`,
    [userId],
    { sc: 'schedules' }
  );
}

// Un evento de runtime abierto significa que el agente arrancó y no cerró: o
// está vivo ahora, o se cayó. Quién de los dos lo decide el healthcheck, no la
// base.
export function lastRuntimeEvent() {
  return readRow(
    `SELECT re.started_at AS startedAt, re.ended_at AS endedAt, re.detail
     FROM runtime_events re WHERE re.kind = 'agent' ORDER BY re.id DESC LIMIT 1`,
    [],
    { re: 'runtime_events' }
  );
}

// ── La PVA (Moodle) ────────────────────────────────────────────────────────
//
// El aula es la otra fuente y contesta preguntas que MiCampus no puede: qué
// tarea vence, qué dijo el profesor, qué material subió, qué nota puso en su
// libro. Todo sale de las tablas pva_* que llenó el sync; acá no se consulta
// nada en vivo, igual que en el resto de este carril.
//
// Dos reglas que se ven en el SQL de abajo:
//   * Lo que dejó de venir se filtra, no se borra: `missing_since IS NULL` en
//     materias y eventos, y en el árbol solo las filas cuyo `seen_at` coincide
//     con la última corrida del curso.
//   * Las fechas se devuelven en ISO. En la base son epoch en segundos, que es
//     lo único que Moodle usa, y el 0 ya entró como NULL al escribir.

const iso = (seconds) => (seconds == null ? null : new Date(seconds * 1000).toISOString());

export function pvaCourses(userId = LOCAL_USER_ID) {
  if (!hasTable('pva_course')) return [];
  const courses = readRows(
    `SELECT c.course_id AS courseId, c.shortname, c.fullname, c.progress, c.last_access AS lastAccess,
            c.show_grades AS showGrades,
            a.reachable, a.last_errorcode AS errorcode,
            t.grade_display AS total,
            s.contents_at AS contentsAt, s.sections, s.modules
     FROM pva_course c
     LEFT JOIN pva_gradebook_access a ON a.user_id = c.user_id AND a.course_id = c.course_id
     LEFT JOIN pva_course_total t ON t.user_id = c.user_id AND t.course_id = c.course_id
     LEFT JOIN pva_course_sync s ON s.user_id = c.user_id AND s.course_id = c.course_id
     WHERE c.user_id = ? AND c.hidden = 0 AND c.missing_since IS NULL
     ORDER BY c.shortname`,
    [userId],
    { c: 'pva_course', a: 'pva_gradebook_access', t: 'pva_course_total', s: 'pva_course_sync' }
  );

  const counts = readRows(
    `SELECT a.course_id AS courseId,
            COUNT(1) AS total,
            SUM(CASE WHEN s.status = 'submitted' THEN 1 ELSE 0 END) AS submitted,
            SUM(CASE WHEN s.grading_status = 'graded' THEN 1 ELSE 0 END) AS graded
     FROM pva_assignment a
     LEFT JOIN pva_submission s ON s.assignment_id = a.assignment_id AND s.is_latest = 1
     WHERE a.user_id = ?
     GROUP BY a.course_id`,
    [userId],
    { a: 'pva_assignment', s: 'pva_submission' }
  );
  const byCourse = new Map(counts.map((row) => [row.courseId, row]));

  // "Abierta ahora" es lo que el estudiante puede entregar hoy: ya abrió y
  // todavía no cerró. El cierre efectivo es el corte si existe, y si no la
  // fecha de entrega, porque sin corte se acepta tarde indefinidamente.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const open = readRows(
    `SELECT a.course_id AS courseId, COUNT(1) AS n
     FROM pva_assignment a
     LEFT JOIN pva_submission s ON s.assignment_id = a.assignment_id AND s.is_latest = 1
     WHERE a.user_id = ?
       AND (a.allowsubmissionsfromdate IS NULL OR a.allowsubmissionsfromdate <= ?)
       AND (a.cutoffdate IS NULL OR a.cutoffdate >= ?)
       AND (s.status IS NULL OR s.status <> 'submitted')
     GROUP BY a.course_id`,
    [userId, nowSeconds, nowSeconds],
    { a: 'pva_assignment', s: 'pva_submission' }
  );
  const openByCourse = new Map(open.map((row) => [row.courseId, row.n]));

  return courses.map((course) => ({
    courseId: course.courseId,
    shortname: course.shortname,
    fullname: course.fullname,
    progress: course.progress ?? null,
    lastAccessAt: iso(course.lastAccess),
    gradebook: {
      showGrades: course.showGrades === 1,
      // null es "todavía no se intentó": distinto de "se intentó y no se pudo".
      reachable: course.reachable == null ? null : course.reachable === 1,
      errorcode: course.errorcode ?? null,
      total: course.total ?? null,
    },
    assignments: {
      total: byCourse.get(course.courseId)?.total ?? 0,
      submitted: byCourse.get(course.courseId)?.submitted ?? 0,
      graded: byCourse.get(course.courseId)?.graded ?? 0,
      openNow: openByCourse.get(course.courseId) ?? 0,
    },
    contentsSyncedAt: course.contentsAt ?? null,
    sections: course.sections ?? null,
    modules: course.modules ?? null,
  }));
}

/** Resuelve una materia por id numérico o por su nombre corto, como la nombra el estudiante. */
export function pvaResolveCourse(userId = LOCAL_USER_ID, ref) {
  if (!hasTable('pva_course') || ref == null) return null;
  const numeric = Number(ref);
  const row = Number.isInteger(numeric)
    ? readRow(
        'SELECT c.course_id AS courseId, c.shortname, c.fullname FROM pva_course c WHERE c.user_id = ? AND c.course_id = ?',
        [userId, numeric],
        { c: 'pva_course' }
      )
    : null;
  if (row) return row;
  return readRow(
    `SELECT c.course_id AS courseId, c.shortname, c.fullname FROM pva_course c
     WHERE c.user_id = ? AND (c.shortname = ? COLLATE NOCASE OR c.fullname LIKE ? COLLATE NOCASE)
     ORDER BY c.missing_since IS NOT NULL, c.shortname LIMIT 1`,
    [userId, String(ref), `%${String(ref)}%`],
    { c: 'pva_course' }
  );
}

/**
 * Lo que vence en una ventana. Tres orígenes que no se solapan del todo:
 *
 *   * el feed de acciones del calendario, que solo trae lo que TIENE acción
 *     pendiente: lo ya entregado desaparece de ahí;
 *   * las tareas con fecha, que sí siguen estando después de entregar;
 *   * los foros con fecha de entrega, que mod_assign no reporta.
 *
 * Se unen por cmid, que es lo que comparten. Sin esa unión, una entrega hecha
 * se vería como si ya no existiera.
 */
export function pvaDue(userId = LOCAL_USER_ID, { now = Date.now(), days = 7 } = {}) {
  if (!hasTable('pva_assignment')) return [];
  const from = Math.floor(now / 1000);
  const to = from + days * 86400;
  const items = new Map();

  const events = hasTable('pva_calendar_event')
    ? readRows(
        `SELECT e.event_id AS eventId, e.course_id AS courseId, e.cmid, e.activityname AS activityName,
                e.name, e.timesort, e.local_day AS localDay, e.overdue, e.module_url AS url,
                c.shortname AS courseShortname
         FROM pva_calendar_event e
         LEFT JOIN pva_course c ON c.user_id = e.user_id AND c.course_id = e.course_id
         WHERE e.user_id = ? AND e.missing_since IS NULL AND e.timesort BETWEEN ? AND ?
         ORDER BY e.timesort`,
        [userId, from, to],
        { e: 'pva_calendar_event', c: 'pva_course' }
      )
    : [];
  for (const event of events) {
    const key = event.cmid == null ? `event:${event.eventId}` : `cmid:${event.cmid}`;
    items.set(key, {
      id: key,
      kind: 'event',
      courseId: event.courseId ?? null,
      courseShortname: event.courseShortname ?? null,
      title: event.activityName ?? event.name,
      dueAt: iso(event.timesort),
      localDay: event.localDay ?? null,
      cmid: event.cmid ?? null,
      assignmentId: null,
      url: event.url ?? null,
      overdue: event.overdue === 1,
      submitted: null,
      graded: null,
      status: null,
    });
  }

  const assignments = readRows(
    `SELECT a.assignment_id AS assignmentId, a.cmid, a.course_id AS courseId, a.name, a.duedate,
            s.status, s.grading_status AS gradingStatus, s.extensionduedate AS extensionAt,
            c.shortname AS courseShortname
     FROM pva_assignment a
     LEFT JOIN pva_submission s ON s.assignment_id = a.assignment_id AND s.is_latest = 1
     LEFT JOIN pva_course c ON c.user_id = a.user_id AND c.course_id = a.course_id
     WHERE a.user_id = ? AND a.duedate IS NOT NULL
     ORDER BY a.duedate`,
    [userId],
    { a: 'pva_assignment', s: 'pva_submission', c: 'pva_course' }
  );
  for (const assignment of assignments) {
    // La prórroga corre la fecha efectiva de esa persona.
    const dueAt = assignment.extensionAt ?? assignment.duedate;
    const key = `cmid:${assignment.cmid}`;
    const inWindow = dueAt >= from && dueAt <= to;
    if (!inWindow && !items.has(key)) continue;
    const previous = items.get(key);
    items.set(key, {
      id: key,
      kind: 'assign_due',
      courseId: assignment.courseId,
      courseShortname: assignment.courseShortname ?? null,
      title: assignment.name,
      dueAt: iso(dueAt),
      localDay: previous?.localDay ?? null,
      cmid: assignment.cmid,
      assignmentId: assignment.assignmentId,
      url: previous?.url ?? null,
      overdue: previous?.overdue ?? dueAt < from,
      submitted: assignment.status == null ? null : assignment.status === 'submitted',
      graded: assignment.gradingStatus == null ? null : assignment.gradingStatus === 'graded',
      status: assignment.status ?? null,
    });
  }

  if (hasTable('pva_forum')) {
    const forums = readRows(
      `SELECT f.forum_id AS forumId, f.course_id AS courseId, f.cmid, f.name, f.duedate,
              c.shortname AS courseShortname
       FROM pva_forum f
       LEFT JOIN pva_course c ON c.user_id = f.user_id AND c.course_id = f.course_id
       WHERE f.user_id = ? AND f.duedate BETWEEN ? AND ?
       ORDER BY f.duedate`,
      [userId, from, to],
      { f: 'pva_forum', c: 'pva_course' }
    );
    for (const forum of forums) {
      const key = `cmid:${forum.cmid}`;
      if (items.has(key)) continue;
      items.set(key, {
        id: key,
        kind: 'forum_due',
        courseId: forum.courseId,
        courseShortname: forum.courseShortname ?? null,
        title: forum.name,
        dueAt: iso(forum.duedate),
        localDay: null,
        cmid: forum.cmid,
        assignmentId: null,
        url: null,
        overdue: forum.duedate < from,
        submitted: null,
        graded: null,
        status: null,
      });
    }
  }

  return [...items.values()].sort((left, right) => left.dueAt.localeCompare(right.dueAt));
}

export function pvaAssignment(userId = LOCAL_USER_ID, { assignmentId = null, cmid = null, query = null } = {}) {
  if (!hasTable('pva_assignment')) return { assignment: null, matches: [] };

  let target = null;
  if (assignmentId != null || cmid != null) {
    target = readRow(
      `SELECT a.assignment_id AS assignmentId FROM pva_assignment a
       WHERE a.user_id = ? AND (a.assignment_id = ? OR a.cmid = ?)`,
      [userId, assignmentId ?? -1, cmid ?? -1],
      { a: 'pva_assignment' }
    );
  }
  const matches = query
    ? readRows(
        `SELECT a.assignment_id AS assignmentId, a.name FROM pva_assignment a
         WHERE a.user_id = ? AND a.name LIKE ? COLLATE NOCASE
         ORDER BY a.duedate IS NULL, a.duedate DESC LIMIT 10`,
        [userId, `%${query}%`],
        { a: 'pva_assignment' }
      )
    : [];
  // Una sola coincidencia se resuelve sola; varias se devuelven para que el
  // agente pregunte cuál, en vez de elegir por él.
  if (!target && matches.length === 1) target = { assignmentId: matches[0].assignmentId };
  if (!target) return { assignment: null, matches };

  const row = readRow(
    `SELECT a.assignment_id AS assignmentId, a.cmid, a.course_id AS courseId, a.name,
            a.intro_html AS intro, a.duedate, a.cutoffdate, a.allowsubmissionsfromdate AS opensAt,
            a.grade_max AS gradeMax, a.submissiondrafts AS submissionDrafts,
            s.status, s.attemptnumber AS attempt, s.timemodified AS submittedAt,
            s.grading_status AS gradingStatus, s.can_edit AS canEdit, s.extensionduedate AS extensionAt,
            f.grade_value AS gradeValue, f.grade_raw_text AS gradeRaw, f.grade_for_display AS gradeDisplay,
            f.graded_date AS gradedAt, f.comment_html AS comment,
            c.shortname AS courseShortname
     FROM pva_assignment a
     LEFT JOIN pva_submission s ON s.assignment_id = a.assignment_id AND s.is_latest = 1
     LEFT JOIN pva_submission_feedback f ON f.assignment_id = a.assignment_id AND f.attemptnumber = s.attemptnumber
     LEFT JOIN pva_course c ON c.user_id = a.user_id AND c.course_id = a.course_id
     WHERE a.user_id = ? AND a.assignment_id = ?`,
    [userId, target.assignmentId],
    { a: 'pva_assignment', s: 'pva_submission', f: 'pva_submission_feedback', c: 'pva_course' }
  );
  if (!row) return { assignment: null, matches };
  return { assignment: row, matches };
}

export function pvaGradeItems(userId = LOCAL_USER_ID, courseId) {
  if (!hasTable('pva_grade_item')) return { items: [], total: null, access: null };
  const items = readRows(
    `SELECT i.item_id AS itemId, i.itemname AS name, i.itemtype, i.cmid, i.is_gradable AS isGradable,
            i.grademax AS gradeMax, i.sort_index AS sortIndex,
            v.graderaw_src AS raw, v.grade_display AS display, v.range_display AS range,
            v.percentage_display AS percentage, v.gradedategraded AS gradedAt,
            v.is_hidden AS isHidden, v.feedback_html AS feedback
     FROM pva_grade_item i
     LEFT JOIN pva_grade_value v ON v.item_id = i.item_id
     WHERE i.user_id = ? AND i.course_id = ?
     ORDER BY i.sort_index`,
    [userId, courseId],
    { i: 'pva_grade_item', v: 'pva_grade_value' }
  );
  const total = readRow(
    'SELECT t.grade_display AS display FROM pva_course_total t WHERE t.user_id = ? AND t.course_id = ?',
    [userId, courseId],
    { t: 'pva_course_total' }
  );
  const access = hasTable('pva_gradebook_access')
    ? readRow(
        `SELECT a.show_grades AS showGrades, a.reachable, a.last_errorcode AS errorcode, a.last_ok_at AS lastOkAt
         FROM pva_gradebook_access a WHERE a.user_id = ? AND a.course_id = ?`,
        [userId, courseId],
        { a: 'pva_gradebook_access' }
      )
    : null;
  return { items, total: total?.display ?? null, access };
}

export function pvaNotifications(userId = LOCAL_USER_ID, { limit = 20 } = {}) {
  if (!hasTable('pva_notification')) return [];
  return readRows(
    `SELECT n.notification_id AS notificationId, n.component, n.eventtype, n.subject,
            n.contexturl_name AS contextName, n.contexturl AS url, n.cmid, n.course_id AS courseId,
            n.created_at AS createdAt, n.read_remote AS readRemote,
            c.shortname AS courseShortname,
            f.type AS forumType
     FROM pva_notification n
     LEFT JOIN pva_course c ON c.user_id = n.user_id AND c.course_id = n.course_id
     LEFT JOIN pva_forum f ON f.user_id = n.user_id AND f.cmid = n.cmid
     WHERE n.user_id = ? AND n.deleted_remote = 0
     ORDER BY n.created_at DESC LIMIT ?`,
    [userId, limit],
    { n: 'pva_notification', c: 'pva_course', f: 'pva_forum' }
  );
}

export function pvaAnnouncementForums(userId = LOCAL_USER_ID) {
  if (!hasTable('pva_forum')) return [];
  return readRows(
    `SELECT f.forum_id AS forumId, f.course_id AS courseId, f.name, f.num_discussions AS numDiscussions,
            c.shortname AS courseShortname
     FROM pva_forum f
     LEFT JOIN pva_course c ON c.user_id = f.user_id AND c.course_id = f.course_id
     WHERE f.user_id = ? AND f.type = 'news'
     ORDER BY c.shortname`,
    [userId],
    { f: 'pva_forum', c: 'pva_course' }
  );
}

/**
 * El árbol de una materia. Solo lo de la última corrida: las filas con un
 * `seen_at` viejo son lo que el profesor sacó de la página, y siguen en la base
 * porque un cmid puede volver.
 */
export function pvaSections(userId = LOCAL_USER_ID, courseId, { sectionNumber = null } = {}) {
  if (!hasTable('pva_course_section')) return { sections: [], contentsAt: null };
  const sync = readRow(
    'SELECT s.contents_at AS contentsAt FROM pva_course_sync s WHERE s.user_id = ? AND s.course_id = ?',
    [userId, courseId],
    { s: 'pva_course_sync' }
  );
  if (!sync?.contentsAt) return { sections: [], contentsAt: null };

  const sections = readRows(
    `SELECT s.section_id AS sectionId, s.section_number AS number, s.name, s.summary_html AS summary
     FROM pva_course_section s
     WHERE s.user_id = ? AND s.course_id = ? AND s.seen_at = ?
       AND (? IS NULL OR s.section_number = ?)
     ORDER BY s.sort_index`,
    [userId, courseId, sync.contentsAt, sectionNumber, sectionNumber],
    { s: 'pva_course_section' }
  );

  const modules = readRows(
    `SELECT m.cmid, m.section_id AS sectionId, m.modname, m.name, m.url, m.no_view_link AS noViewLink,
            m.purpose, m.description_html AS description, m.completion_rule AS completionRule,
            m.completion_state AS completionState
     FROM pva_module m
     WHERE m.user_id = ? AND m.course_id = ? AND m.seen_at = ?
     ORDER BY m.sort_index`,
    [userId, courseId, sync.contentsAt],
    { m: 'pva_module' }
  );

  const dates = readRows(
    `SELECT d.cmid, d.data_id AS dataId, d.ts, d.label FROM pva_module_date d
     WHERE d.cmid IN (SELECT m.cmid FROM pva_module m WHERE m.user_id = ? AND m.course_id = ?)
     ORDER BY d.data_id`,
    [userId, courseId],
    { d: 'pva_module_date', m: 'pva_module' }
  );
  const datesByCmid = new Map();
  for (const date of dates) {
    if (!datesByCmid.has(date.cmid)) datesByCmid.set(date.cmid, []);
    datesByCmid.get(date.cmid).push(date);
  }

  return {
    contentsAt: sync.contentsAt,
    sections: sections.map((section) => ({
      ...section,
      modules: modules
        .filter((module) => module.sectionId === section.sectionId)
        .map((module) => ({ ...module, dates: datesByCmid.get(module.cmid) ?? [] })),
    })),
  };
}

export function pvaInaccessible(userId = LOCAL_USER_ID) {
  if (!hasTable('pva_assignment_inaccessible')) return [];
  return readRows(
    'SELECT i.course_id AS courseId, i.cmid FROM pva_assignment_inaccessible i WHERE i.user_id = ?',
    [userId],
    { i: 'pva_assignment_inaccessible' }
  );
}

export function pvaMissingEvents(userId = LOCAL_USER_ID) {
  if (!hasTable('pva_calendar_event')) return 0;
  const row = readRow(
    'SELECT COUNT(1) AS n FROM pva_calendar_event e WHERE e.user_id = ? AND e.missing_since IS NOT NULL',
    [userId],
    { e: 'pva_calendar_event' }
  );
  return row?.n ?? 0;
}

export { iso as pvaIso };

// ── Los materiales del aula ────────────────────────────────────────────────

/**
 * La consulta que entra al índice. No se le pasa el texto del usuario tal cual
 * a MATCH: la sintaxis de FTS5 tiene operadores y comillas, y un guion suelto o
 * unas comillas sin cerrar hacen que la búsqueda lance en vez de no encontrar.
 * Cada palabra se cita y se piden todas: es lo que la gente espera al escribir
 * dos palabras.
 */
export function ftsQuery(input) {
  const terms = String(input ?? '')
    .split(/\s+/)
    .map((term) => term.replace(/["*]/g, '').trim())
    .filter(Boolean);
  if (!terms.length) return null;
  return terms.map((term) => `"${term}"`).join(' AND ');
}

export function pvaSearchFiles(userId = LOCAL_USER_ID, input, { limit = 20 } = {}) {
  if (!hasTable('pva_file_text_fts')) return [];
  const query = ftsQuery(input);
  if (!query) return [];
  return readRows(
    `SELECT t.file_id AS fileId, t.extractor, t.pages,
            f.filename, f.course_id AS courseId, f.cmid,
            c.shortname AS courseShortname,
            m.name AS moduleName,
            snippet(pva_file_text_fts, 1, '«', '»', '…', 14) AS snippet
     FROM pva_file_text_fts
     JOIN pva_file_text t ON t.file_id = pva_file_text_fts.rowid
     JOIN pva_file f ON f.file_id = t.file_id
     LEFT JOIN pva_course c ON c.user_id = f.user_id AND c.course_id = f.course_id
     LEFT JOIN pva_module m ON m.cmid = f.cmid
     WHERE pva_file_text_fts MATCH ? AND f.user_id = ? AND f.deleted_at IS NULL
     ORDER BY bm25(pva_file_text_fts)
     LIMIT ?`,
    [query, userId, limit],
    { t: 'pva_file_text', f: 'pva_file', c: 'pva_course', m: 'pva_module' }
  );
}

/** Cuántos materiales hay y cuántos se pueden buscar de verdad. */
export function pvaCorpus(userId = LOCAL_USER_ID) {
  if (!hasTable('pva_file')) return { files: 0, downloaded: 0, indexed: 0 };
  const row = readRow(
    `SELECT COUNT(1) AS files,
            SUM(CASE WHEN t.file_id IS NOT NULL THEN 1 ELSE 0 END) AS downloaded,
            SUM(CASE WHEN t.content <> '' THEN 1 ELSE 0 END) AS indexed
     FROM pva_file f
     LEFT JOIN pva_file_text t ON t.file_id = f.file_id
     WHERE f.user_id = ? AND f.deleted_at IS NULL`,
    [userId],
    { f: 'pva_file', t: 'pva_file_text' }
  );
  return { files: row?.files ?? 0, downloaded: row?.downloaded ?? 0, indexed: row?.indexed ?? 0 };
}

/**
 * Un material concreto con su texto extraído, para leerlo entero.
 *
 * El blob NO entra acá: `local_path` sigue prohibido en la allowlist y esa
 * decisión no cambia. Lo que hace falta para escribir un apunte a partir de un
 * material es el TEXTO, no dónde vive el fichero en el disco de la persona.
 *
 * Un `pva_file_text` ausente significa "todavía no se bajó"; presente con
 * `content` vacío significa "se bajó y no dejó texto". Son dos respuestas
 * distintas y quien pregunte tiene derecho a distinguirlas.
 */
export function pvaFile(userId = LOCAL_USER_ID, fileId) {
  if (!hasTable('pva_file')) return null;
  return readRow(
    `SELECT f.file_id AS fileId, f.filename, f.course_id AS courseId, f.cmid,
            f.mimetype, f.filesize AS declaredBytes, f.component, f.area,
            c.shortname AS courseShortname,
            m.name AS moduleName,
            t.extractor, t.pages, t.content, t.extracted_at AS extractedAt
     FROM pva_file f
     LEFT JOIN pva_file_text t ON t.file_id = f.file_id
     LEFT JOIN pva_course c ON c.user_id = f.user_id AND c.course_id = f.course_id
     LEFT JOIN pva_module m ON m.cmid = f.cmid
     WHERE f.file_id = ? AND f.user_id = ? AND f.deleted_at IS NULL`,
    [fileId, userId],
    { f: 'pva_file', t: 'pva_file_text', c: 'pva_course', m: 'pva_module' }
  );
}

/** Materiales cuyo nombre de archivo contiene lo pedido, para resolver por nombre. */
export function pvaFindFiles(userId = LOCAL_USER_ID, { query, courseId = null, limit = 10 } = {}) {
  if (!hasTable('pva_file')) return [];
  const params = [userId, `%${String(query ?? '')}%`];
  if (courseId != null) params.push(courseId);
  params.push(limit);
  return readRows(
    `SELECT f.file_id AS fileId, f.filename, f.course_id AS courseId, c.shortname AS courseShortname
     FROM pva_file f
     LEFT JOIN pva_course c ON c.user_id = f.user_id AND c.course_id = f.course_id
     WHERE f.user_id = ? AND f.deleted_at IS NULL AND f.filename LIKE ? COLLATE NOCASE
       ${courseId != null ? 'AND f.course_id = ?' : ''}
     ORDER BY f.filename
     LIMIT ?`,
    params,
    { f: 'pva_file', c: 'pva_course' }
  );
}

/** Los materiales de un curso, por módulo, para colgarlos del árbol. */
export function pvaFilesByModule(userId = LOCAL_USER_ID, courseId) {
  if (!hasTable('pva_file')) return new Map();
  const rows = readRows(
    `SELECT f.file_id AS fileId, f.cmid, f.filename, f.mimetype, f.filesize AS declaredBytes,
            t.file_id AS textId, t.content, t.extractor
     FROM pva_file f
     LEFT JOIN pva_file_text t ON t.file_id = f.file_id
     WHERE f.user_id = ? AND f.course_id = ? AND f.deleted_at IS NULL
     ORDER BY f.filename`,
    [userId, courseId],
    { f: 'pva_file', t: 'pva_file_text' }
  );
  const byModule = new Map();
  for (const row of rows) {
    if (!byModule.has(row.cmid)) byModule.set(row.cmid, []);
    byModule.get(row.cmid).push(row);
  }
  return byModule;
}

export function pvaLinksByModule(userId = LOCAL_USER_ID, courseId) {
  if (!hasTable('pva_link')) return new Map();
  const rows = readRows(
    `SELECT l.cmid, l.name, l.url, l.host FROM pva_link l
     WHERE l.user_id = ? AND l.course_id = ? ORDER BY l.name`,
    [userId, courseId],
    { l: 'pva_link' }
  );
  const byModule = new Map();
  for (const row of rows) {
    if (!byModule.has(row.cmid)) byModule.set(row.cmid, []);
    byModule.get(row.cmid).push(row);
  }
  return byModule;
}
