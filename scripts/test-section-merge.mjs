// Merge por campo y procedencia de secciones (P4).
//
// El bug que esto cierra: View My Classes trae tu aula y tu horario pero no
// publica el profesor —manda null— y el upsert lo escribía igual. Resultado:
// cada sync de horario borraba el profesor que Class Search había enriquecido,
// y volvía a aparecer recién en el próximo barrido de catálogo.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-merge-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.MIKAMPUS_SILENT = '1';
process.env.MIKAMPUS_DATA_DIR = dir;

const { mergeSection, meetingRichness } = await import('../src/shared/sectionMerge.ts');
const { saveSection } = await import('../src/peoplesoft/catalog.js');
const { db } = await import('../src/db.js');

const clase = (room, start = '08:00', end = '09:30') => [{ days: ['Lu', 'Mi'], start, end, room }];

try {
  // ── La regla pura: lo vacío no pisa lo lleno ─────────────────────────────
  const conProfesor = mergeSection(
    null,
    { section: '01', component: 'LEC', instructor: 'Ana Pérez', meetings: clase('A-201') },
    'class-search'
  ).fields;
  assert.equal(conProfesor.instructor, 'Ana Pérez');
  assert.equal(conProfesor.instructorSource, 'class-search', 'se recuerda de dónde salió');

  // El caso del bug: llega View My Classes sin profesor.
  const trasHorario = mergeSection(
    conProfesor,
    { section: '01', component: 'LEC', instructor: null, meetings: clase('A-201') },
    'my-classes'
  ).fields;
  assert.equal(trasHorario.instructor, 'Ana Pérez', 'un sync de horario NO borra el profesor enriquecido');
  assert.equal(trasHorario.instructorSource, 'class-search', 'y sigue sabiendo de dónde vino');

  // Una cadena vacía o un espacio son lo mismo que null.
  for (const vacio of ['', '   ']) {
    assert.equal(
      mergeSection(conProfesor, { section: null, component: null, instructor: vacio, meetings: [] }, 'my-classes').fields
        .instructor,
      'Ana Pérez',
      `"${vacio}" no pisa un profesor real`
    );
  }

  // Un placeholder del portal tampoco es un dato.
  assert.equal(
    mergeSection(conProfesor, { section: null, component: null, instructor: 'TBA', meetings: [] }, 'class-search').fields
      .instructor,
    'Ana Pérez',
    'TBA no reemplaza a un profesor con nombre'
  );

  // ── Aula: TBA no borra un aula real, y un aula real sí llena un TBA ──────
  const sinAula = mergeSection(
    null,
    { section: '01', component: 'LEC', instructor: null, meetings: clase('TBA') },
    'class-search'
  ).fields;
  const conAula = mergeSection(
    sinAula,
    { section: '01', component: 'LEC', instructor: null, meetings: clase('A-201') },
    'my-classes'
  ).fields;
  assert.equal(conAula.meetings[0].room, 'A-201', 'un aula real llena un TBA');

  const vueltaATba = mergeSection(
    conAula,
    { section: '01', component: 'LEC', instructor: null, meetings: clase('TBA') },
    'class-search'
  ).fields;
  assert.equal(vueltaATba.meetings[0].room, 'A-201', 'el catálogo con TBA no borra el aula de tu horario');

  // Un horario vacío no borra el que hay.
  assert.equal(
    mergeSection(conAula, { section: null, component: null, instructor: null, meetings: [] }, 'class-search').fields
      .meetings.length,
    1,
    'una lista vacía de encuentros no vacía la sección'
  );

  // La riqueza es lo que decide, y el aula pesa más que cualquier otro campo.
  assert.ok(meetingRichness(clase('A-201')) > meetingRichness(clase(null)), 'con aula vale más que sin aula');
  assert.equal(meetingRichness([]), 0);

  // ── Discrepancia entre fuentes: se conserva la autoritativa y se anota ───
  const otroProfesor = mergeSection(
    conProfesor,
    { section: '01', component: 'LEC', instructor: 'Luis Gómez', meetings: [] },
    'my-classes'
  );
  assert.equal(otroProfesor.fields.instructor, 'Ana Pérez', 'Class Search manda sobre el profesor');
  assert.equal(otroProfesor.conflicts.length, 1, 'la discrepancia queda registrada, no se resuelve callada');
  assert.equal(otroProfesor.conflicts[0].field, 'instructor');
  assert.equal(otroProfesor.conflicts[0].rejected, 'Luis Gómez');

  // Class Search corrigiendo a Class Search sí actualiza (cambió el profesor).
  const corregido = mergeSection(
    conProfesor,
    { section: '01', component: 'LEC', instructor: 'Luis Gómez', meetings: [] },
    'class-search'
  ).fields;
  assert.equal(corregido.instructor, 'Luis Gómez', 'la misma fuente puede corregirse a sí misma');

  // ── Contra la base: dos grupos parecidos no se intercambian nada ─────────
  const base = {
    courseCode: 'ICC-321',
    subject: 'ICC',
    catalogNbr: '321',
    title: 'Estructuras de Datos',
    credits: 4,
    term: '2245',
    career: 'GRDO',
  };

  saveSection(
    { ...base, classNbr: '4567', section: '01', component: 'LEC', instructor: 'Ana Pérez', meetings: clase('A-201') },
    { source: 'class-search' }
  );
  saveSection(
    { ...base, classNbr: '4568', section: '02', component: 'LEC', instructor: 'Luis Gómez', meetings: clase('B-105', '10:00', '11:30') },
    { source: 'class-search' }
  );

  const leer = (classNbr) =>
    db.prepare('SELECT instructor, meetings, instructor_source FROM sections WHERE term = ? AND class_nbr = ?').get('2245', classNbr);

  assert.equal(leer('4567').instructor, 'Ana Pérez');
  assert.equal(leer('4568').instructor, 'Luis Gómez');

  // Ahora llega el sync de horario de la sección 01, sin profesor, como hace
  // View My Classes de verdad.
  saveSection(
    { ...base, classNbr: '4567', section: '01', component: 'LEC', instructor: null, meetings: clase('A-201') },
    { source: 'my-classes' }
  );

  assert.equal(leer('4567').instructor, 'Ana Pérez', 'el sync de horario no borró el profesor');
  assert.equal(leer('4568').instructor, 'Luis Gómez', 'y no tocó el otro grupo');
  assert.equal(JSON.parse(leer('4568').meetings)[0].room, 'B-105', 'los grupos no intercambian aula');

  // La correlación es por term + class_nbr: el mismo NRC en otro ciclo es otra
  // sección, no la misma.
  saveSection(
    { ...base, term: '2250', classNbr: '4567', section: '01', component: 'LEC', instructor: 'Otra Persona', meetings: clase('C-300') },
    { source: 'class-search' }
  );
  assert.equal(leer('4567').instructor, 'Ana Pérez', 'el mismo NRC en otro ciclo no pisa este');
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM sections WHERE class_nbr = '4567'").get().n,
    2,
    'son dos secciones distintas, una por ciclo'
  );

  console.log('✓ merge de secciones: el sync de horario ya no borra el profesor, y dos grupos parecidos no se mezclan');
} finally {
  await rm(dir, { recursive: true, force: true });
}
