// El libro de calificaciones contra fixtures, sin red.
//
// Tres cosas se prueban acá porque las tres, mal hechas, mienten al estudiante:
// los dos centinelas de "sin nota" (que significan cosas distintas), la
// bitácora que hace que el primer sync no avise de todo el semestre, y el
// `nopermissiontoviewgrades`, que es un estado válido del dominio y no un error
// que pueda abortar el ciclo.
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-pva-notas-'));
process.env.MIKAMPUS_DATA_DIR = dir;
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');

const { db } = await import('../src/db.js');
const { saveIdentity } = await import('../src/moodle/identity.js');
const { saveCourses } = await import('../src/moodle/courses.js');
const {
  isGradable,
  saveCourseTotals,
  saveGradeItems,
  syncGradeItems,
  syncGrades,
  gradebookTargets,
  gradebookAccess,
  readGradeItems,
  courseTotals,
  pendingGradeChanges,
} = await import('../src/moodle/grades.js');
const { MoodleError } = await import('../src/moodle/client.js');

const fixture = async (name) => JSON.parse(await readFile(`fixtures/${name}`, 'utf8'));
const siteInfo = await fixture('pva-site-info.json');
const courses = await fixture('pva-courses.json');
const items = await fixture('pva-grade-items.json');
const overview = await fixture('pva-grade-overview.json');

const USER = 1;
const AHORA = 1_772_000_000_000;
const conNota = (patch) => {
  const copia = structuredClone(items);
  Object.assign(copia.usergrades[0].gradeitems[0], patch);
  return copia;
};

