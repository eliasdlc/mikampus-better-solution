import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// MIKAMPUS_DB deja que los tests corran contra una DB desechable en vez de la
// real (scripts/test-catalog-db.mjs). En uso normal no se define.
export const DB_PATH = process.env.MIKAMPUS_DB ?? path.join(__dirname, '..', 'data', 'mikampus.db');

// node:sqlite (built-in de Node) en vez de better-sqlite3: API síncrona, un
// solo archivo, sin compilación nativa. Un server local monousuario no gana
// nada con async aquí; la simplicidad de leer/escribir sin `await` sí.
export const db = new DatabaseSync(DB_PATH);

// WAL mejora la concurrencia lectura/escritura (el server sirve endpoints
// mientras un scraper de fondo escribe). foreign_keys va OFF por defecto en
// SQLite; lo prendemos para que las FK de plan_items/sections se respeten.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// El esquema es idempotente (IF NOT EXISTS): correrlo en cada arranque hace de
// "migración" barata para una app local. Modelo:
//   course   = entrada del catálogo, independiente del término ("ICC-303").
//   section  = una clase concreta de un término (class_nbr 4567) con horario.
//   seats_snapshot = serie temporal del cupo de una sección (lo único volátil).
db.exec(`
  -- Quién usa mikampus (Fase 2 de LANZAMIENTO.md). El login ES el del portal:
  -- no hay contraseña propia acá — la identidad es el username de micampus, y
  -- verificarla es loguearse contra PeopleSoft. La fila 1 nace en la migración
  -- adoptando los datos pre-multi-usuario; portal_username puede ser NULL hasta
  -- que se conozca (el modo local lo adopta del .env/account.json al arrancar).
  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    portal_username TEXT UNIQUE COLLATE NOCASE,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at   TEXT
  );

  -- Sesiones de mikampus (no del portal): la cookie del browser lleva un token
  -- aleatorio y acá vive solo su hash — robarse la DB no roba sesiones. El
  -- csrf_token acompaña a cada sesión: toda mutación exige repetirlo en un
  -- header, porque una API JSON mutante con cookie y sin CSRF es auth
  -- decorativa (§5). La cookie es larga a propósito (§5.1): la app abre al
  -- instante con lo cacheado; la credencial del portal vive mucho menos.
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    csrf_token  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at  TEXT NOT NULL,
    revoked_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS courses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT NOT NULL UNIQUE,          -- canónico, ej. "ICC-303"
    subject     TEXT NOT NULL,                 -- ej. "ICC"
    catalog_nbr TEXT NOT NULL,                 -- ej. "303"
    title       TEXT NOT NULL,                 -- ej. "Estructuras de Datos"
    career      TEXT,                          -- GRDO / etc.
    credits     REAL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Los subjects que el portal dice que existen (Browse Course Catalog).
  -- No es una lista decorativa: partir "ICC223" en ICC + 223 necesita saber
  -- qué prefijos son subjects reales (ver shared/courseCode.ts), y sin esto
  -- la app tendría que hardcodearlos.
  CREATE TABLE IF NOT EXISTS subjects (
    code        TEXT PRIMARY KEY,             -- ej. "ICC"
    description TEXT,                         -- PUCMM hoy repite el código acá
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- El diccionario de términos: el único lugar donde el código STRM del portal
  -- ("1930") y la etiqueta en español ("Septiembre de 2026") viven en la misma
  -- fila. Sin esto la app tiene dos vocabularios de término que nada cruza —
  -- STRM en sections/enrollments/plans, etiquetas en grades/pensum — y no puede
  -- decir cuál ciclo corre hoy. Las fechas (de enrollments/MTG_DATES) permiten
  -- resolver "actual" vs "siguiente" contra la fecha real; cuando faltan, la
  -- resolución cae a una ventana derivada de la etiqueta (ver shared/terms.ts).
  -- code puede ser NULL: un término que solo aparece en grades (un ciclo pasado
  -- o futuro que nunca se scrapeó del class search) se conoce por su etiqueta.
  CREATE TABLE IF NOT EXISTS terms (
    code        TEXT UNIQUE,                 -- STRM, ej. "1930" (NULL si solo hay etiqueta)
    label       TEXT PRIMARY KEY,            -- ej. "Septiembre de 2026"
    start_date  TEXT,                        -- ISO; de enrollments si Mi Horario lo trajo
    end_date    TEXT,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- El avance PERSONAL de un estudiante sobre su pénsum, derivado del
  -- advisement en cada sync. Es QUÉ le falta y qué ya cursó — la estructura de
  -- la carrera (qué exige el plan) vive en las tablas compartidas de abajo.
  CREATE TABLE IF NOT EXISTS pensum (
    user_id     INTEGER NOT NULL DEFAULT 1,
    code        TEXT NOT NULL,                -- canónico, ej. "FIS-1FIS139"
    subject     TEXT NOT NULL,
    catalog_nbr TEXT NOT NULL,
    units       REAL,
    status      TEXT NOT NULL,                -- taken / in_progress / planned / pending
    taken_term  TEXT,                         -- ej. "Enero de 2025"
    grade       TEXT,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, code)
  );

  -- Un pénsum por carrera+versión (§3.1): el árbol de requisitos es del PLAN,
  -- no del estudiante — solo el progreso es privado. plan_key es carrera|número
  -- (o la etiqueta del informe si el parser no los pudo separar).
  CREATE TABLE IF NOT EXISTS pensum_plans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_key    TEXT NOT NULL UNIQUE,
    career      TEXT,
    pensum_no   TEXT,
    plan_label  TEXT,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- El árbol de requisitos COMPARTIDO (parser v2, peoplesoft/advisement.js):
  -- período → obligatorios/electivas → cursos, sin nada personal. El advisement
  -- de cada estudiante lo alimenta con merge conservador: un grupo guardado con
  -- candidatas visibles nunca se pisa con la versión colapsada del mismo grupo
  -- (el informe de un estudiante de término alto es MÁS POBRE que el de un
  -- freshman de la misma carrera — §3.1). collapsed marca la calidad de lo
  -- guardado: 1 = esta versión vino sin candidatas. La columna position es el
  -- orden del documento: la identidad del grupo dentro de su plan.
  CREATE TABLE IF NOT EXISTS requirement_groups (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id          INTEGER NOT NULL REFERENCES pensum_plans(id) ON DELETE CASCADE,
    parent_id        INTEGER REFERENCES requirement_groups(id) ON DELETE CASCADE,
    kind             TEXT NOT NULL,                -- root / periodo / obligatorios / electiva / grupo
    label            TEXT NOT NULL,
    year             INTEGER,                      -- del "Año N Período M"
    period           INTEGER,
    position         INTEGER NOT NULL,             -- orden del documento
    collapsed        INTEGER NOT NULL DEFAULT 0,   -- 1 = versión sin candidatas visibles
    units_required   REAL,
    courses_required INTEGER,
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (plan_id, position)
  );

  CREATE TABLE IF NOT EXISTS requirement_courses (
    group_id     INTEGER NOT NULL REFERENCES requirement_groups(id) ON DELETE CASCADE,
    code         TEXT NOT NULL,                    -- canónico, ej. "FIS-1FIS139"
    subject      TEXT,
    catalog_nbr  TEXT,
    title        TEXT,
    units        REAL,
    is_candidate INTEGER NOT NULL DEFAULT 0,       -- candidata de electiva, no obligatoria
    PRIMARY KEY (group_id, code)
  );

  -- Lo PERSONAL de cada grupo del árbol: satisfecho o no, créditos tomados,
  -- GPA del grupo. Se reemplaza entero en cada sync del advisement del usuario.
  -- Se ancla por (plan, position) y no por group_id para sobrevivir a un
  -- reemplazo del grupo compartido.
  CREATE TABLE IF NOT EXISTS requirement_progress (
    user_id          INTEGER NOT NULL,
    plan_id          INTEGER NOT NULL REFERENCES pensum_plans(id) ON DELETE CASCADE,
    position         INTEGER NOT NULL,
    satisfied        INTEGER NOT NULL DEFAULT 0,
    collapsed        INTEGER NOT NULL DEFAULT 0,   -- así lo vio SU informe
    units_taken      REAL,
    units_needed     REAL,
    courses_taken    INTEGER,
    courses_needed   INTEGER,
    gpa_actual       REAL,
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, plan_id, position)
  );

  -- Quién es cada estudiante: carrera y número de pénsum salen del advisement;
  -- la cohorte (primer término con notas) la aporta grades. Un perfil por
  -- usuario (antes era una sola fila con id = 1).
  CREATE TABLE IF NOT EXISTS profile (
    user_id            INTEGER PRIMARY KEY,
    career             TEXT,
    pensum_no          TEXT,
    plan_label         TEXT,
    cohort_start_term  TEXT,
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sections (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id   INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    term        TEXT NOT NULL,                 -- código de término de PeopleSoft
    class_nbr   TEXT NOT NULL,                 -- ej. "4567"
    section     TEXT,                          -- ej. "01-LEC"
    component   TEXT,                          -- LEC / LAB / PRA
    instructor  TEXT,
    meetings    TEXT,                          -- JSON: [{days,start,end,room}]
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (term, class_nbr)
  );

  CREATE INDEX IF NOT EXISTS idx_sections_course ON sections(course_id);
  CREATE INDEX IF NOT EXISTS idx_sections_term ON sections(term);

  CREATE TABLE IF NOT EXISTS seats_snapshot (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    section_id   INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    status       TEXT NOT NULL,                -- open / waitlist / closed
    seats_open   INTEGER,
    seats_cap    INTEGER,
    wait_total   INTEGER,
    captured_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_seats_section ON seats_snapshot(section_id, captured_at);

  -- Qué secciones tengo inscritas en un término. sections guarda TODA sección
  -- conocida (el catálogo también escribe ahí), así que hace falta marcar
  -- explícitamente cuáles son mías: sin esto no se puede distinguir "ICC-233
  -- existe" de "estoy en la 101 de ICC-233".
  -- Una fila por sección inscrita. status/units son atributos de la materia y
  -- se repiten en sus componentes (una LEC y su PRA comparten los dos): es
  -- redundancia acotada (2-3 filas por materia) a cambio de que dibujar el
  -- horario sea un solo SELECT.
  CREATE TABLE IF NOT EXISTS enrollments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL DEFAULT 1,
    term        TEXT NOT NULL,
    course_id   INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    section_id  INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    status      TEXT NOT NULL,                -- enrolled / dropped / waitlisted
    units       REAL,
    grading     TEXT,
    grade       TEXT,
    start_date  TEXT,                         -- ISO; el ICS los necesita para
    end_date    TEXT,                         -- acotar la recurrencia
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, term, section_id)
  );

  CREATE INDEX IF NOT EXISTS idx_enrollments_term ON enrollments(term);

  CREATE TABLE IF NOT EXISTS plans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL DEFAULT 1,
    term        TEXT NOT NULL,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS plan_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id     INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    course_id   INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    section_id  INTEGER REFERENCES sections(id) ON DELETE SET NULL,
    status      TEXT NOT NULL DEFAULT 'desired', -- desired / planned
    note        TEXT,
    locked      INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_plan_items_plan ON plan_items(plan_id);

  -- Metas del estudiante (Fase 10, §12.7). Por ahora solo 'gpa': un índice
  -- objetivo, con un término límite opcional. Es un dato hecho a mano —como los
  -- planes— así que no entra a PERSONAL_TABLES: no se borra al cambiar de cuenta.
  -- user_id nace ya (constante 1) para abaratar el multi-usuario (§0). El
  -- veredicto (alcanzable/inalcanzable) NO se guarda: se calcula en vivo con
  -- shared/gpa.ts contra las notas del momento, para que no envejezca en la fila.
  CREATE TABLE IF NOT EXISTS goals (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL DEFAULT 1,
    kind           TEXT NOT NULL DEFAULT 'gpa',
    target         REAL NOT NULL,
    deadline_term  TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    achieved_at    TEXT
  );

  -- El histórico de notas, leído de My Course History. Una materia repetida
  -- aparece dos veces con términos distintos, así que la identidad de una fila
  -- es término+código, no el código solo.
  -- Sin grade_points a propósito: Course History no los da y el índice se
  -- calcula con shared/gpa.ts, que reproduce exacto los totales del portal.
  -- Guardar un número derivado acá sería una segunda verdad que puede mentir.
  CREATE TABLE IF NOT EXISTS grades (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL DEFAULT 1,
    term         TEXT NOT NULL,
    course_id    INTEGER REFERENCES courses(id) ON DELETE SET NULL,
    course_code  TEXT,
    subject      TEXT,
    catalog_nbr  TEXT,
    title        TEXT,
    grade        TEXT,
    credits      REAL,
    status       TEXT NOT NULL DEFAULT 'taken', -- taken / in_progress / transferred
    captured_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS progress_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL DEFAULT 1,
    requirement  TEXT,
    course_code  TEXT,
    title        TEXT,
    status       TEXT NOT NULL,                -- approved / in_progress / pending / eligible
    term         TEXT,
    captured_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Holds del Centro del Alumnado. severity nace 'unknown' a propósito: el
  -- estudiante no tiene holds, así que el recon no pudo ver si el portal dice
  -- cuáles bloquean la inscripción (ver peoplesoft/holds.js). 'unknown' no es
  -- "no bloquea": es "el portal no nos lo dijo".
  CREATE TABLE IF NOT EXISTS holds (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL DEFAULT 1,
    code         TEXT,
    title        TEXT NOT NULL,
    description  TEXT,
    severity     TEXT NOT NULL DEFAULT 'unknown', -- blocking / info / unknown
    link         TEXT,
    captured_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- El carrito de inscripción, cacheado. Es el estado completo del carrito del
  -- portal en un momento dado, no una acumulación: cada sync borra y reescribe,
  -- porque una fila que ya no está en el portal tampoco está en el carrito.
  -- Existe para que abrir una pantalla nunca dispare Playwright (el Dashboard
  -- lo lee en cada carga); la lectura en vivo es explícita.
  CREATE TABLE IF NOT EXISTS cart_rows (
    user_id      INTEGER NOT NULL DEFAULT 1,
    idx          INTEGER NOT NULL,             -- posición en el carrito del portal
    class_label  TEXT NOT NULL,
    course_code  TEXT,
    title        TEXT NOT NULL,
    section      TEXT,
    class_nbr    TEXT,
    instructor   TEXT,
    credits      REAL,
    campus       TEXT,
    meetings     TEXT,                         -- JSON: [{days,start,end,room}]
    status       TEXT,                         -- open / waitlist / closed
    captured_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, idx)
  );

  -- user_id NULL = sync compartido (catálogo, subjects, títulos: los corre la
  -- cuenta de servicio para todos); con valor, el sync personal de ese usuario.
  CREATE TABLE IF NOT EXISTS sync_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER,
    kind         TEXT NOT NULL,                -- catalog / mySchedule / grades / ...
    term         TEXT,
    status       TEXT NOT NULL,                -- ok / error
    detail       TEXT,
    rows         INTEGER,
    started_at   TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at  TEXT
  );

  -- Ventana que PeopleSoft publica bajo Enrollment Dates. El portal
  -- reconocido en jul-2026 solo da FECHAS (sin hora); precision evita que una
  -- medianoche inventada termine programando una inscripción a la hora falsa.
  CREATE TABLE IF NOT EXISTS enrollment_windows (
    term_code    TEXT NOT NULL,
    session      TEXT NOT NULL DEFAULT 'Regular Academic Session',
    starts_at    TEXT NOT NULL,
    ends_at      TEXT NOT NULL,
    precision    TEXT NOT NULL DEFAULT 'date', -- date / datetime
    user_id      INTEGER NOT NULL DEFAULT 1,
    synced_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, term_code, session)
  );
`);

