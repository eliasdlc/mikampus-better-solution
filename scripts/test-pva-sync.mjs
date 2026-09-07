// Las fuentes de la PVA dentro del orquestador, y qué pasa con sus datos al
// cambiar de cuenta.
//
// Dos garantías: que la PVA se pausa por SU credencial y no por la del portal
// (son dos fuentes independientes), y que lo que la PVA guardó es tan personal
// como lo de micampus, así que se borra con todo lo demás.
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-pva-sync-'));
process.env.MIKAMPUS_DATA_DIR = dir;
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.MIKAMPUS_SILENT = '1';

const { db, clearPersonalData, logSync } = await import('../src/db.js');
const orchestrator = await import('../src/syncOrchestrator.js');
const { saveIdentity } = await import('../src/moodle/identity.js');
const { saveCourses, saveCourseContents } = await import('../src/moodle/courses.js');
const { saveAssignments, saveSubmissionStatus } = await import('../src/moodle/assignments.js');
const { saveGradeItems, saveCourseTotals } = await import('../src/moodle/grades.js');
const { saveCalendarEvents } = await import('../src/moodle/calendar.js');
const { saveForums, saveNotifications } = await import('../src/moodle/forums.js');

const fixture = async (name) => JSON.parse(await readFile(`fixtures/${name}`, 'utf8'));
const USER = 1;
const restores = [];
const calls = [];

const PVA_KEYS = orchestrator.SOURCES.filter((source) => source.key.startsWith('pva')).map((source) => source.key);

function stubAll() {
  for (const source of orchestrator.SOURCES) {
    restores.push(
      orchestrator.setSourceRunner(source.key, async () => {
        calls.push(source.key);
        logSync({ userId: source.shared ? null : USER, kind: source.key, status: 'ok' });
        return { detail: 'ok' };
      })
    );
  }
}

const statusOf = (results, key) => results.find((entry) => entry.key === key);

