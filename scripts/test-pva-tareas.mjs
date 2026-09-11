// Tareas y estado de entrega contra fixtures, sin red.
//
// El corazón de esta prueba es la unión discriminada: con `notgraded` la clave
// `feedback` NO EXISTE, y leerla sin guardia revienta en 2 de las 3 respuestas
// del volcado. Lo demás son los centinelas de fecha, que son la diferencia
// entre "cierra hoy" y "se acepta tarde para siempre".
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-pva-tareas-'));
process.env.MIKAMPUS_DATA_DIR = dir;
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');

const { db } = await import('../src/db.js');
const { saveIdentity } = await import('../src/moodle/identity.js');
const { saveCourses } = await import('../src/moodle/courses.js');
const {
  saveAssignments,
  saveSubmissionStatus,
  syncAssignments,
  syncSubmissions,
  assignmentsNeedingStatus,
  deriveSubmissionState,
  readAssignments,
} = await import('../src/moodle/assignments.js');

const fixture = async (name) => JSON.parse(await readFile(`fixtures/${name}`, 'utf8'));
const siteInfo = await fixture('pva-site-info.json');
const courses = await fixture('pva-courses.json');
const assignments = await fixture('pva-assignments.json');
const graded = await fixture('pva-submission-graded.json');
const notGraded = await fixture('pva-submission-notgraded.json');

const USER = 1;
const AHORA = 1_771_000_000_000; // ms, entre la apertura y la entrega del fixture

