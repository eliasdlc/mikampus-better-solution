// Las dos clases por materia, que es una decisión de la universidad y un
// problema del estudiante.
//
// Lo que se verifica: que el par se reconozca solo, que mikampus NO decida
// cuando la evidencia no alcanza, que esconder sea local y reversible, que una
// copia de este ciclo nunca se mezcle con una materia de un ciclo pasado, y que
// el ciclo salga del código del aula y no de la fecha que publica Moodle.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-materias-'));
process.env.MIKAMPUS_DATA_DIR = dir;
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');

const { db } = await import('../src/db.js');
const { saveCourses } = await import('../src/moodle/courses.js');
const materias = await import('../src/moodle/materias.js');

const USER = 1;
const S = Math.floor(Date.now() / 1000);
const DIA = 86_400;

const curso = (id, shortname, nombre, { hidden = false, startdate = S - 30 * DIA } = {}) => ({
  id,
  shortname,
  fullname: `${shortname} - ${nombre}`,
  visible: 1,
  hidden,
  startdate,
  timemodified: S,
});

// Contenido a mano: es la evidencia con la que se decide cuál usa el profesor.
const conModulos = (courseId, cuantos) => {
  for (let i = 0; i < cuantos; i += 1) {
    db.prepare(
      `INSERT INTO pva_course_section (section_id, user_id, course_id, section_number, name, sort_index)
       VALUES (?, ?, ?, 0, 'General', 0) ON CONFLICT DO NOTHING`
    ).run(courseId, USER, courseId);
    db.prepare(
      `INSERT INTO pva_module (cmid, user_id, course_id, section_id, sort_index, modname, instance, context_id, name)
       VALUES (?, ?, ?, ?, ?, 'resource', ?, 1, 'Material')`
    ).run(courseId * 100 + i, USER, courseId, courseId, i, courseId * 100 + i);
  }
};

