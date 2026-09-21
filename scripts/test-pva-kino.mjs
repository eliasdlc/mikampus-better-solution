// El puente entre el aula y Kino. Sin red: el fetch se sustituye.
//
// Lo que se prueba es lo que hace inservible un puente de este tipo: que suba
// lo que allá no significa nada, que el libro de la notificación local consuma
// el de Kino y deje una tarea sin crear, que un fallo de red marque el aviso
// como subido y no se reintente nunca, y que el primer sync de un curso vuelque
// el semestre entero de material.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-pva-kino-'));
process.env.MIKAMPUS_DATA_DIR = dir;
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.MIKAMPUS_SILENT = '1';

const { db } = await import('../src/db.js');
const { saveIdentity } = await import('../src/moodle/identity.js');
const { saveCourses, saveCourseContents } = await import('../src/moodle/courses.js');
const { saveAssignments } = await import('../src/moodle/assignments.js');
const { recordAlert, deliverAlerts, pendingForKino, markKinoSent, isMaterialModname, ALERT_KINDS } = await import('../src/moodle/alerts.js');
const { itemOf, previewBatch, pushToKino, kinoConfig, pendingCount } = await import('../src/moodle/kinoSync.js');

const fixture = async (name) => JSON.parse(await readFile(`fixtures/${name}`, 'utf8'));
const USER = 1;
const NOW = 1_771_900_000_000;
const env = { KINO_ACADEMICO_URL: 'https://kino.test/academico', KINO_ACADEMICO_TOKEN: 'secreto' };

