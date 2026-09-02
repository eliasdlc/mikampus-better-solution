// Fechas de ciclo que son de otro ciclo. La reparación de identidad devolvió a
// NULL la etiqueta que se había escrito en la columna `code`, pero dejó la fila
// con las fechas del ciclo equivocado: dos ciclos distintos quedaban corriendo
// en la misma ventana y cuál ganaba dependía del orden de las filas.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { repairTermDates } from '../src/migrations.js';
import { resolveTerms } from '../src/shared/terms.ts';

function schema(db) {
  db.exec(`
    CREATE TABLE terms (
      code TEXT UNIQUE, label TEXT PRIMARY KEY, start_date TEXT, end_date TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE grades (id INTEGER PRIMARY KEY AUTOINCREMENT, term TEXT NOT NULL, grade TEXT);
  `);
}

function dates(db, label) {
  const row = db.prepare('SELECT start_date AS startDate, end_date AS endDate FROM terms WHERE label = ?').get(label);
  return { startDate: row.startDate, endDate: row.endDate };
}

// ── 1. La corrupción real de la base de Elias ────────────────────────────────
{
  const db = new DatabaseSync(':memory:');
  schema(db);
  // "Abril de 2026" con sus fechas verdaderas, y "Enero de 2026" con esas mismas
  // fechas copiadas encima por el bug. Los dos ciclos tienen notas propias: son
  // dos ciclos reales del histórico, no un duplicado.
  db.exec(`INSERT INTO terms (code, label, start_date, end_date) VALUES (NULL, 'Abril de 2026', '2026-04-29', '2026-08-04')`);
  db.exec(`INSERT INTO terms (code, label, start_date, end_date) VALUES (NULL, 'Enero de 2026', '2026-04-29', '2026-08-04')`);
  db.exec(`INSERT INTO terms (code, label, start_date, end_date) VALUES ('1930', 'Septiembre de 2026', '2026-09-01', '2026-12-07')`);
  db.exec(`INSERT INTO grades (term, grade) VALUES ('Enero de 2026', 'A')`);
  db.exec(`INSERT INTO grades (term, grade) VALUES ('Abril de 2026', 'B')`);

  repairTermDates(db);

  assert.deepEqual(dates(db, 'Enero de 2026'), { startDate: null, endDate: null }, 'las fechas prestadas de otro ciclo se borran');
  // La regresión que importa: "Abril de 2026" EMPIEZA el 29 de abril, o sea unos
  // días antes de la ventana implícita del ciclo (may–ago). Un criterio basado
  // en esa ventana habría borrado fechas reales del portal.
  assert.deepEqual(dates(db, 'Abril de 2026'), { startDate: '2026-04-29', endDate: '2026-08-04' }, 'un ciclo que arranca antes de su ventana implícita conserva sus fechas reales');
  assert.deepEqual(dates(db, 'Septiembre de 2026'), { startDate: '2026-09-01', endDate: '2026-12-07' });

  // No fusiona ni borra filas: los dos ciclos con notas propias siguen existiendo.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM terms').get().n, 3, 'ninguna fila se pierde');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM grades').get().n, 2, 'ninguna nota cambia de ciclo');

  // La consecuencia: ya no hay dos ciclos conteniendo el mismo día.
  const rows = db.prepare('SELECT code, label, start_date AS startDate, end_date AS endDate FROM terms').all();
  const { current } = resolveTerms(rows, new Date(2026, 5, 15)); // 15 de junio de 2026
  assert.equal(current?.label, 'Abril de 2026', 'el ciclo que corre en junio es Abril, y ahora sin empate');

  // Idempotencia: una segunda corrida no toca nada.
  const before = db.prepare('SELECT label, start_date, end_date FROM terms ORDER BY label').all();
  repairTermDates(db);
  assert.deepEqual(db.prepare('SELECT label, start_date, end_date FROM terms ORDER BY label').all(), before, 'una segunda corrida es un no-op');
  db.close();
}

// ── 2. Lo que no se puede juzgar, no se toca ─────────────────────────────────
{
  const db = new DatabaseSync(':memory:');
  schema(db);
  // Una etiqueta que no es de los tres ciclos de PUCMM: no se puede decir si sus
  // fechas son suyas, así que se dejan como están en vez de borrar un dato bueno.
  db.exec(`INSERT INTO terms (code, label, start_date, end_date) VALUES (NULL, 'Verano 2026', '2026-06-01', '2026-07-30')`);
  // Y una sin fechas: no hay nada que revisar.
  db.exec(`INSERT INTO terms (code, label) VALUES (NULL, 'Enero de 2024')`);

  repairTermDates(db);

  assert.deepEqual(dates(db, 'Verano 2026'), { startDate: '2026-06-01', endDate: '2026-07-30' }, 'una etiqueta que no se puede ubicar conserva sus fechas');
  assert.deepEqual(dates(db, 'Enero de 2024'), { startDate: null, endDate: null });
  db.close();
}

// ── 3. Una base sin tabla `terms` no es un error ─────────────────────────────
{
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE courses (id INTEGER PRIMARY KEY)');
  repairTermDates(db); // no lanza
  db.close();
}

console.log('✓ fechas de ciclo: se borran las prestadas de otro ciclo, se conservan las reales y no se pierde ninguna fila');