try {
  saveIdentity(USER, siteInfo);
  saveCourses(USER, courses);

  // ── El catálogo de tareas ──
  {
    const result = saveAssignments(USER, assignments, { now: AHORA });
    assert.equal(result.assignments, 2);
    assert.equal(result.inaccessible, 1, 'los warnings no son ruido: son módulos que no podés ver');

    const row = db.prepare('SELECT * FROM pva_assignment WHERE assignment_id = 900001').get();
    assert.equal(row.cmid, 910001, 'el cmid es la clave de join con módulos, notas y calendario');
    assert.equal(row.duedate, 1772000000);
    // El 0 de Moodle no es 1970: entra como NULL, y el CHECK del esquema
    // impediría que se colara un 0.
    assert.equal(row.cutoffdate, null, 'cutoffdate 0 significa que se acepta tarde indefinidamente');
    assert.equal(row.gradingduedate, null, 'y gradingduedate 0 es un compromiso del profesor que no existe');
    assert.equal(row.allowsubmissionsfromdate, 1770000000);

    const segunda = db.prepare('SELECT duedate, cutoffdate, allowsubmissionsfromdate FROM pva_assignment WHERE assignment_id = 900006').get();
    assert.equal(segunda.cutoffdate, segunda.duedate, 'cutoff igual a la entrega es el extremo opuesto del 0: no acepta nada tarde');
    assert.equal(segunda.allowsubmissionsfromdate, null, 'y apertura 0 es "abierta desde siempre"');

    const configs = db.prepare('SELECT * FROM pva_assignment_config WHERE assignment_id = 900001').all();
    assert.ok(configs.length >= 1);
    assert.equal(typeof configs[0].value, 'string', 'value es SIEMPRE string, incluso los booleanos');
    const onlinetext = configs.find((config) => config.plugin === 'onlinetext');
    assert.equal(onlinetext, undefined, 'plugin ausente es "no disponible", no enabled=0');

    const warning = db.prepare('SELECT * FROM pva_assignment_inaccessible WHERE user_id = ?').get(USER);
    assert.equal(warning.cmid, 910099);
    assert.equal(warning.warningcode, '1', 'el código llega como string, no como número');
  }

  // ── Estado de entrega calificado: la clave feedback existe ──
  {
    const result = saveSubmissionStatus(USER, 900001, graded, { now: AHORA });
    assert.deepEqual(
      { saved: result.saved, status: result.status, graded: result.graded },
      { saved: true, status: 'submitted', graded: true }
    );
    const submission = db.prepare('SELECT * FROM pva_submission WHERE assignment_id = 900001').get();
    assert.equal(submission.attemptnumber, 0, 'attemptnumber es base 0: tratarlo como 1 desplaza toda la numeración');
    assert.equal(submission.grading_status, 'graded');
    assert.equal(submission.can_submit, 0, 'cansubmit fue false hasta en las editables: no sirve de condición');
    assert.equal(submission.extensionduedate, null, 'llega 0 o null y las dos son "sin prórroga"');

    const feedback = db.prepare('SELECT * FROM pva_submission_feedback WHERE assignment_id = 900001').get();
    assert.equal(feedback.grade_raw_text, '85.00000', 'el string original se conserva tal cual');
    assert.equal(feedback.grade_value, 85, 'y el número derivado sirve para calcular');
    assert.ok(feedback.grade_for_display.includes('&nbsp;'), 'gradefordisplay es HTML del servidor: solo para mostrar');
    assert.match(feedback.comment_html, /Buen trabajo/, 'el comentario vive en el lado feedback, no en la entrega');
  }

  // ── Sin calificar: la clave no está, y leerla sin guardia reventaría ──
  {
    assert.equal('feedback' in notGraded, false, 'el fixture conserva la unión discriminada tal como llega');
    const result = saveSubmissionStatus(USER, 900006, notGraded, { now: AHORA });
    assert.equal(result.graded, false);
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM pva_submission_feedback WHERE assignment_id = 900006').get().n,
      0,
      'no se inventa una fila de nota vacía'
    );

    // Y si una nota se retira, la fila se va con ella.
    saveSubmissionStatus(USER, 900001, notGraded, { now: AHORA });
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM pva_submission_feedback WHERE assignment_id = 900001').get().n,
      0,
      'una nota retirada no queda colgada en la base'
    );
    saveSubmissionStatus(USER, 900001, graded, { now: AHORA });
  }

  // ── Un estado desconocido se planta en vez de guardar basura ──
  assert.throws(
    () => saveSubmissionStatus(USER, 900001, { lastattempt: { submission: { status: 'inventado', attemptnumber: 0 } } }),
    /Estado de entrega desconocido/,
    'el CHECK del esquema y el parser dicen lo mismo'
  );

  // ── La derivación: editar no es lo mismo que entregar ──
  {
    const assignment = db.prepare('SELECT * FROM pva_assignment WHERE assignment_id = 900001').get();
    const submission = db.prepare('SELECT * FROM pva_submission WHERE assignment_id = 900001').get();

    const estado = deriveSubmissionState({ assignment, submission, now: AHORA });
    assert.equal(estado.submitted, true);
    assert.equal(estado.graded, true);
    assert.equal(estado.acceptsLate, true, 'sin cutoff se acepta tarde indefinidamente');
    assert.equal(estado.closesAt, assignment.duedate, 'sin cutoff ni prórroga, la fecha efectiva es la de entrega');
    assert.equal(estado.needsConfirmation, false, 'con submissiondrafts 0 no hay paso de confirmación');
    assert.equal(estado.isLate, false, 'entregó antes de la fecha');

    // El otro extremo del mismo cero: cutoff igual a la entrega no acepta nada
    // tarde, y una vez pasado ya no se puede tocar.
    const cerrada = { ...assignment, cutoffdate: assignment.duedate };
    const despues = deriveSubmissionState({ assignment: cerrada, submission, now: (assignment.duedate + 3600) * 1000 });
    assert.equal(despues.acceptsLate, false);
    assert.equal(despues.closedForever, true);

    // Entregado después de la fecha: la comparación es contra timemodified.
    const tarde = { ...submission, timemodified: assignment.duedate + 60 };
    assert.equal(deriveSubmissionState({ assignment, submission: tarde, now: AHORA }).isLate, true);
    // Y una prórroga corre la fecha efectiva, así que deja de ser tarde.
    const conProrroga = { ...tarde, extensionduedate: assignment.duedate + 86400 };
    assert.equal(deriveSubmissionState({ assignment, submission: conProrroga, now: AHORA }).isLate, false);

    // Sin entrega y con la fecha pasada: vencida.
    const sinEntrega = deriveSubmissionState({ assignment, submission: null, now: (assignment.duedate + 60) * 1000 });
    assert.equal(sinEntrega.isOverdue, true);
    assert.equal(sinEntrega.canEdit, false, 'sin respuesta del servidor no se asume que se puede editar');
  }

  // ── A quién le toca una llamada de estado ──
  {
    // La tarea del fixture vence a las 1772000000: a 12 h de ese momento entra
    // en la ventana de 48 h, donde el TTL baja a 30 minutos.
    const cerca = (1772000000 - 12 * 3600) * 1000;
    db.prepare('UPDATE pva_submission SET fetched_at = ? WHERE assignment_id = 900001').run(Math.floor(cerca / 1000) - 40 * 60);
    assert.ok(assignmentsNeedingStatus(USER, { now: cerca }).includes(900001), 'a 12 h de vencer se refresca cada 30 min');

    db.prepare('UPDATE pva_submission SET fetched_at = ? WHERE assignment_id = 900001').run(Math.floor(cerca / 1000) - 10 * 60);
    assert.equal(
      assignmentsNeedingStatus(USER, { now: cerca }).includes(900001),
      false,
      'diez minutos después no se vuelve a preguntar por ella'
    );

    // Vencida, cerrada y calificada: no se vuelve a preguntar nunca.
    db.prepare('UPDATE pva_assignment SET cutoffdate = ? WHERE assignment_id = 900001').run(1772000000);
    db.prepare("UPDATE pva_submission SET fetched_at = 0, grading_status = 'graded' WHERE assignment_id = 900001").run();
    assert.equal(
      assignmentsNeedingStatus(USER, { now: (1772000000 + 86400) * 1000 }).includes(900001),
      false,
      'una tarea vencida, cerrada y calificada ya no cambia: no se vuelve a preguntar nunca'
    );
    db.prepare('UPDATE pva_assignment SET cutoffdate = NULL WHERE assignment_id = 900001').run();
  }

  // ── El lote y sus fallos ──
  {
    const calls = [];
    const result = await syncAssignments(USER, {
      call: async (fn, args) => {
        calls.push([fn, args]);
        return assignments;
      },
      courseIds: [800101],
      now: AHORA,
    });
    assert.equal(result.assignments, 2);
    assert.deepEqual(calls[0][1], { courseids: [800101] }, 'un lote con todos los cursos, no una llamada por curso');

    const vacio = await syncAssignments(USER, { call: async () => assignments, courseIds: [], now: AHORA });
    assert.equal(vacio.assignments, 0, 'sin materias activas no se sale a la red');

    // Una tarea que revienta no puede tumbar el resto del lote.
    db.prepare("UPDATE pva_submission SET fetched_at = 0 WHERE assignment_id IN (900001, 900006)").run();
    const status = await syncSubmissions(USER, {
      call: async (fn, args) => {
        if (args.assignid === 900001) throw new Error('se cayó esa');
        return notGraded;
      },
      now: AHORA,
    });
    assert.equal(status.failed, 1);
    assert.equal(status.saved, 1, 'la otra se guardó igual');
  }

  // ── La lectura une tarea, entrega y nota ──
  {
    saveSubmissionStatus(USER, 900001, graded, { now: AHORA });
    const rows = readAssignments(USER, 800101);
    assert.equal(rows.length, 2, 'las dos tareas del curso, ordenadas por fecha');
    assert.deepEqual(
      { name: rows[0].name, status: rows[0].status, gradeText: rows[0].gradeText },
      { name: 'Tarea de prueba', status: 'submitted', gradeText: '85.00000' }
    );
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ tareas de la PVA: unión discriminada sin feedback, centinelas de fecha, editar distinto de entregar, TTL por urgencia');