try {
  saveIdentity(USER, await fixture('pva-site-info.json'));
  saveCourses(USER, await fixture('pva-courses.json'), { now: NOW });
  const assignments = await fixture('pva-assignments.json');
  saveAssignments(USER, assignments, { now: NOW });

  const primera = db.prepare('SELECT assignment_id AS id, course_id AS courseId, name, duedate FROM pva_assignment ORDER BY assignment_id LIMIT 1').get();
  assert.ok(primera, 'el fixture de tareas tiene que dejar al menos una');

  // ── Qué sube y qué no ──
  //
  // Una nota publicada no es algo que hacer, y un anuncio casi nunca lo es. Si
  // subieran, la lista de tareas de Kino sería el feed del aula.
  const alerta = (kind, subjectKey, extra = {}) =>
    recordAlert(USER, { kind, source: 'diff', subjectKey, title: `${kind} de prueba`, courseId: primera.courseId, occurredAt: NOW / 1000, now: NOW, ...extra });

  alerta('tarea_nueva', `assign:${primera.id}`);
  alerta('nota_publicada', 'gradeitem:77');
  alerta('anuncio', 'discussion:5');
  // El título lleva el prefijo del canal, como lo escribe recordNewMaterial.
  alerta('material_nuevo', 'cmid:4242', { title: 'Material nuevo en CSTI-1930: Diapositivas unidad 3' });

  const suben = pendingForKino(USER).map((row) => row.kind).sort();
  assert.deepEqual(suben, ['material_nuevo', 'tarea_nueva'], 'solo sube lo que ocupa tiempo');
  assert.equal(pendingCount(USER), 2);

  // ── Dos libros, y ninguno consume al otro ──
  //
  // deliverAlerts marca delivered_at aunque los avisos estén apagados. Si esa
  // fuera la misma marca, un aviso silenciado en el escritorio no llegaría
  // nunca a ser una tarea.
  deliverAlerts(USER, { now: NOW });
  assert.equal(pendingForKino(USER).length, 2, 'la entrega local no puede consumir la subida a Kino');

  // ── La forma del item ──
  const { items } = previewBatch(USER);
  const tarea = items.find((item) => item.externalId === `assign:${primera.id}`);
  assert.ok(tarea, 'la tarea tiene que viajar con la llave del objeto de Moodle');
  assert.equal(tarea.title, primera.name, 'el título es el de la tarea, sin el prefijo del canal');
  assert.ok(tarea.courseCode && tarea.courseName, 'la materia viaja para que Kino encuentre su carpeta');
  if (primera.duedate) {
    assert.equal(tarea.dueDate, primera.duedate * 1000, 'Moodle guarda segundos y Kino espera milisegundos');
  }
  const material = items.find((item) => item.externalId === 'cmid:4242');
  assert.equal(material.title, 'Diapositivas unidad 3', 'el título pierde el prefijo del canal: la materia ya está en la carpeta');

  // ── Apagado por defecto ──
  assert.equal(kinoConfig({}), null);
  const apagado = await pushToKino(USER, { env: {}, fetchImpl: () => assert.fail('apagado no puede tocar la red') });
  assert.equal(apagado.skipped, 'no-configurado');
  assert.equal(pendingForKino(USER).length, 2, 'apagado no marca nada');

  // ── Un fallo de red no asienta nada ──
  const caido = await pushToKino(USER, { env, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(caido.sent, 0);
  assert.match(caido.error, /ECONNREFUSED/);
  assert.equal(pendingForKino(USER).length, 2, 'lo que no subió se reintenta solo');

  // Un 403 tampoco: la respuesta del servidor manda sobre el optimismo.
  const rechazado = await pushToKino(USER, { env, fetchImpl: async () => new Response('FORBIDDEN', { status: 403 }) });
  assert.equal(rechazado.status, 403);
  assert.equal(pendingForKino(USER).length, 2);

  // ── La subida buena asienta, y solo una vez ──
  let enviado = null;
  const ok = await pushToKino(USER, {
    env,
    now: NOW,
    fetchImpl: async (url, init) => {
      enviado = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ creadas: 2, actualizadas: 0, sinCambio: 0, sinCarpeta: [] }), { status: 200 });
    },
  });
  assert.equal(enviado.url, env.KINO_ACADEMICO_URL);
  assert.equal(enviado.headers.Authorization, 'Bearer secreto');
  assert.equal(enviado.body.source, 'pva');
  assert.equal(ok.sent, 2);
  assert.equal(ok.marked, 2);
  assert.equal(pendingForKino(USER).length, 0);

  const segunda = await pushToKino(USER, { env, fetchImpl: () => assert.fail('no queda nada que subir') });
  assert.equal(segunda.sent, 0);
  assert.equal(markKinoSent([]), 0);

  // ── El material nuevo sale del árbol del curso ──
  //
  // El primer árbol de un curso siembra y no avisa: sin esto, encender el
  // barrido en noviembre trae el cuatrimestre entero de golpe.
  const contents = await fixture('pva-contents.json');
  const curso = db.prepare('SELECT course_id AS id FROM pva_course ORDER BY course_id LIMIT 1').get().id;
  const antesDelArbol = pendingCount(USER);
  const sembrado = saveCourseContents(USER, curso, contents, { now: NOW });
  assert.equal(sembrado.seeded, true, 'el primer árbol del curso siembra');
  assert.equal(pendingCount(USER), antesDelArbol, 'sembrar no avisa de nada');

  // El árbol siguiente, con un recurso que no estaba, sí avisa. Y una etiqueta
  // no es material: es texto suelto en la página del curso.
  const seccion = contents[0];
  const nuevoRecurso = { ...seccion.modules[0], id: 999_001, name: 'Diapositivas unidad 3', modname: 'resource', uservisible: true };
  const etiqueta = { ...seccion.modules[0], id: 999_002, name: 'Un titulito', modname: 'label', uservisible: true };
  const crecido = [{ ...seccion, modules: [...seccion.modules, nuevoRecurso, etiqueta] }, ...contents.slice(1)];
  saveCourseContents(USER, curso, crecido, { now: NOW + 1000 });

  const material2 = pendingForKino(USER);
  assert.equal(material2.length, 1, 'avisa del recurso y calla la etiqueta');
  assert.equal(material2[0].subjectKey, 'cmid:999001');
  assert.ok(isMaterialModname('resource') && !isMaterialModname('label') && !isMaterialModname('assign'));

  assert.ok(ALERT_KINDS.includes('material_nuevo'));

  console.log('test-pva-kino: ok');
} finally {
  db.close();
  await rm(dir, { recursive: true, force: true });
}
