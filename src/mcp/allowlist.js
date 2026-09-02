// La superficie de datos que el servidor MCP puede leer, declarada tabla por
// tabla y columna por columna.
//
// Es una ALLOWLIST y no una denylist porque una denylist se equivoca hacia
// afuera: el día que alguien agregue una tabla con un secreto adentro, una
// denylist la deja pasar y esta lista la deja afuera sin que nadie se acuerde
// de actualizarla. Lo que no está acá no existe para el MCP.
//
// Ausentes a propósito, y esto no se "arregla" agregándolas:
//   sessions              token_hash y csrf_token son la sesión local entera.
//   push_subscriptions    endpoint/p256dh/auth permiten mandar push al teléfono.
//   notifications         el feed personal de la persona, no dato académico. El
//                         código de confirmación ya no pasa por acá (sale por
//                         push), pero sí queda el rastro de cada acción que un
//                         agente propuso: leerlo le daría a un agente la
//                         actividad de los demás y de la persona.
//   notification_channels destinos de egress (webhooks del usuario).
//   app_meta              estado de producto, no dato académico.
// De `users` solo salen columnas no identificatorias: portal_username es la
// identidad de la persona en PeopleSoft y ninguna herramienta la necesita para
// contestar nada.

export const READ_ALLOWLIST = {
  users: ['id', 'created_at', 'last_login_at'],
  profile: ['user_id', 'career', 'pensum_no', 'plan_label', 'cohort_start_term', 'updated_at'],
  terms: ['code', 'label', 'start_date', 'end_date', 'updated_at'],
  courses: ['id', 'code', 'subject', 'catalog_nbr', 'title', 'career', 'credits', 'updated_at'],
  subjects: ['code', 'description'],
  sections: [
    'id', 'course_id', 'term', 'class_nbr', 'section', 'component', 'instructor', 'meetings',
    'updated_at',
    // Columnas que puede o no tener la base según su versión de esquema; leerlas
    // pasa por hasColumn(), nunca a ciegas.
    'campus', 'campus_source',
  ],
  seats_snapshot: ['id', 'section_id', 'status', 'seats_open', 'seats_cap', 'wait_total', 'captured_at'],
  enrollments: [
    'id', 'user_id', 'term', 'course_id', 'section_id', 'status', 'units', 'grading', 'grade',
    'start_date', 'end_date', 'updated_at',
  ],
  grades: [
    'id', 'user_id', 'term', 'course_code', 'subject', 'catalog_nbr', 'title', 'grade', 'credits',
    'status', 'captured_at',
  ],
  pensum: ['user_id', 'code', 'subject', 'catalog_nbr', 'units', 'status', 'taken_term', 'grade'],
  pensum_plans: ['id', 'plan_key', 'career', 'pensum_no', 'plan_label'],
  requirement_groups: [
    'id', 'plan_id', 'parent_id', 'kind', 'label', 'year', 'period', 'position', 'collapsed',
    'units_required', 'courses_required',
  ],
  requirement_courses: ['group_id', 'code', 'subject', 'catalog_nbr', 'title', 'units', 'is_candidate'],
  requirement_progress: [
    'user_id', 'plan_id', 'position', 'satisfied', 'collapsed', 'units_taken', 'units_needed',
    'courses_taken', 'courses_needed', 'gpa_actual',
  ],
  holds: ['id', 'user_id', 'code', 'title', 'description', 'severity', 'link', 'captured_at'],
  cart_rows: [
    'user_id', 'idx', 'class_label', 'course_code', 'title', 'section', 'class_nbr', 'instructor',
    'credits', 'campus', 'meetings', 'status', 'captured_at',
  ],
  enrollment_windows: ['term_code', 'session', 'starts_at', 'ends_at', 'precision', 'user_id', 'synced_at'],
  term_events: [
    'user_id', 'term_code', 'session', 'event', 'starts_on', 'ends_on', 'precision', 'source',
    'source_note', 'updated_at',
  ],
  goals: ['id', 'user_id', 'kind', 'target', 'deadline_term', 'created_at', 'achieved_at'],
  plans: ['id', 'user_id', 'term', 'name', 'created_at', 'updated_at'],
  plan_items: ['id', 'plan_id', 'course_id', 'section_id', 'status', 'note', 'locked'],
  sync_log: ['id', 'user_id', 'kind', 'term', 'status', 'detail', 'rows', 'started_at', 'finished_at'],
  action_log: ['id', 'user_id', 'action', 'detail', 'portal_response', 'ok', 'created_at'],
  watchers: [
    'user_id', 'interval_ms', 'last_check_at', 'auto_enroll', 'appointment_at', 'status',
    'next_check_at', 'consecutive_failures', 'pause_reason', 'last_state',
  ],
  schedules: ['user_id', 'at_iso', 'state', 'last_error', 'updated_at'],
  runtime_events: ['id', 'kind', 'detail', 'started_at', 'ended_at'],
};

// Nombres de columna que no pueden aparecer en una consulta del MCP ni siquiera
// sin calificar. Es la red debajo de la red: si mañana alguien agrega una tabla
// a la allowlist sin mirar sus columnas, estas siguen prohibidas.
export const FORBIDDEN_IDENTIFIERS = [
  'portal_username',
  'token_hash',
  'csrf_token',
  'p256dh',
  'endpoint',
  'password',
  'ciphertext',
  'secret',
];

const WRITE_KEYWORDS = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|reindex|pragma|begin|commit|rollback|savepoint)\b/i;

function stripLiterals(sql) {
  return sql.replace(/'[^']*'/g, "''");
}

// Valida una consulta contra la allowlist ANTES de prepararla.
//
// La regla de la casa: toda referencia a columna va calificada con el alias de
// su tabla (`c.code`, no `code`). No es estilo, es lo que hace verificable la
// lista de arriba: con la calificación, cada par tabla/columna se puede leer del
// SQL sin parsearlo entero.
//
// `aliases` mapea el alias usado en el SQL a su tabla real.
export function assertReadable(sql, aliases = {}) {
  const clean = stripLiterals(sql);

  if (WRITE_KEYWORDS.test(clean)) throw new Error('El carril de lectura del MCP no ejecuta sentencias que escriban');
  if (/;/.test(clean.trim().slice(0, -1))) throw new Error('Una consulta del MCP es una sola sentencia');
  if (/\*/.test(clean)) throw new Error('SELECT * está prohibido: toda columna se nombra a mano');

  for (const forbidden of FORBIDDEN_IDENTIFIERS) {
    if (new RegExp(`\\b${forbidden}\\b`, 'i').test(clean)) {
      throw new Error(`La columna ${forbidden} no se expone por MCP`);
    }
  }

  for (const match of clean.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi)) {
    const table = match[1].toLowerCase();
    if (!(table in READ_ALLOWLIST)) throw new Error(`La tabla ${table} no está en la allowlist de lectura`);
  }

  for (const match of clean.matchAll(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi)) {
    const [, qualifier, column] = match;
    const table = aliases[qualifier] ?? (qualifier in READ_ALLOWLIST ? qualifier : null);
    if (!table) throw new Error(`El alias ${qualifier} no declara a qué tabla apunta`);
    const columns = READ_ALLOWLIST[table];
    if (!columns) throw new Error(`La tabla ${table} no está en la allowlist de lectura`);
    if (!columns.includes(column)) throw new Error(`La columna ${table}.${column} no está en la allowlist de lectura`);
  }

  return sql;
}
