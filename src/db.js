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

  CREATE TABLE IF NOT EXISTS grades (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    term         TEXT NOT NULL,
    course_id    INTEGER REFERENCES courses(id) ON DELETE SET NULL,
    course_code  TEXT,
    title        TEXT,
    grade        TEXT,
    credits      REAL,
    grade_points REAL,
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
