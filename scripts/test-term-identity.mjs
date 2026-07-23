// Migración de identidad de ciclo (§P0.3): repara la corrupción "etiqueta escrita
// como STRM", fusiona filas duplicadas del mismo ciclo reasignando sus hijos, es
// idempotente y aborta —sin mezclar datos— ante dos STRM en conflicto.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { repairTermIdentity } from '../src/migrations.js';

// Un esquema mínimo con la tabla de identidad y las columnas que guardan un
// identificador de ciclo. No es el esquema completo de la app: alcanza para
// ejercer la reasignación y la fusión sin arrastrar db.js.
function schema(db) {
  db.exec(`
    CREATE TABLE terms (
      code TEXT UNIQUE, label TEXT PRIMARY KEY, start_date TEXT, end_date TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE enrollments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL DEFAULT 1,
      term TEXT NOT NULL, section_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'enrolled',
      UNIQUE (user_id, term, section_id)
    );
    CREATE TABLE sections (id INTEGER PRIMARY KEY AUTOINCREMENT, term TEXT NOT NULL, class_nbr TEXT NOT NULL, UNIQUE (term, class_nbr));
    CREATE TABLE plans (id INTEGER PRIMARY KEY AUTOINCREMENT, term TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE goals (id INTEGER PRIMARY KEY AUTOINCREMENT, deadline_term TEXT);
    CREATE TABLE enrollment_windows (term_code TEXT NOT NULL, session TEXT NOT NULL DEFAULT 'x', starts_at TEXT NOT NULL DEFAULT '', ends_at TEXT NOT NULL DEFAULT '', user_id INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (user_id, term_code, session));
    CREATE TABLE sync_log (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, term TEXT, status TEXT NOT NULL DEFAULT 'ok');
    CREATE TABLE grades (id INTEGER PRIMARY KEY AUTOINCREMENT, term TEXT NOT NULL, grade TEXT);
    CREATE TABLE pensum (user_id INTEGER NOT NULL DEFAULT 1, code TEXT NOT NULL, taken_term TEXT, PRIMARY KEY (user_id, code));
    CREATE TABLE progress_items (id INTEGER PRIMARY KEY AUTOINCREMENT, term TEXT);
  `);
}

// ── 1. Sanear "etiqueta como código" + fusión de duplicados sin perder datos ──
{
  const db = new DatabaseSync(':memory:');
  schema(db);
  // La corrupción del viejo reconcileTerms: la etiqueta se escribió en `code`.
  db.exec(`INSERT INTO terms (code, label, start_date) VALUES ('Abril de 2026', 'Abril de 2026', '2026-05-05')`);
  // Un ciclo legítimo con STRM real, y una fila DUPLICADA del mismo ciclo (misma
  // cycleKey por variante de mayúsculas) sin código, con datos colgando de ella.
  db.exec(`INSERT INTO terms (code, label, start_date) VALUES ('1930', 'Septiembre de 2026', '2026-09-01')`);
  db.exec(`INSERT INTO terms (code, label) VALUES (NULL, 'SEPTIEMBRE DE 2026')`);
  db.exec(`INSERT INTO grades (term, grade) VALUES ('SEPTIEMBRE DE 2026', 'A')`);
  db.exec(`INSERT INTO plans (term, name) VALUES ('SEPTIEMBRE DE 2026', 'plan viejo')`);
  db.exec(`INSERT INTO enrollments (term, section_id) VALUES ('Abril de 2026', 10)`);

  repairTermIdentity(db);

  // El label-as-code se saneó: el STRM real sigue desconocido.
  const abril = db.prepare("SELECT code FROM terms WHERE label = 'Abril de 2026'").get();
  assert.equal(abril.code, null, 'una etiqueta escrita como código vuelve a NULL');

  // Los duplicados de Septiembre se fusionaron en una sola fila, la que tiene STRM.
  const sept = db.prepare("SELECT COUNT(*) AS n FROM terms WHERE label IN ('Septiembre de 2026','SEPTIEMBRE DE 2026')").all();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM terms").get().n, 2, 'quedan dos ciclos, no tres');
  assert.ok(db.prepare("SELECT 1 FROM terms WHERE label = 'Septiembre de 2026' AND code = '1930'").get(), 'la fila canónica conserva el STRM');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM terms WHERE label = 'SEPTIEMBRE DE 2026'").get().n, 0, 'el duplicado se borró');
  assert.equal(sept.length >= 0, true);

  // Los hijos de la etiqueta descartada se reapuntaron sin perderse.
  assert.equal(db.prepare("SELECT term FROM grades").get().term, 'Septiembre de 2026', 'las notas se reapuntan a la etiqueta canónica');
  assert.equal(db.prepare("SELECT term FROM plans").get().term, '1930', 'los planes se reapuntan al identificador resuelto (STRM)');

  // Idempotencia: correr de nuevo no cambia nada.
  const before = db.prepare('SELECT code, label FROM terms ORDER BY label').all();
  repairTermIdentity(db);
  const after = db.prepare('SELECT code, label FROM terms ORDER BY label').all();
  assert.deepEqual(after, before, 'una segunda corrida es un no-op');
  db.close();
}

// ── 2. Conflicto ambiguo: dos STRM para el mismo ciclo → aborta sin mezclar ──
{
  const db = new DatabaseSync(':memory:');
  schema(db);
  db.exec(`INSERT INTO terms (code, label) VALUES ('1930', 'Septiembre de 2026')`);
  db.exec(`INSERT INTO terms (code, label) VALUES ('1931', 'septiembre de 2026 ')`);
  assert.throws(
    () => repairTermIdentity(db),
    /conflicto|conflict/i,
    'dos STRM distintos para un ciclo detienen la migración'
  );
  // No mezcló: las dos filas siguen ahí para que el usuario o el backup decidan.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM terms').get().n, 2, 'ninguna fila se borró ante el conflicto');
  db.close();
}

// ── 3. Una base sin tabla `terms` no es un error: no hay nada que reparar ─────
{
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE courses (id INTEGER PRIMARY KEY)');
  repairTermIdentity(db); // no lanza
  db.close();
}

console.log('✓ identidad de ciclo: saneo label-as-code, fusión de duplicados, idempotencia y aborto ante conflicto');