// CREATE TABLE IF NOT EXISTS no reforma una tabla que ya existe: una columna
// nueva llega a las bases recién creadas y no a la que el usuario ya tiene.
// Esto agrega la columna solo si falta, que es todo lo que necesita una app
// local sin sistema de migraciones. Es aditivo: no borra ni reescribe nada.
// Devuelve si la agregó, para que una migración pueda backfillear solo una vez.
function addColumnIfMissing(table, column, definition) {
  const exists = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return !exists;
}

function hasColumn(table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === column);
}

// ALTER TABLE no puede cambiar una PK ni un UNIQUE: para eso SQLite exige
// recrear la tabla y copiar las filas. copySelect dice cómo salen las filas de
// la tabla vieja (acá es donde la migración "adopta" lo existente como del
// usuario 1). Todo o nada: si la copia falla, la tabla vieja queda intacta.
function rebuildTable(table, createSql, copySelect) {
  db.exec('BEGIN');
  try {
    db.exec(createSql.replace(`CREATE TABLE IF NOT EXISTS ${table}`, `CREATE TABLE ${table}__new`));
    db.exec(`INSERT INTO ${table}__new ${copySelect}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${table}__new RENAME TO ${table}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// El estado de una materia del histórico (cursada / cursando / transferida) lo
// pide shared/gpa.ts para no meter al índice lo que el portal no cuenta.
addColumnIfMissing('grades', 'status', "TEXT NOT NULL DEFAULT 'taken'");
// subject y catalog_nbr se guardan como en `pensum`: el código canónico solo no
// alcanza, y derivarlo partiendo el string en cada lectura sería una segunda
// implementación de una regla que ya vive en shared/courseCode.ts.
addColumnIfMissing('grades', 'subject', 'TEXT');
addColumnIfMissing('grades', 'catalog_nbr', 'TEXT');

// ── Migración multi-usuario (Fase 2 de LANZAMIENTO.md) ─────────────────────
// Una DB pre-existente es la de una sola persona: sus filas se adoptan como
// del usuario 1 (el DEFAULT 1 de las columnas nuevas hace el backfill solo).
// Las tablas cuya identidad cambia (PK/UNIQUE ahora incluyen al usuario) se
// recrean copiando las filas con user_id = 1.

db.prepare('INSERT OR IGNORE INTO users (id) VALUES (1)').run();

// Columnas simples: el ALTER con DEFAULT 1 adopta lo existente en el acto.
addColumnIfMissing('grades', 'user_id', 'INTEGER NOT NULL DEFAULT 1');
addColumnIfMissing('holds', 'user_id', 'INTEGER NOT NULL DEFAULT 1');
addColumnIfMissing('progress_items', 'user_id', 'INTEGER NOT NULL DEFAULT 1');
addColumnIfMissing('plans', 'user_id', 'INTEGER NOT NULL DEFAULT 1');

// En sync_log NULL significa "sync compartido" (catálogo y afines): el
// backfill marca como del usuario 1 solo los kinds personales, una única vez.
const SHARED_SYNC_KINDS = ['catalog', 'subjects', 'titles'];
if (addColumnIfMissing('sync_log', 'user_id', 'INTEGER')) {
  const placeholders = SHARED_SYNC_KINDS.map(() => '?').join(', ');
  db.prepare(`UPDATE sync_log SET user_id = 1 WHERE kind NOT IN (${placeholders})`).run(...SHARED_SYNC_KINDS);
}

// enrollments: el UNIQUE pasa de (term, section_id) a incluir al usuario.
if (!hasColumn('enrollments', 'user_id')) {
  rebuildTable(
    'enrollments',
    `CREATE TABLE IF NOT EXISTS enrollments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL DEFAULT 1,
      term        TEXT NOT NULL,
      course_id   INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      section_id  INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
      status      TEXT NOT NULL,
      units       REAL,
      grading     TEXT,
      grade       TEXT,
      start_date  TEXT,
      end_date    TEXT,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, term, section_id)
    )`,
    `(id, user_id, term, course_id, section_id, status, units, grading, grade, start_date, end_date, updated_at)
     SELECT id, 1, term, course_id, section_id, status, units, grading, grade, start_date, end_date, updated_at
     FROM enrollments`
  );
  db.exec('CREATE INDEX IF NOT EXISTS idx_enrollments_term ON enrollments(term)');
}

// cart_rows: la PK pasa de idx a (user_id, idx) — dos carritos no se pisan.
if (!hasColumn('cart_rows', 'user_id')) {
  rebuildTable(
    'cart_rows',
    `CREATE TABLE IF NOT EXISTS cart_rows (
      user_id      INTEGER NOT NULL DEFAULT 1,
      idx          INTEGER NOT NULL,
      class_label  TEXT NOT NULL,
      course_code  TEXT,
      title        TEXT NOT NULL,
      section      TEXT,
      class_nbr    TEXT,
      instructor   TEXT,
      credits      REAL,
      campus       TEXT,
      meetings     TEXT,
      status       TEXT,
      captured_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, idx)
    )`,
    `(user_id, idx, class_label, course_code, title, section, class_nbr, instructor, credits, campus, meetings, status, captured_at)
     SELECT 1, idx, class_label, course_code, title, section, class_nbr, instructor, credits, campus, meetings, status, captured_at
     FROM cart_rows`
  );
}

// profile: de "una sola fila id = 1" a un perfil por usuario.
if (!hasColumn('profile', 'user_id')) {
  rebuildTable(
    'profile',
    `CREATE TABLE IF NOT EXISTS profile (
      user_id            INTEGER PRIMARY KEY,
      career             TEXT,
      pensum_no          TEXT,
      plan_label         TEXT,
      cohort_start_term  TEXT,
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `(user_id, career, pensum_no, plan_label, cohort_start_term, updated_at)
     SELECT 1, career, pensum_no, plan_label, cohort_start_term, updated_at
     FROM profile WHERE id = 1`
  );
}

