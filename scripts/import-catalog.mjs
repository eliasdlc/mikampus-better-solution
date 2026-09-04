// Trae el catálogo de OTRA base de mikampus a la de esta instalación.
//
// Existe porque la app mudó su base al directorio de datos del sistema
// (~/.local/share/mikampus en Linux, ver src/paths.js) y quedó un catálogo real
// completo en la base vieja del checkout, que la app ya no abre. Volver a
// barrerlo cuesta horas de navegaciones contra el portal; copiarlo cuesta
// segundos, y el barrido fresco puede correr después sin que nadie espere.
//
// SOLO mueve catálogo: materias, subjects, secciones y el último cupo conocido
// de cada sección. Nada personal (notas, pénsum, inscripciones, carrito) cruza:
// eso es del portal y de la cuenta, no de un archivo suelto.
//
//   node scripts/import-catalog.mjs                     # desde data/mikampus.db
//   node scripts/import-catalog.mjs /ruta/otra.db
//   node scripts/import-catalog.mjs --term 1930         # solo un ciclo
//   node scripts/import-catalog.mjs --dry-run           # cuenta sin escribir

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataPaths, resourcePath } from '../src/paths.js';
import { db } from '../src/db.js';
import { campusFromSectionNumber } from '../src/shared/campus.ts';
import { saveSection } from '../src/peoplesoft/catalog.js';
import { saveCourseTitles, saveSubjects } from '../src/peoplesoft/browseCatalog.js';
import { scrapedSectionSchema } from '../src/shared/schemas.ts';
import { splitCourseCode } from '../src/shared/courseCode.ts';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const termIdx = args.indexOf('--term');
const onlyTerm = termIdx >= 0 ? args[termIdx + 1] : null;
const source = path.resolve(
  args.filter((a, i) => !a.startsWith('--') && i !== termIdx + 1)[0] ?? resourcePath('data', 'mikampus.db')
);

const target = dataPaths().db;

if (!fs.existsSync(source)) {
  console.error(`No existe la base de origen: ${source}`);
  process.exit(1);
}
// Misma ruta real (no solo misma cadena): importar una base sobre sí misma
// duplicaría cupos y no aportaría una sola fila nueva.
if (fs.realpathSync(source) === fs.realpathSync(target)) {
  console.error('El origen y el destino son la misma base. Nada que importar.');
  process.exit(1);
}

const src = new DatabaseSync(source, { readOnly: true });

console.log(`origen  ${source}`);
console.log(`destino ${target}`);
if (onlyTerm) console.log(`ciclo   ${onlyTerm}`);
console.log(dryRun ? 'modo    dry-run, no se escribe nada\n' : '');

// El último cupo observado de cada sección. El histórico completo no se copia:
// son observaciones repetidas del mismo estado (el class search solo publica un
// ícono, nunca números), y arrastrarlas no agrega información, solo filas. La
// que sí importa es la última, con su hora original.
const latestSeats = new Map();
const seatRows = src
  .prepare(
    `SELECT q.section_id, q.status, q.seats_open, q.seats_cap, q.wait_total, q.captured_at
     FROM seats_snapshot q
     ORDER BY q.section_id, q.captured_at, q.id`
  )
  .all();
for (const row of seatRows) latestSeats.set(row.section_id, row);

const sections = src
  .prepare(
    `SELECT s.id, s.term, s.class_nbr, s.section, s.component, s.instructor, s.meetings,
            c.code, c.subject, c.catalog_nbr, c.title, c.career, c.credits
     FROM sections s JOIN courses c ON c.id = s.course_id
     ${onlyTerm ? 'WHERE s.term = ?' : ''}
     ORDER BY c.code, s.class_nbr`
  )
  .all(...(onlyTerm ? [onlyTerm] : []));

const subjects = src.prepare('SELECT code, description FROM subjects ORDER BY code').all();

// Las materias van aparte de las secciones a propósito: de las 907 del origen,
// solo 237 tienen sección en algún ciclo. Las otras 670 son títulos del Browse
// Catalog, y son justo lo que hace que buscar "estructuras" encuentre algo. Un
// import que solo siguiera las secciones las tiraría.
//
// El título placeholder del origen es el propio código (ver resolveTitle en
// peoplesoft/catalog.js): esas filas no se copian, porque escribir "ICC-101"
// como título pisaría un título bueno del destino con basura.
const courses = src
  .prepare('SELECT code, subject, catalog_nbr, title FROM courses WHERE title IS NOT NULL AND title <> code ORDER BY code')
  .all()
  .map((c) => ({ subject: c.subject, catalogNbr: c.catalog_nbr, title: c.title }));