try {
  // ── El registro ──
  {
    assert.equal(PVA_KEYS.length, 12, 'doce fuentes: identidad, config, materias y las nueve ramas del aula');
    for (const source of orchestrator.SOURCES.filter((entry) => PVA_KEYS.includes(entry.key))) {
      assert.equal(source.needsPva, true, `${source.key} declara que necesita la credencial de la PVA`);
      assert.equal(source.needsPortal, false, `${source.key} no usa Playwright, así que no compite por la cola del portal`);
    }

    const order = orchestrator.orderedSources(PVA_KEYS).map((source) => source.key);
    assert.ok(order.indexOf('pvaIdentity') < order.indexOf('pvaCourses'), 'la identidad va primero: de ahí sale el moodle_userid');
    assert.ok(order.indexOf('pvaCourses') < order.indexOf('pvaCalendar'), 'y las materias antes que todo lo que cuelga de ellas');
    assert.ok(order.indexOf('pvaAssignments') < order.indexOf('pvaSubmissions'), 'el estado de entrega necesita la tarea');
    assert.ok(
      order.indexOf('pvaForums') < order.indexOf('pvaNotifications'),
      'la campanita va después de los foros: sin la tabla de foros no se sabe si un aviso es un anuncio del profesor'
    );

    // Pedir una rama suelta arrastra su cadena, no la corre huérfana.
    assert.deepEqual(
      orchestrator.orderedSources(['pvaNotifications']).map((source) => source.key),
      ['pvaIdentity', 'pvaCourses', 'pvaForums', 'pvaNotifications']
    );

    // Los TTL del mapa: la campanita es lo más corto y el contenido lo más largo.
    const ttl = Object.fromEntries(orchestrator.SOURCES.map((source) => [source.key, source.ttlMs]));
    assert.equal(ttl.pvaNotifications, 5 * 60_000);
    assert.equal(ttl.pvaCalendar, 15 * 60_000);
    assert.equal(ttl.pvaContents, 24 * 3600_000, 'la respuesta más pesada tiene el piso más alto');
    assert.ok(
      orchestrator.orderedSources(['pvaFiles']).map((source) => source.key).includes('pvaContents'),
      'los materiales se anotan al bajar el árbol: sin contenido no hay nada que descargar'
    );
    // Los avisos se entregan al final: dependen de las cuatro ramas que los
    // detectan, y sin ellas no hay nada que entregar.
    const cadenaAvisos = orchestrator.orderedSources(['pvaAlerts']).map((source) => source.key);
    for (const rama of ['pvaAssignments', 'pvaGrades', 'pvaNotifications', 'pvaForums']) {
      assert.ok(cadenaAvisos.includes(rama), `los avisos esperan a ${rama}`);
    }
    assert.equal(cadenaAvisos.at(-1), 'pvaAlerts');
  }

  // ── Sin vincular la PVA: pausa, y el portal ni se entera ──
  {
    stubAll();
    restores.push(orchestrator.setSessionProbe(() => true));
    restores.push(orchestrator.setPvaProbe(() => false));

    const result = await orchestrator.runSync(USER, { force: true, emit: () => {} });
    for (const key of PVA_KEYS) {
      const entry = statusOf(result, key);
      // Las que dependen de una pausada quedan bloqueadas, no ejecutadas: en
      // los dos casos, lo que importa es que no se llamó a la PVA.
      assert.ok(['paused', 'blocked'].includes(entry.status), `${key} no sale a la red sin credencial (${entry.status})`);
    }
    assert.match(statusOf(result, 'pvaIdentity').reason, /no está vinculada/i, 'la pausa explica qué falta');
    assert.equal(calls.filter((key) => PVA_KEYS.includes(key)).length, 0, 'ninguna corrió');
    assert.equal(statusOf(result, 'mySchedule').status, 'updated', 'y micampus siguió trabajando igual');

    const state = orchestrator.syncState(USER);
    assert.match(state.pvaHold, /no está vinculada/i, 'el estado global lo dice sin mezclarlo con la sesión del portal');
    assert.equal(state.hold, null, 'que son dos pausas distintas');
    assert.equal(state.sources.find((source) => source.key === 'pvaCourses').needsPva, true);
  }

  // ── Vinculada: corren, y el portal caído no las toca ──
  {
    calls.length = 0;
    restores.push(orchestrator.setSessionProbe(() => false));
    restores.push(orchestrator.setPvaProbe(() => true));
    const result = await orchestrator.runSync(USER, { force: true, emit: () => {} });
    for (const key of PVA_KEYS) {
      assert.equal(statusOf(result, key).status, 'updated', `${key} corre aunque micampus esté caído`);
    }
    assert.equal(statusOf(result, 'mySchedule').status, 'paused', 'y el portal queda pausado por lo suyo');
  }

  while (restores.length) restores.pop()();

  // ── Los datos de la PVA son personales: se borran con todo lo demás ──
  {
    const siteInfo = await fixture('pva-site-info.json');
    const courses = await fixture('pva-courses.json');
    saveIdentity(USER, siteInfo);
    saveCourses(USER, courses);
    saveCourseContents(USER, 800101, await fixture('pva-contents.json'));
    saveAssignments(USER, await fixture('pva-assignments.json'));
    saveSubmissionStatus(USER, 900001, await fixture('pva-submission-graded.json'));
    saveGradeItems(USER, 800101, await fixture('pva-grade-items.json'));
    saveCourseTotals(USER, await fixture('pva-grade-overview.json'));
    saveCalendarEvents(USER, await fixture('pva-calendar-events.json'));
    saveForums(USER, await fixture('pva-forums.json'));
    saveNotifications(USER, await fixture('pva-notifications.json'));

    // Los materiales: se anotan solos al guardar el árbol, y su texto se indexa
    // en una tabla FTS5 que no se vacía por cascada.
    const { indexFileText } = await import('../src/moodle/files.js');
    const archivo = db.prepare('SELECT file_id, filename, mimetype FROM pva_file WHERE user_id = ?').get(USER);
    assert.ok(archivo, 'el árbol del curso trajo al menos un material');
    await indexFileText({ ...archivo, sha256: 'abc' }, Buffer.from('<p>la integral definida</p>'), {
      contentType: 'text/html',
    });
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM pva_file_text_fts WHERE pva_file_text_fts MATCH ?').get('integral').n,
      1,
      'el texto quedó indexado'
    );

    const tablas = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pva\\_%' ESCAPE '\\'
           AND name NOT LIKE 'pva\\_file\\_text\\_fts%' ESCAPE '\\' ORDER BY name`
      )
      .all()
      .map((row) => row.name);
    assert.equal(tablas.length, 27, 'las 27 tablas del esquema de la PVA, sin contar las internas del índice');
    const conFilas = tablas.filter((tabla) => db.prepare(`SELECT count(*) AS n FROM ${tabla}`).get().n > 0);
    // pva_site_config es del sitio, no de la persona, y acá no se llenó.
    assert.equal(conFilas.length >= 12, true, `hay datos que borrar: ${conFilas.join(', ')}`);

    clearPersonalData(USER);

    const quedan = tablas
      .map((tabla) => [tabla, db.prepare(`SELECT count(*) AS n FROM ${tabla}`).get().n])
      .filter(([tabla, n]) => n > 0 && tabla !== 'pva_site_config');
    assert.deepEqual(quedan, [], 'ni una fila de la PVA sobrevive, incluidas las hijas que caen por FK');
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM pva_file_text_fts WHERE pva_file_text_fts MATCH ?').get('integral').n,
      0,
      'y el índice de texto se vacía a mano: por cascada NO se limpia, y sus términos aparecerían en la cuenta siguiente'
    );

    const sincronias = db
      .prepare("SELECT DISTINCT kind FROM sync_log WHERE user_id = ? AND kind LIKE 'pva%'")
      .all(USER);
    assert.deepEqual(sincronias, [], 'y el registro de frescura tampoco, o diría "actualizado" sobre tablas vacías');
  }
} finally {
  while (restores.length) restores.pop()();
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ sync de la PVA: diez fuentes en su orden, pausa por su propia credencial, y sus datos se borran con los del portal');