// pensum: la PK pasa de code a (user_id, code).
if (!hasColumn('pensum', 'user_id')) {
  rebuildTable(
    'pensum',
    `CREATE TABLE IF NOT EXISTS pensum (
      user_id     INTEGER NOT NULL DEFAULT 1,
      code        TEXT NOT NULL,
      subject     TEXT NOT NULL,
      catalog_nbr TEXT NOT NULL,
      units       REAL,
      status      TEXT NOT NULL,
      taken_term  TEXT,
      grade       TEXT,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, code)
    )`,
    `(user_id, code, subject, catalog_nbr, units, status, taken_term, grade, updated_at)
     SELECT 1, code, subject, catalog_nbr, units, status, taken_term, grade, updated_at
     FROM pensum`
  );
}

// El árbol legacy (de un solo dueño, con stats personales en las filas) se
// separa en sus dos mitades: la estructura pasa al plan compartido y las stats
// a requirement_progress del usuario 1. El plan sale del perfil ya migrado.
if (!hasColumn('requirement_groups', 'plan_id')) {
  const prof = db.prepare('SELECT career, pensum_no, plan_label FROM profile WHERE user_id = 1').get();
  db.exec('BEGIN');
  try {
    if (prof && db.prepare('SELECT COUNT(*) AS n FROM requirement_groups').get().n > 0) {
      const planKey = prof.career && prof.pensum_no ? `${prof.career}|${prof.pensum_no}` : prof.plan_label ?? 'desconocido';
      db.prepare('INSERT OR IGNORE INTO pensum_plans (plan_key, career, pensum_no, plan_label) VALUES (?, ?, ?, ?)').run(
        planKey, prof.career, prof.pensum_no, prof.plan_label
      );
      const planId = db.prepare('SELECT id FROM pensum_plans WHERE plan_key = ?').get(planKey).id;

      db.exec(`CREATE TABLE requirement_groups__new (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id          INTEGER NOT NULL REFERENCES pensum_plans(id) ON DELETE CASCADE,
        parent_id        INTEGER REFERENCES requirement_groups__new(id) ON DELETE CASCADE,
        kind             TEXT NOT NULL,
        label            TEXT NOT NULL,
        year             INTEGER,
        period           INTEGER,
        position         INTEGER NOT NULL,
        collapsed        INTEGER NOT NULL DEFAULT 0,
        units_required   REAL,
        courses_required INTEGER,
        updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (plan_id, position)
      )`);
      db.prepare(
        `INSERT INTO requirement_groups__new
           (id, plan_id, parent_id, kind, label, year, period, position, collapsed, units_required, courses_required, updated_at)
         SELECT id, ?, parent_id, kind, label, year, period, position, collapsed, units_required, courses_required, updated_at
         FROM requirement_groups`
      ).run(planId);
      db.prepare(
        `INSERT INTO requirement_progress
           (user_id, plan_id, position, satisfied, collapsed, units_taken, units_needed, courses_taken, courses_needed, gpa_actual)
         SELECT 1, ?, position, satisfied, collapsed, units_taken, units_needed, courses_taken, courses_needed, gpa_actual
         FROM requirement_groups`
      ).run(planId);
      db.exec(`CREATE TABLE requirement_courses__new (
        group_id     INTEGER NOT NULL REFERENCES requirement_groups__new(id) ON DELETE CASCADE,
        code         TEXT NOT NULL,
        subject      TEXT,
        catalog_nbr  TEXT,
        title        TEXT,
        units        REAL,
        is_candidate INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (group_id, code)
      )`);
      db.exec(
        `INSERT INTO requirement_courses__new (group_id, code, subject, catalog_nbr, title, units, is_candidate)
         SELECT group_id, code, subject, catalog_nbr, title, units, is_candidate FROM requirement_courses`
      );
      db.exec('DROP TABLE requirement_courses');
      db.exec('DROP TABLE requirement_groups');
      db.exec('ALTER TABLE requirement_groups__new RENAME TO requirement_groups');
      db.exec('ALTER TABLE requirement_courses__new RENAME TO requirement_courses');
    } else {
      // Sin perfil no se sabe de qué plan era el árbol; era re-scrapeable y se
      // reconstruye en el primer sync.
      db.exec('DROP TABLE requirement_courses');
      db.exec('DROP TABLE requirement_groups');
      db.exec(`CREATE TABLE requirement_groups (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id          INTEGER NOT NULL REFERENCES pensum_plans(id) ON DELETE CASCADE,
        parent_id        INTEGER REFERENCES requirement_groups(id) ON DELETE CASCADE,
        kind             TEXT NOT NULL,
        label            TEXT NOT NULL,
        year             INTEGER,
        period           INTEGER,
        position         INTEGER NOT NULL,
        collapsed        INTEGER NOT NULL DEFAULT 0,
        units_required   REAL,
        courses_required INTEGER,
        updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (plan_id, position)
      )`);
      db.exec(`CREATE TABLE requirement_courses (
        group_id     INTEGER NOT NULL REFERENCES requirement_groups(id) ON DELETE CASCADE,
        code         TEXT NOT NULL,
        subject      TEXT,
        catalog_nbr  TEXT,
        title        TEXT,
        units        REAL,
        is_candidate INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (group_id, code)
      )`);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

db.exec('CREATE INDEX IF NOT EXISTS idx_grades_user ON grades(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_enrollments_user ON enrollments(user_id, term)');
db.exec('CREATE INDEX IF NOT EXISTS idx_plans_user ON plans(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_sync_log_kind ON sync_log(kind, user_id, finished_at)');

// Datos que pertenecen a una cuenta concreta: notas, horario inscrito, avance,
// holds, carrito y planes. El catálogo (courses/subjects/sections/seats) es
// compartido y NO se toca. pensum y el árbol de requisitos siguen acá hasta el
// re-modelado por carrera (§3.1): hoy son de un solo dueño.
// plans y goals quedan fuera a propósito: son trabajo hecho a mano (como
// siempre); cambiar de cuenta no los borra. El "Borrar todos mis datos" del §8
// sí los incluye — esa es otra operación (deleteAllUserData). El árbol
// compartido (pensum_plans/requirement_groups/requirement_courses) no se toca
// jamás: es de la carrera, no de la persona.
const PERSONAL_TABLES = [
  'grades', 'enrollments', 'progress_items', 'holds', 'cart_rows',
  'profile', 'enrollment_windows', 'pensum', 'requirement_progress',
];
// Los `kind` de sync_log de esos mismos datos: hay que borrarlos también, o el
// StalenessTag seguiría diciendo "actualizado hace 2h" sobre tablas ya vacías.
const PERSONAL_SYNC_KINDS = ['grades', 'mySchedule', 'advisement', 'holds', 'cart', 'enrollmentWindows'];

// Borra todo lo que es de UNA persona: sus filas, nunca las de otro usuario ni
// lo compartido. Lo usa el cambio de cuenta local y el "Borrar mis datos" (§8).
export function clearPersonalData(userId) {
  if (!Number.isInteger(userId)) throw new Error('clearPersonalData necesita un userId');
  db.exec('BEGIN');
  try {
    for (const table of PERSONAL_TABLES) {
      db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
    }
    const placeholders = PERSONAL_SYNC_KINDS.map(() => '?').join(', ');
    db.prepare(`DELETE FROM sync_log WHERE user_id = ? AND kind IN (${placeholders})`).run(
      userId,
      ...PERSONAL_SYNC_KINDS
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// El "Borrar todos mis datos" del §8: lo de clearPersonalData MÁS el trabajo
// hecho a mano (planes, metas) y el propio usuario. Su cuenta de micampus no se
// toca — mikampus solo puede borrar lo suyo.
export function deleteAllUserData(userId) {
  clearPersonalData(userId);
  db.exec('BEGIN');
  try {
    for (const table of ['plans', 'goals']) {
      db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
    }
    db.prepare('DELETE FROM sync_log WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Registra el resultado de una corrida de scraping para poder mostrar
// StalenessTag ("actualizado hace 2h") y depurar selectores rotos.
// userId null = sync compartido (catálogo); con valor, el de ese usuario.
export function logSync({ userId = null, kind, term = null, status, detail = null, rows = null }) {
  db.prepare(
    `INSERT INTO sync_log (user_id, kind, term, status, detail, rows, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(userId, kind, term, status, detail, rows);
}

// Última sincronización exitosa de un tipo de dato (para el StalenessTag).
// Para un kind personal se pasa userId; para uno compartido se omite y matchea
// las filas con user_id NULL.
export function lastSync(kind, { term = null, userId = null } = {}) {
  const conditions = ['kind = ?', "status = 'ok'", userId == null ? 'user_id IS NULL' : 'user_id = ?'];
  const params = userId == null ? [kind] : [kind, userId];
  if (term != null) {
    conditions.push('term = ?');
    params.push(term);
  }
  const row = db
    .prepare(
      `SELECT finished_at FROM sync_log
       WHERE ${conditions.join(' AND ')}
       ORDER BY finished_at DESC LIMIT 1`
    )
    .get(...params);
  return row?.finished_at ?? null;
}