try {
  saveIdentity(USER, siteInfo);
  saveCourses(USER, courses);

  // ── Los dos centinelas de "sin nota" ──
  {
    const [calificable, sinCalificar, total] = items.usergrades[0].gradeitems;
    assert.equal(isGradable(calificable), 1, "'-' con rango numérico es calificable y todavía sin nota");
    assert.equal(isGradable(sinCalificar), 0, "'' con rango sin dígitos es un item que NO califica");
    assert.equal(sinCalificar.grademax, 100, 'y reporta grademax 100 igual: confiar en el máximo es falso');
    assert.equal(isGradable({ rangeformatted: '0&ndash;0', grademax: 0 }), 0, 'un rango 0-0 tampoco califica');
    assert.equal(total.itemtype, 'course');
  }

  // ── El primer sync siembra y no avisa ──
  {
    const result = saveGradeItems(USER, 800101, items, { now: AHORA });
    assert.equal(result.items, 3);
    assert.deepEqual(result.changes, [], 'el primer sync nunca avisa: no hay contra qué comparar');

    const rows = readGradeItems(USER, 800101);
    assert.deepEqual(
      rows.map((row) => row.itemId),
      [960001, 960002, 960003],
      'el orden es el sortorder del libro que definió el profesor, no el id'
    );
    const totalRow = rows.find((row) => row.itemtype === 'course');
    assert.equal(totalRow.cmid, null, 'la clave cmid no viene en el total del curso');
    assert.equal(totalRow.name, null, 'ni el nombre: la etiqueta la pone la app');
    const item = db.prepare('SELECT * FROM pva_grade_item WHERE item_id = 960001').get();
    assert.equal(item.locked, null, 'locked es tri-estado: llega null y nunca false');
    assert.equal(item.category_id, 500001, 'el padre se resuelve contra el iteminstance del item de categoría');
  }

  // ── Nota publicada ──
  {
    const result = saveGradeItems(USER, 800101, conNota({ graderaw: 85, gradedategraded: 1772100000, gradeformatted: '85,00' }), {
      now: AHORA + 60_000,
    });
    assert.deepEqual(
      result.changes.map((change) => change.kind),
      ['published'],
      'de null a un número es una nota publicada'
    );
    const pending = pendingGradeChanges(USER);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, 'published');
    assert.equal(pending[0].newRaw, '85', 'se guarda el valor en texto, que es lo que se compara');

    // La misma respuesta otra vez no vuelve a asentar el mismo hecho.
    saveGradeItems(USER, 800101, conNota({ graderaw: 85, gradedategraded: 1772100000, gradeformatted: '85,00' }), { now: AHORA + 120_000 });
    assert.equal(pendingGradeChanges(USER).length, 1, 'el índice único hace idempotente la corrida');
  }

  // ── Recalificada, y el valor provisional que no se avisa ──
  {
    const result = saveGradeItems(USER, 800101, conNota({ graderaw: 90, gradedategraded: 1772200000, gradeformatted: '90,00' }), {
      now: AHORA + 180_000,
    });
    assert.deepEqual(result.changes.map((change) => change.kind), ['regraded'], 'cambió la fecha de calificación');

    const provisional = saveGradeItems(
      USER,
      800101,
      conNota({ graderaw: 95, gradedategraded: 1772300000, gradeneedsupdate: true }),
      { now: AHORA + 240_000 }
    );
    assert.deepEqual(provisional.changes, [], 'un valor provisional lo va a mover el cron del sitio: no se avisa');
  }

  // ── Una nota retirada, y un item que no califica ──
  {
    const retirada = saveGradeItems(USER, 800101, conNota({ graderaw: null, gradedategraded: null }), { now: AHORA + 300_000 });
    assert.deepEqual(retirada.changes.map((change) => change.kind), ['removed']);

    const copia = structuredClone(items);
    Object.assign(copia.usergrades[0].gradeitems[1], { graderaw: 10, gradedategraded: 1772400000 });
    const noCalificable = saveGradeItems(USER, 800101, copia, { now: AHORA + 360_000 });
    assert.deepEqual(noCalificable.changes, [], 'un item que no califica no genera aviso aunque traiga número');
  }

  // ── El total del curso lleva su propio evento ──
  {
    const copia = structuredClone(items);
    Object.assign(copia.usergrades[0].gradeitems[2], { graderaw: 88, gradeformatted: '88,00' });
    const result = saveGradeItems(USER, 800101, copia, { now: AHORA + 420_000 });
    assert.deepEqual(
      result.changes.map((change) => change.kind),
      ['total_moved'],
      'el total se recalcula con cada nota: si compartiera evento, cada nota avisaría dos veces'
    );
  }

  // ── Un item que desaparece no se borra ──
  {
    const copia = structuredClone(items);
    copia.usergrades[0].gradeitems = copia.usergrades[0].gradeitems.slice(0, 1);
    saveGradeItems(USER, 800101, copia, { now: AHORA + 480_000 });
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM pva_grade_item WHERE user_id = ?').get(USER).n,
      3,
      'el profesor puede ocultar un item y reponerlo: borrarlo lo haría reaparecer como nota nueva'
    );
  }

  // ── El disparador barato ──
  {
    const primero = saveCourseTotals(USER, overview, { now: AHORA });
    assert.equal(primero.courses, 2);
    assert.deepEqual(primero.dirty, [800101], 'el que trae valor cuenta como sucio la primera vez; el que trae "-" no');

    const igual = saveCourseTotals(USER, overview, { now: AHORA + 60_000 });
    assert.deepEqual(igual.dirty, [], 'el mismo total no ensucia nada');

    // Se compara rawgrade EN TEXTO: dos totales distintos pueden redondear
    // igual, y un cambio de formato del sitio dispararía falsos positivos.
    const movido = structuredClone(overview);
    movido.grades[0] = { ...movido.grades[0], grade: '85.50', rawgrade: '85.50001' };
    assert.deepEqual(saveCourseTotals(USER, movido, { now: AHORA + 120_000 }).dirty, [800101], 'el quinto decimal cuenta');

    assert.deepEqual(
      courseTotals(USER).map((row) => row.display),
      ['85.50', '-'],
      "el centinela '-' se guarda tal cual"
    );

    // El overview omite en silencio los cursos sin permiso: su ausencia no
    // puede interpretarse como "libro vacío".
    const parcial = { grades: [overview.grades[0]], warnings: [] };
    saveCourseTotals(USER, parcial, { now: AHORA + 180_000 });
    const ausente = gradebookAccess(USER).find((row) => row.courseId === 800303);
    assert.equal(ausente.inOverview, 0, 'se registra que no apareció');
    assert.equal(ausente.reachable, 1, 'pero no se lo declara inalcanzable: la ausencia es ambigua');
  }

  // ── Sin permiso en ESE curso ──
  {
    const call = async () => {
      throw new MoodleError('gradereport_user_get_grade_items: nopermissiontoviewgrades', {
        kind: 'permission',
        errorcode: 'nopermissiontoviewgrades',
      });
    };
    const result = await syncGradeItems(USER, 800101, { call, now: AHORA + 240_000 });
    assert.equal(result.reachable, false);
    assert.equal(result.errorcode, 'nopermissiontoviewgrades');
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM pva_grade_item WHERE user_id = ?').get(USER).n,
      3,
      'los items ya guardados NO se invalidan: el curso sigue teniendo sus notas viejas'
    );
    const access = gradebookAccess(USER).find((row) => row.courseId === 800101);
    assert.deepEqual(
      { reachable: access.reachable, code: access.lastErrorcode },
      { reachable: 0, code: 'nopermissiontoviewgrades' }
    );
    assert.deepEqual(
      gradebookTargets(USER, { now: AHORA + 300_000, dirty: [800101] }),
      [],
      'no se reintenta antes de 24 h, ni aunque el overview lo marque sucio'
    );
    assert.deepEqual(
      gradebookTargets(USER, { now: AHORA + 25 * 3600 * 1000, dirty: [800101] }),
      [800101],
      'pasadas las 24 h vuelve a entrar'
    );

    // Un error que no es de permisos sí se propaga: no es un estado del dominio.
    await assert.rejects(
      syncGradeItems(USER, 800101, {
        call: async () => {
          throw new MoodleError('se cayó', { kind: 'server' });
        },
      }),
      /se cayó/
    );
  }

  // ── showgrades es precondición dura ──
  {
    db.prepare('UPDATE pva_course SET hidden = 0, missing_since = NULL WHERE course_id = 800202').run();
    const targets = gradebookTargets(USER, { now: AHORA + 25 * 3600 * 1000 });
    assert.equal(targets.includes(800202), false, 'con showgrades false el libro es inalcanzable por las dos funciones');
  }

  // ── El ciclo completo: un curso sin permiso no aborta el resto ──
  {
    db.prepare('DELETE FROM pva_gradebook_access WHERE user_id = ?').run(USER);
    db.prepare('UPDATE pva_course SET show_grades = 1 WHERE course_id = 800202').run();
    const llamadas = [];
    const result = await syncGrades(USER, {
      now: AHORA + 48 * 3600 * 1000,
      call: async (fn, args) => {
        llamadas.push(fn);
        if (fn === 'gradereport_overview_get_course_grades') return overview;
        if (args.courseid === 800202) {
          throw new MoodleError('nopermissiontoviewgrades', { kind: 'permission', errorcode: 'nopermissiontoviewgrades' });
        }
        return items;
      },
    });
    assert.equal(result.detailed, 1, 'la materia con libro se sincronizó');
    assert.equal(result.unreachable, 1, 'y la otra quedó registrada como sin permiso');
    assert.equal(llamadas[0], 'gradereport_overview_get_course_grades', 'el overview va primero: es el disparador barato');
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ notas de la PVA: los dos centinelas, bitácora que no avisa el primer día, y sin permiso es un estado, no un error');
