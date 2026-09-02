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
