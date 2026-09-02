// Las etapas del calendario académico de un ciclo. Lo que la tabla garantiza a
// nivel de disco: nace vacía, toda fecha declara quién la dijo, y una fila sin
// ninguna fecha no se puede escribir. Lo demás (parsear el calendario, resolver
// la fase) vive fuera y no puede saltarse estas reglas.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createTermEvents, repairTermIdentity } from '../src/migrations.js';

function insert(db, values) {
  const row = { user_id: 1, session: 'Regular Academic Session', precision: 'date', ...values };
  db.prepare(
    `INSERT INTO term_events (user_id, term_code, session, event, starts_on, ends_on, precision, source, source_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.user_id, row.term_code, row.session, row.event,
    row.starts_on ?? null, row.ends_on ?? null, row.precision, row.source, row.source_note ?? null
  );
}

// ── 1. Nace vacía, y una fecha real entra con su procedencia ─────────────────
{
  const db = new DatabaseSync(':memory:');
  createTermEvents(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM term_events').get().n, 0, 'la tabla nace sin una sola fecha sembrada');

  insert(db, { term_code: '1930', event: 'inscripcion-regular', starts_on: '2026-07-16', ends_on: '2026-09-03', source: 'portal', source_note: 'enrollment-dates' });
  insert(db, { term_code: '1930', event: 'modificacion-inscripcion', starts_on: '2026-09-04', ends_on: '2026-09-08', source: 'usuario' });
  // Media ventana conocida es un dato válido: no obliga a completar la otra.
  insert(db, { term_code: '1930', event: 'retiro-parcial', ends_on: '2026-10-15', source: 'usuario' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM term_events').get().n, 3);
  assert.equal(
    db.prepare("SELECT source FROM term_events WHERE event = 'inscripcion-regular'").get().source,
    'portal',
    'la fecha que vino del portal queda distinguible de la que escribió el estudiante'
  );

  // ── 2. Lo que el esquema NO deja escribir ─────────────────────────────────
  assert.throws(
    () => insert(db, { term_code: '1930', event: 'notas', starts_on: '2026-12-15', source: 'calendario' }),
    /CHECK|constraint/i,
    'una procedencia que no es ni el portal ni el estudiante no se guarda'
  );
  assert.throws(
    () => insert(db, { term_code: '1930', event: 'notas', starts_on: '2026-12-15', precision: 'aprox', source: 'usuario' }),
    /CHECK|constraint/i,
    'una precisión inventada no se guarda'
  );
  assert.throws(
    () => insert(db, { term_code: '1930', event: 'notas', source: 'usuario' }),
    /CHECK|constraint/i,
    'un evento sin ninguna fecha es una fila vacía, no un dato: se representa con la ausencia de fila'
  );
  assert.throws(
    () => insert(db, { term_code: '1930', event: 'inscripcion-regular', starts_on: '2026-07-16', source: 'usuario' }),
    /UNIQUE|constraint/i,
    'un mismo evento del mismo ciclo y sesión no se duplica'
  );

  // Idempotencia: volver a correr la migración no borra ni recrea nada.
  createTermEvents(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM term_events').get().n, 3, 'una segunda corrida conserva las filas');
  db.close();
}

// ── 3. term_code sigue la identidad del ciclo, como el resto de las tablas ───
{
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE terms (
      code TEXT UNIQUE, label TEXT PRIMARY KEY, start_date TEXT, end_date TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  createTermEvents(db);
  // Dos filas del mismo ciclo, una con STRM y otra solo con la etiqueta, y el
  // calendario colgando de la etiqueta. Al fusionarse, las fechas del ciclo no
  // se pueden quedar huérfanas bajo un identificador que ya no existe.
  db.exec(`INSERT INTO terms (code, label, start_date) VALUES ('1930', 'Septiembre de 2026', '2026-09-01')`);
  db.exec(`INSERT INTO terms (code, label) VALUES (NULL, 'SEPTIEMBRE DE 2026')`);
  insert(db, { term_code: 'SEPTIEMBRE DE 2026', event: 'notas', starts_on: '2026-12-15', source: 'usuario' });

  repairTermIdentity(db);

  assert.equal(
    db.prepare('SELECT term_code AS t FROM term_events').get().t,
    '1930',
    'el calendario se reapunta al identificador canónico del ciclo'
  );
  db.close();
}

// ── 4. Una base sin `terms` no rompe la reparación aunque term_events falte ──
{
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE terms (code TEXT UNIQUE, label TEXT PRIMARY KEY, start_date TEXT, end_date TEXT, updated_at TEXT)`);
  db.exec(`INSERT INTO terms (code, label) VALUES ('1930', 'Septiembre de 2026')`);
  db.exec(`INSERT INTO terms (code, label) VALUES (NULL, 'SEPTIEMBRE DE 2026')`);
  repairTermIdentity(db); // term_events todavía no existe: no lanza
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM terms').get().n, 1);
  db.close();
}

console.log('✓ eventos de ciclo: tabla vacía, procedencia obligatoria, sin filas sin fecha e identidad de ciclo compartida');
