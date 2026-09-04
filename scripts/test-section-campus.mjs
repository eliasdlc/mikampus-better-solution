// Campus de una sección: vocabulario canónico, atribución con procedencia y un
// backfill que nunca inventa. Lo que se prueba es sobre todo lo que NO hace:
// no traduce por parecido, no pisa un dato del portal con una inferencia y no
// le pone campus a una sección que no lo puede saber.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CAMPUS_CODES, CAMPUS_LABELS, campusFromLabel } from '../src/shared/campus.ts';
import { addSectionCampus, backfillSectionCampus } from '../src/migrations.js';

// Un esquema mínimo con lo que toca la migración. No es el de la app: alcanza
// para ejercer el ALTER y el backfill sin arrastrar db.js.
function schema(db) {
  db.exec(`
    CREATE TABLE courses (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL);
    CREATE TABLE sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL REFERENCES courses(id),
      term TEXT NOT NULL, class_nbr TEXT NOT NULL, section TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (term, class_nbr)
    );
    CREATE TABLE cart_rows (
      user_id INTEGER NOT NULL DEFAULT 1, idx INTEGER NOT NULL,
      class_nbr TEXT, section TEXT, campus TEXT,
      PRIMARY KEY (user_id, idx)
    );
    CREATE TABLE profile (user_id INTEGER PRIMARY KEY, career TEXT);
    INSERT INTO courses (id, code) VALUES (1, 'ICC-233');
  `);
}

function addSection(db, classNbr, section, term = '1930') {
  db.prepare('INSERT INTO sections (course_id, term, class_nbr, section) VALUES (1, ?, ?, ?)').run(term, classNbr, section);
}

function campusOf(db, classNbr) {
  // node:sqlite devuelve filas sin prototipo; se copian para poder compararlas.
  return { ...db.prepare('SELECT campus, campus_source AS source FROM sections WHERE class_nbr = ? LIMIT 1').get(classNbr) };
}

// ── 1. El vocabulario: exacto, nunca por parecido ────────────────────────────
{
  assert.deepEqual([...CAMPUS_CODES], ['CSTI', 'CSTA', 'CVIR']);
  assert.equal(campusFromLabel(CAMPUS_LABELS.CSTI), 'CSTI');
  assert.equal(campusFromLabel('Campus Santo Domingo'), 'CSTA');
  // Lo que importa es el negativo: sin fuzzy, sin normalización, sin adivinar.
  assert.equal(campusFromLabel('campus santiago'), null, 'no compara sin distinguir mayúsculas');
  assert.equal(campusFromLabel('Santiago'), null, 'no reconoce un fragmento de la etiqueta');
  assert.equal(campusFromLabel(' Campus Santiago '), null, 'no recorta espacios por su cuenta');
  assert.equal(campusFromLabel(null), null);
}