// Existe ya en el destino con este cupo observado a esta misma hora. saveSection
// inserta una observación nueva cada vez que se lo llama, así que sin esto una
// segunda corrida duplicaría los 1427 cupos.
const seatYaImportado = db.prepare(
  `SELECT 1 FROM seats_snapshot q JOIN sections s ON s.id = q.section_id
   WHERE s.term = ? AND s.class_nbr = ? AND q.captured_at = ?`
);

const counts = { subjects: 0, courses: 0, sections: 0, seats: 0, saltadas: 0, colapsados: seatRows.length - latestSeats.size };
const problemas = [];

// node:sqlite no tiene el helper de transacciones de better-sqlite3: el repo
// abre y cierra a mano en todos lados (ver src/plans.js, src/termEvents.js).
db.exec('BEGIN');
try {
  counts.subjects = saveSubjects(subjects.map((s) => ({ code: s.code, description: s.description })));
  counts.courses = saveCourseTitles(courses);

  for (const row of sections) {
    // El título placeholder de la base vieja es el propio código (ver
    // resolveTitle): mandarlo como título real pisaría un título bueno del
    // destino con basura. Se manda null y la capa de escritura decide.
    const title = row.title && row.title !== row.code ? row.title : null;
    const split = splitCourseCode(row.code);
    const observado = latestSeats.get(row.id);
    const seat =
      observado && !seatYaImportado.get(row.term, row.class_nbr, observado.captured_at) ? observado : null;

    const parsed = scrapedSectionSchema.safeParse({
      courseCode: row.code,
      subject: split?.subject ?? row.subject,
      catalogNbr: split?.catalogNbr ?? row.catalog_nbr,
      title,
      career: row.career,
      credits: row.credits,
      term: row.term,
      classNbr: row.class_nbr,
      section: row.section,
      component: row.component,
      instructor: row.instructor,
      meetings: row.meetings ? JSON.parse(row.meetings) : [],
      seats: seat
        ? {
            status: seat.status,
            open: seat.seats_open,
            capacity: seat.seats_cap,
            waitTotal: seat.wait_total,
            capturedAt: seat.captured_at,
          }
        : null,
      // La base de origen es anterior a la columna campus, así que el dato del
      // portal no existe ahí. Lo único disponible es la inferencia por número
      // de sección, y entra marcada como tal: el barrido campus por campus la
      // va a pisar con el dato real, que es exactamente la precedencia que
      // upsertSectionStmt ya implementa.
      campus: campusFromSectionNumber(row.section),
      campusSource: campusFromSectionNumber(row.section) ? 'seccion' : null,
    });

    if (!parsed.success) {
      counts.saltadas += 1;
      if (problemas.length < 5) problemas.push(`${row.code} ${row.class_nbr}: ${parsed.error.issues[0]?.message}`);
      continue;
    }

    saveSection(parsed.data);
    counts.sections += 1;
    if (parsed.data.seats) counts.seats += 1;
  }

  if (dryRun) throw new Error('dry-run');
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  if (err.message !== 'dry-run') throw err;
}

const after = db.prepare('SELECT (SELECT count(*) FROM courses) c, (SELECT count(*) FROM sections) s').get();
const conCampus = db.prepare('SELECT count(*) n FROM sections WHERE campus IS NOT NULL').get().n;

console.log(`subjects   ${counts.subjects}`);
console.log(`materias   ${counts.courses}  (con título real)`);
console.log(`secciones  ${counts.sections}${counts.saltadas ? `  (${counts.saltadas} saltadas)` : ''}`);
console.log(`cupos      ${counts.seats}  (${counts.colapsados} observaciones repetidas no se copiaron)`);
for (const p of problemas) console.log(`  saltada: ${p}`);
console.log(`\ndestino ahora: ${after.c} materias, ${after.s} secciones, ${conCampus} con campus`);
if (dryRun) console.log('\ndry-run: no se escribió nada.');
