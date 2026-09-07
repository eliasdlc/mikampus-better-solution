// Lo que la pantalla Aula recibe del agente. Sin red.
//
// Este es el punto donde cinco dominios normalizados se convierten en dos
// pantallas, y donde una ausencia se puede volver una mentira sin que nadie lo
// note: un libro cerrado que se lee como cero, un "no se consultó" que se lee
// como "sin entregar", un curso sin contenido bajado que se lee como vacío.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-aula-'));
process.env.MIKAMPUS_DATA_DIR = dir;
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');

const { db } = await import('../src/db.js');
const { saveIdentity } = await import('../src/moodle/identity.js');
const { saveCourses, saveCourseContents } = await import('../src/moodle/courses.js');
const { saveAssignments, saveSubmissionStatus } = await import('../src/moodle/assignments.js');
const { saveGradeItems, saveCourseTotals, markGradebookAccess } = await import('../src/moodle/grades.js');
const { saveCalendarEvents } = await import('../src/moodle/calendar.js');
const { aulaOverview, aulaCourse } = await import('../src/moodle/aula.js');

const fixture = async (name) => JSON.parse(await readFile(`fixtures/${name}`, 'utf8'));
const USER = 1;
const NOW = 1_771_900_000_000; // entre la apertura y la entrega del fixture

try {
  saveIdentity(USER, await fixture('pva-site-info.json'));
  saveCourses(USER, await fixture('pva-courses.json'), { now: NOW });
  saveCourseContents(USER, 800101, await fixture('pva-contents.json'), { now: NOW });
  saveAssignments(USER, await fixture('pva-assignments.json'), { now: NOW });
  saveGradeItems(USER, 800101, await fixture('pva-grade-items.json'), { now: NOW });
  saveCourseTotals(USER, await fixture('pva-grade-overview.json'), { now: NOW });
  saveCalendarEvents(USER, await fixture('pva-calendar-events.json'), { now: NOW });

  // ── La raíz: materias y qué está pasando ──
  {
    const data = aulaOverview(USER, { now: NOW, days: 30 });
    assert.equal(data.courses.length, 1, 'solo las del ciclo: la oculta no es del ciclo');
    const materia = data.courses[0];
    assert.equal(materia.shortname, 'MAT-101-01');
    assert.equal(materia.grade.total, '85.50');
    assert.equal(materia.grade.hidden, false);
    assert.deepEqual(
      { calificados: materia.grade.gradedItems, calificables: materia.grade.gradableItems },
      { calificados: 0, calificables: 2 },
      'dos items califican y ninguno tiene nota todavía'
    );

    // Lo próximo es la entrega SIN hacer más cercana. Una ya entregada no es
    // lo próximo que hay que hacer.
    assert.equal(materia.next.assignmentId, 900001, 'la más cercana sin entregar');
    assert.equal(materia.pending, 2);

    saveSubmissionStatus(USER, 900001, await fixture('pva-submission-graded.json'), { now: NOW });
    const despues = aulaOverview(USER, { now: NOW, days: 30 });
    assert.equal(despues.courses[0].next.assignmentId, 900006, 'entregada la primera, lo próximo es la otra');
    assert.equal(despues.courses[0].pending, 1);

    // El feed: primero lo que hay que hacer, después lo que pasó.
    const items = despues.items;
    assert.ok(items.length >= 2);
    assert.equal(items[0].kind, 'vence');
    assert.notEqual(items[0].submitted, true, 'lo pendiente encabeza el feed, aunque venza en el futuro');
    assert.equal(items[0].submitted, null, 'y una entrega sin consultar cuenta como pendiente: null no es false');
    assert.ok(items.every((item) => item.courseShortname), 'cada fila dice de qué materia es');
  }

  // ── Una materia: estado arriba, unidades abajo ──
  {
    const data = aulaCourse(USER, 800101, { now: NOW });
    assert.equal(data.course.shortname, 'MAT-101-01');
    assert.equal(data.contentsSynced, true);
    assert.equal(data.sections.length, 2);
    assert.equal(data.sections[1].modules.length, 0, 'la unidad que el profesor creó y dejó vacía existe igual');

    const modulos = data.sections[0].modules;
    assert.deepEqual(
      modulos.map((module) => module.modname),
      ['assign', 'label', 'resource', 'forum', 'url'],
      'en el orden en que el profesor los puso'
    );

    const tarea = modulos.find((module) => module.modname === 'assign');
    assert.equal(tarea.assignment.submitted, true, 'la tarea trae su estado de entrega, no solo su nombre');
    assert.equal(tarea.assignment.graded, true);
    assert.equal(tarea.assignment.gradeText, '85.00000');
    assert.ok(tarea.dueAt, 'y su fecha efectiva');

    const label = modulos.find((module) => module.modname === 'label');
    assert.equal(label.inlineOnly, true, 'un label se pinta y no se abre');
    assert.equal(label.url, null);

    const recurso = modulos.find((module) => module.modname === 'resource');
    assert.equal(recurso.files.length, 1, 'el material cuelga de su módulo');
    assert.equal(recurso.files[0].downloaded, false, 'y dice que todavía no se bajó');
  }

  // ── El libro que el profesor cerró NO es un cero ──
  {
    markGradebookAccess(USER, 800101, { reachable: 0, errorcode: 'nopermissiontoviewgrades', now: NOW });
    const data = aulaCourse(USER, 800101, { now: NOW });
    assert.equal(data.grade.hidden, true);
    assert.match(data.grade.reason, /tarea por tarea/, 'con la salida que sí existe');
    assert.equal(data.grade.total, '85.50', 'lo último que se pudo leer sigue estando');
    markGradebookAccess(USER, 800101, { reachable: 1, errorcode: null, now: NOW });

    // La otra ausencia, que es distinta: el sitio lo tiene deshabilitado.
    db.prepare('UPDATE pva_course SET show_grades = 0 WHERE user_id = ? AND course_id = ?').run(USER, 800101);
    markGradebookAccess(USER, 800101, { reachable: 1, errorcode: null, now: NOW });
    assert.match(aulaCourse(USER, 800101, { now: NOW }).grade.reason, /deshabilitado/);
    db.prepare('UPDATE pva_course SET show_grades = 1 WHERE user_id = ? AND course_id = ?').run(USER, 800101);
  }

  // ── Una materia sin contenido bajado no es una materia vacía ──
  {
    db.prepare('UPDATE pva_course SET hidden = 0, missing_since = NULL WHERE course_id = 800202').run();
    const data = aulaCourse(USER, 800202, { now: NOW });
    assert.equal(data.contentsSynced, false, 'y la pantalla lo dice en vez de pintar un curso sin nada');
    assert.deepEqual(data.sections, []);
    assert.equal(aulaCourse(USER, 999999, { now: NOW }), null, 'una materia que no existe es null, no un objeto vacío');
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ pantalla Aula: lo próximo es lo que falta hacer, el libro cerrado no es un cero y un curso sin bajar no es un curso vacío');