// ── 2. Backfill: portal primero, inferencia después, NULL cuando no se sabe ──
{
  const db = new DatabaseSync(':memory:');
  schema(db);
  // La forma real de la base: secciones 1xx/17x y 2xx/27x, más las que ninguna
  // evidencia atribuye (0xx, 888 y una sin número de sección).
  addSection(db, '5227', '101');
  addSection(db, '5228', '171');
  addSection(db, '6001', '201');
  addSection(db, '6002', '271');
  addSection(db, '7001', '030');
  addSection(db, '7002', '888');
  addSection(db, '7003', null);
  // El carrito es la única pantalla que dice el campus con todas las letras.
  db.prepare("INSERT INTO cart_rows (idx, class_nbr, section, campus) VALUES (1, '5227', '101', 'Campus Santiago')").run();
  // Una etiqueta que el portal ya no usa: se ignora, no se traduce a la fuerza.
  db.prepare("INSERT INTO cart_rows (idx, class_nbr, section, campus) VALUES (2, '6001', '201', 'Recinto Santo Domingo')").run();

  addSectionCampus(db);

  assert.deepEqual(campusOf(db, '5227'), { campus: 'CSTI', source: 'portal' }, 'el carrito manda: campus dicho por el portal');
  assert.deepEqual(campusOf(db, '5228'), { campus: 'CSTI', source: 'seccion' }, '1xx se infiere a Santiago, marcado como inferencia');
  assert.deepEqual(campusOf(db, '6001'), { campus: 'CSTA', source: 'seccion' }, 'una etiqueta desconocida del carrito no atribuye nada');
  assert.deepEqual(campusOf(db, '6002'), { campus: 'CSTA', source: 'seccion' }, '2xx se infiere a Santo Domingo');
  for (const classNbr of ['7001', '7002', '7003']) {
    assert.deepEqual(campusOf(db, classNbr), { campus: null, source: null }, `${classNbr} queda sin campus en vez de recibir uno inventado`);
  }

  // El perfil gana su campus, vacío: se elige, no se adivina.
  db.prepare('INSERT INTO profile (user_id, career) VALUES (1, ?)').run('ICC');
  assert.equal(db.prepare('SELECT home_campus AS c FROM profile WHERE user_id = 1').get().c, null);

  // Idempotencia: un segundo backfill no cambia ni un valor ni un updated_at.
  const before = db.prepare('SELECT class_nbr, campus, campus_source, updated_at FROM sections ORDER BY class_nbr').all();
  backfillSectionCampus(db);
  const after = db.prepare('SELECT class_nbr, campus, campus_source, updated_at FROM sections ORDER BY class_nbr').all();
  assert.deepEqual(after, before, 'una segunda corrida es un no-op');

  // Y correr la migración entera de nuevo tampoco duplica columnas ni rompe.
  addSectionCampus(db);
  assert.equal(db.prepare('PRAGMA table_info(sections)').all().filter((c) => c.name === 'campus').length, 1);
  db.close();
}

// ── 3. Una inferencia nunca pisa un dato del portal ──────────────────────────
{
  const db = new DatabaseSync(':memory:');
  schema(db);
  // Una sección 1xx que el portal ya atribuyó a Santo Domingo: el número dice
  // otra cosa, pero el portal es la autoridad y la inferencia se calla.
  addSection(db, '5227', '101');
  addSectionCampus(db);
  db.prepare("UPDATE sections SET campus = 'CSTA', campus_source = 'portal' WHERE class_nbr = '5227'").run();
  backfillSectionCampus(db);
  assert.deepEqual(campusOf(db, '5227'), { campus: 'CSTA', source: 'portal' }, 'la inferencia no toca una fila del portal');
  db.close();
}

// ── 4. El carrito no dice de qué ciclo es: un class_nbr ambiguo no atribuye ──
{
  const db = new DatabaseSync(':memory:');
  schema(db);
  // El mismo número de clase en dos ciclos. El carrito no guarda el término,
  // así que no hay forma de saber a cuál de las dos se refiere.
  addSection(db, '5227', '101', '1930');
  addSection(db, '5227', '201', '1920');
  db.prepare("INSERT INTO cart_rows (idx, class_nbr, section, campus) VALUES (1, '5227', '101', 'Campus Santiago')").run();

  addSectionCampus(db);

  const rows = db.prepare('SELECT term, campus, campus_source FROM sections ORDER BY term').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { term: '1920', campus: 'CSTA', campus_source: 'seccion' },
    { term: '1930', campus: 'CSTI', campus_source: 'seccion' },
  ], 'con el class_nbr repetido en dos ciclos nadie recibe el dato del portal');
  db.close();
}

// ── 5. Una base sin `sections` no es un error ────────────────────────────────
{
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE courses (id INTEGER PRIMARY KEY)');
  addSectionCampus(db); // no lanza
  db.close();
}

console.log('✓ campus de sección: vocabulario exacto, portal sobre inferencia, NULL explícito e idempotencia');