try {
  saveCourses(
    USER,
    [
      curso(1, 'CSTI-1930-5227', 'Inteligencia de Negocios'),
      curso(2, 'CSTI-1930-5228', 'Inteligencia de Negocios'),
      curso(3, 'CSTI-1910-5488', 'Programación Web'),
      curso(4, 'CSTI-1900-4779', 'Sistemas Operativos', { hidden: true, startdate: S - 300 * DIA }),
    ],
    { now: Date.now() }
  );
  conModulos(1, 21);

  // ── El par se reconoce solo ──
  {
    assert.equal(materias.visibleCourses(USER).length, 2, 'ni la escondida en la PVA ni las de ciclos pasados cuentan');
    const pares = materias.coursePairs(USER);
    assert.equal(pares.length, 1, 'dos clases con el mismo nombre son un par');
    assert.equal(pares[0].name, 'Inteligencia de Negocios', 'y el par se llama como la materia, no como el código');
    assert.deepEqual(pares[0].suggested, [2], 'la vacía es la que sobra, y se señala por su contenido');
    assert.equal(pares[0].courses[0].courseId, 1, 'la que tiene contenido va primero');
    assert.equal(pares[0].courses[0].modules, 21, 'con la evidencia a la vista, no con una conclusión');
  }

  // ── Con las dos iguales, mikampus no adivina ──
  {
    conModulos(2, 18);
    assert.deepEqual(materias.coursePairs(USER)[0].suggested, [], 'dos con contenido: no se señala ninguna');
    db.prepare('DELETE FROM pva_module WHERE course_id = 2').run();
    assert.deepEqual(materias.coursePairs(USER)[0].suggested, [2], 'y vuelve a señalarse cuando la evidencia vuelve');
  }

  // ── Esconder es local y se deshace ──
  {
    materias.hideCourse(USER, 2, { key: materias.pairKey('CSTI-1930-5228 - Inteligencia de Negocios', 'CSTI-1930-5228') });
    assert.deepEqual(
      materias.visibleCourses(USER).map((course) => course.courseId).sort(),
      [1],
      'la copia sale de la lista'
    );
    assert.deepEqual(materias.coursePairs(USER), [], 'y el par deja de proponerse');
    assert.equal(
      db.prepare('SELECT hidden FROM pva_course WHERE course_id = 2').get().hidden,
      0,
      'pero la PVA no se toca: allá sigue visible'
    );

    const cajon = materias.archivedCourses(USER);
    assert.deepEqual(
      cajon.copies.map((course) => course.courseId),
      [2],
      'la copia va al grupo de las copias, porque su nombre sigue vivo en el ciclo'
    );
    assert.equal(cajon.copies[0].hiddenLocal, true);
    assert.equal(cajon.copies[0].hiddenRemote, false, 'y se dice quién la escondió: deshacerla acá es posible');

    materias.showCourse(USER, 2);
    assert.equal(materias.visibleCourses(USER).length, 2, 'mostrar la devuelve');
    assert.deepEqual(materias.coursePairs(USER), [], 'el par ya se decidió una vez y no vuelve a molestar');
  }

  // ── "Dejar las dos" ──
  {
    db.prepare('DELETE FROM pva_course_pref WHERE user_id = ?').run(USER);
    const key = materias.pairKey('CSTI-1930-5227 - Inteligencia de Negocios', 'CSTI-1930-5227');
    materias.keepPair(USER, key, [1, 2]);
    assert.equal(materias.visibleCourses(USER).length, 2, 'las dos siguen en la lista');
    assert.deepEqual(materias.coursePairs(USER), [], 'y el par no se vuelve a proponer');
  }

  // ── Una copia no es un ciclo pasado ──
  {
    const cajon = materias.archivedCourses(USER);
    assert.deepEqual(
      cajon.previous.map((course) => course.shortname),
      ['CSTI-1910-5488', 'CSTI-1900-4779'],
      'los ciclos viejos van al otro grupo, los haya escondido la PVA o nadie'
    );
    assert.match(cajon.previous[0].cycle, /de \d{4}$/, 'con el mes y el año que dio la PVA, sin inventar el nombre del cuatrimestre');
    assert.equal(cajon.previous[0].hiddenRemote, false, 'a la del ciclo anterior no la escondió nadie: la delata su código');
    assert.equal(cajon.previous[1].hiddenRemote, true, 'y a la más vieja sí la escondió la plataforma');
  }

  // ── El ciclo lo dice el código, no la fecha de Moodle ──
  {
    // Las tres visibles empezaron el mismo día para Moodle. Lo único que separa
    // la de este ciclo de la del anterior es el STRM: CSTI-1930 contra CSTI-1910.
    assert.deepEqual(
      materias.visibleCourses(USER).map((course) => course.shortname),
      ['CSTI-1930-5227', 'CSTI-1930-5228'],
      'solo el ciclo más nuevo que trae la matrícula, no los cuatro'
    );

    // Un código con otra forma no se puede ubicar en el tiempo, así que se
    // muestra igual: esconderlo dejaría fuera una materia que sí se está cursando.
    saveCourses(
      USER,
      [
        curso(1, 'CSTI-1930-5227', 'Inteligencia de Negocios'),
        curso(2, 'CSTI-1930-5228', 'Inteligencia de Negocios'),
        curso(3, 'CSTI-1910-5488', 'Programación Web'),
        curso(4, 'CSTI-1900-4779', 'Sistemas Operativos', { hidden: true, startdate: S - 300 * DIA }),
        curso(5, 'MAT-101-01', 'Cálculo'),
      ],
      { now: Date.now() }
    );
    assert.ok(
      materias.visibleCourses(USER).some((course) => course.shortname === 'MAT-101-01'),
      'sin ciclo legible la materia se muestra igual'
    );

    // Con el ciclo en curso conocido manda el modelo de tiempo y no el código más
    // alto: la PVA publica las aulas del ciclo que viene antes de que empiece.
    const dia = (dias) => new Date(Date.now() + dias * DIA * 1000).toISOString().slice(0, 10);
    db.prepare(
      `INSERT INTO terms (code, label, start_date, end_date, updated_at)
       VALUES ('1910', 'Ciclo de prueba', ?, ?, datetime('now'))`
    ).run(dia(-10), dia(10));
    assert.deepEqual(
      materias.visibleCourses(USER).map((course) => course.shortname),
      ['CSTI-1910-5488', 'MAT-101-01'],
      'el ciclo que corre hoy manda sobre el código más alto de la matrícula'
    );
  }

  assert.equal(materias.cycleLabel(null), 'sin fecha de inicio', 'sin fecha se dice, no se rellena');
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ materias: el par se reconoce solo, mikampus no adivina cuando las dos tienen contenido, esconder es local y reversible, y una copia no se mezcla con un ciclo pasado');
