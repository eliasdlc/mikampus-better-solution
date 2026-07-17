import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// MIKAMPUS_DB deja que los tests corran contra una DB desechable en vez de la
// real (scripts/test-catalog-db.mjs). En uso normal no se define.
const DB_PATH = process.env.MIKAMPUS_DB ?? path.join(__dirname, '..', 'data', 'mikampus.db');

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

  -- El pensum del estudiante y su avance, leído del advisement report
  -- (My Academic Requirements). Es QUÉ materias exige su carrera y cuáles ya
  -- cursó — no es el catálogo: los títulos y las secciones viven en courses
  -- y sections, y se cruzan por el código canónico.
  -- Se lee del portal a propósito: una lista de materias mantenida a mano
  -- envejece en silencio cuando la universidad cambia el plan.
  CREATE TABLE IF NOT EXISTS pensum (
    code        TEXT PRIMARY KEY,             -- canónico, ej. "FIS-1FIS139"
    subject     TEXT NOT NULL,
    catalog_nbr TEXT NOT NULL,
    units       REAL,
    status      TEXT NOT NULL,                -- taken / in_progress / planned / pending
    taken_term  TEXT,                         -- ej. "Enero de 2025"
    grade       TEXT,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
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
    UNIQUE (term, section_id)
  );

  CREATE INDEX IF NOT EXISTS idx_enrollments_term ON enrollments(term);

  CREATE TABLE IF NOT EXISTS plans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
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

  -- El histórico de notas, leído de My Course History. Una materia repetida
  -- aparece dos veces con términos distintos, así que la identidad de una fila
  -- es término+código, no el código solo.
  -- Sin grade_points a propósito: Course History no los da y el índice se
  -- calcula con shared/gpa.ts, que reproduce exacto los totales del portal.
  -- Guardar un número derivado acá sería una segunda verdad que puede mentir.
  CREATE TABLE IF NOT EXISTS grades (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    term         TEXT NOT NULL,
    course_id    INTEGER REFERENCES courses(id) ON DELETE SET NULL,
    course_code  TEXT,
    title        TEXT,
    grade        TEXT,
    credits      REAL,
    status       TEXT NOT NULL DEFAULT 'taken', -- taken / in_progress / transferred
    captured_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS progress_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    requirement  TEXT,
    course_code  TEXT,
    title        TEXT,
    status       TEXT NOT NULL,                -- approved / in_progress / pending / eligible
    term         TEXT,
    captured_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS holds (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    code         TEXT,
    title        TEXT NOT NULL,
    description  TEXT,
    severity     TEXT NOT NULL DEFAULT 'info', -- blocking / info
    link         TEXT,
    captured_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sync_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT NOT NULL,                -- catalog / mySchedule / grades / ...
    term         TEXT,
    status       TEXT NOT NULL,                -- ok / error
    detail       TEXT,
    rows         INTEGER,
    started_at   TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at  TEXT
  );
`);

// CREATE TABLE IF NOT EXISTS no reforma una tabla que ya existe: una columna
// nueva llega a las bases recién creadas y no a la que el usuario ya tiene.
// Esto agrega la columna solo si falta, que es todo lo que necesita una app
// local sin sistema de migraciones. Es aditivo: no borra ni reescribe nada.
function addColumnIfMissing(table, column, definition) {
  const exists = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// El estado de una materia del histórico (cursada / cursando / transferida) lo
// pide shared/gpa.ts para no meter al índice lo que el portal no cuenta.
addColumnIfMissing('grades', 'status', "TEXT NOT NULL DEFAULT 'taken'");

// Registra el resultado de una corrida de scraping para poder mostrar
// StalenessTag ("actualizado hace 2h") y depurar selectores rotos.
export function logSync({ kind, term = null, status, detail = null, rows = null }) {
  db.prepare(
    `INSERT INTO sync_log (kind, term, status, detail, rows, finished_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).run(kind, term, status, detail, rows);
}

// Última sincronización exitosa de un tipo de dato (para el StalenessTag).
export function lastSync(kind, term = null) {
  const row = term
    ? db
        .prepare(
          `SELECT finished_at FROM sync_log
           WHERE kind = ? AND term = ? AND status = 'ok'
           ORDER BY finished_at DESC LIMIT 1`
        )
        .get(kind, term)
    : db
        .prepare(
          `SELECT finished_at FROM sync_log
           WHERE kind = ? AND status = 'ok'
           ORDER BY finished_at DESC LIMIT 1`
        )
        .get(kind);
  return row?.finished_at ?? null;
}
