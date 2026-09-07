// Las herramientas de la PVA en el MCP, contra una base sembrada con los mismos
// fixtures que usa el sync.
//
// Lo que se prueba no es que devuelvan filas: es que el sobre diga la verdad
// cuando el dato NO está. Un libro que el profesor ocultó, una tarea cuyo
// estado nunca se consultó y un anuncio cuyo cuerpo no se puede leer tienen que
// salir nombrados en `unknown`, porque eso es lo que hace estructuralmente
// imposible que un agente los rellene.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-mcp-pva-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.MIKAMPUS_DATA_DIR = dir;

const { db, logSync } = await import('../src/db.js');
const { saveIdentity } = await import('../src/moodle/identity.js');
const { saveCourses, saveCourseContents } = await import('../src/moodle/courses.js');
const { saveAssignments, saveSubmissionStatus } = await import('../src/moodle/assignments.js');
const { saveGradeItems, saveCourseTotals, markGradebookAccess } = await import('../src/moodle/grades.js');
const { saveCalendarEvents } = await import('../src/moodle/calendar.js');
const { saveForums, saveNotifications } = await import('../src/moodle/forums.js');

const fixture = async (name) => JSON.parse(await readFile(`fixtures/${name}`, 'utf8'));
const USER = 1;
// Entre la apertura (1770000000) y la entrega (1772000000) del fixture.
const NOW = new Date(1_771_900_000_000);

db.exec("INSERT OR IGNORE INTO users (id, portal_username) VALUES (1, 'elias.delacruz')");
saveIdentity(USER, { ...(await fixture('pva-site-info.json')), userprivateaccesskey: 'llave-que-no-debe-salir' });
saveCourses(USER, await fixture('pva-courses.json'), { now: NOW.getTime() });
saveCourseContents(USER, 800101, await fixture('pva-contents.json'), { now: NOW.getTime() });
saveAssignments(USER, await fixture('pva-assignments.json'), { now: NOW.getTime() });
saveSubmissionStatus(USER, 900001, await fixture('pva-submission-graded.json'), { now: NOW.getTime() });
saveGradeItems(USER, 800101, await fixture('pva-grade-items.json'), { now: NOW.getTime() });
saveCourseTotals(USER, await fixture('pva-grade-overview.json'), { now: NOW.getTime() });
saveCalendarEvents(USER, await fixture('pva-calendar-events.json'), { now: NOW.getTime() });
saveForums(USER, await fixture('pva-forums.json'), { now: NOW.getTime() });
saveNotifications(USER, await fixture('pva-notifications.json'), { now: NOW.getTime() });
for (const kind of ['pvaCourses', 'pvaAssignments', 'pvaCalendar', 'pvaGrades', 'pvaNotifications', 'pvaForums', 'pvaContents']) {
  logSync({ userId: USER, kind, status: 'ok' });
}

// Un material bajado e indexado: sin esto, la búsqueda solo probaría el camino
// vacío, que es justo el que no tiene gracia.
const { indexFileText } = await import('../src/moodle/files.js');
const material = db.prepare('SELECT file_id, filename, mimetype FROM pva_file WHERE user_id = ?').get(USER);
await indexFileText({ ...material, sha256: 'sha-de-prueba' }, Buffer.from('<p>La integral definida de una función continua</p>'), {
  contentType: 'text/html',
});
// Y uno que la PVA declara pero que todavía no se bajó: es el caso que hace
// que cero resultados no signifique "no está en tus materiales".
db.prepare(
  `INSERT INTO pva_file (user_id, course_id, cmid, context_id, component, area, filepath, filename,
     fileurl, filesize, mimetype, timemodified, source_fn, seen_at)
   VALUES (?, 800101, 910001, 990001, 'mod_assign', 'introattachment', '/', 'enunciado.pdf',
     'https://campusvirtual.pucmm.edu.do/moodle/webservice/pluginfile.php/990001/mod_assign/introattachment/0/enunciado.pdf',
     51200, 'application/pdf', 1770000000, 'mod_assign_get_assignments', 1770000000)`
).run(USER);
logSync({ userId: USER, kind: 'pvaFiles', status: 'ok' });

const { READ_TOOLS, ABOUT_RESOURCE } = await import('../src/mcp/tools.js');
const { sanitize } = await import('../src/mcp/redact.js');
const {
  pvaCoursesEnvelopeSchema,
  pvaDueEnvelopeSchema,
  pvaAssignmentEnvelopeSchema,
  pvaGradesEnvelopeSchema,
  pvaAnnouncementsEnvelopeSchema,
  pvaSectionsEnvelopeSchema,
  pvaSearchEnvelopeSchema,
} = await import('../src/shared/mcp.ts');

const tool = (name) => {
  const entry = READ_TOOLS.find((candidate) => candidate.name === name);
  assert.ok(entry, `la herramienta ${name} está registrada`);
  return entry;
};
const call = (name, args = {}) => tool(name).run({ ...args, now: NOW });
const unknownKinds = (result) => result.payload.unknown.map((entry) => entry.kind);

try {
  // ── Las seis existen y declaran su contrato ──
  {
    const nombres = READ_TOOLS.map((entry) => entry.name).filter((name) => /pva/.test(name));
    assert.deepEqual(nombres.sort(), [
      'get_pva_announcements',
      'get_pva_assignment',
      'get_pva_courses',
      'get_pva_due',
      'get_pva_grades',
      'get_pva_section',
      'search_pva_files',
    ]);
    for (const name of nombres) {
      assert.ok(tool(name).config.outputSchema, `${name} declara el sobre que devuelve`);
      assert.match(tool(name).config.description, /PVA|aula/i, `${name} dice de qué plataforma habla`);
    }
  }

  // ── Materias ──
  {
    const result = call('get_pva_courses');
    pvaCoursesEnvelopeSchema.parse(result.payload);
    const courses = result.payload.data.courses;
    assert.equal(courses.length, 1, 'solo la del ciclo: la oculta no es del ciclo');
    assert.equal(courses[0].shortname, 'MAT-101-01');
    assert.deepEqual(
      { total: courses[0].assignments.total, graded: courses[0].assignments.graded },
      { total: 2, graded: 1 }
    );
    assert.equal(courses[0].gradebook.total, '85.50', 'el total del aula, tal como lo publica el sitio');
    assert.equal(courses[0].sections, 2, 'el árbol ya está sincronizado');

    const freshness = result.payload.freshness.map((entry) => entry.kind);
    assert.deepEqual(freshness, ['pvaCourses', 'pvaAssignments', 'pvaGrades'], 'cita de qué datasets salió');
    assert.equal(result.payload.freshness[0].neverSynced, false);

    const warning = result.payload.warnings.find((entry) => entry.kind === 'pva_modulos_sin_acceso');
    assert.ok(warning, 'los módulos que la PVA no deja ver se nombran en vez de desaparecer');
  }

  // ── Qué vence ──
  {
    const result = call('get_pva_due', { days: 30 });
    pvaDueEnvelopeSchema.parse(result.payload);
    const items = result.payload.data.items;
    assert.equal(items.length, 3, 'dos tareas y un foro con fecha, ordenados por cuándo vencen');
    assert.deepEqual(
      items.map((item) => item.kind),
      ['assign_due', 'forum_due', 'assign_due'],
      'el foro con fecha de entrega entra: mod_assign no lo reporta y vence igual'
    );
    assert.deepEqual(
      items.filter((item) => item.assignmentId).map((item) => item.assignmentId),
      [900001, 900006],
      'el evento del calendario y la tarea se unieron por cmid: no salen duplicados'
    );
    assert.equal(items[0].submitted, true, 'la entregada se sigue mostrando aunque el feed ya no la traiga');
    assert.equal(items[0].graded, true);
    assert.equal(items[1].submitted, null, 'de un foro no hay estado de entrega que mirar');
    assert.equal(
      items[2].submitted,
      null,
      'de la segunda tarea nunca se consultó el estado: null es "no se sabe", no "sin entregar"'
    );
    assert.ok(
      unknownKinds(result).includes('pva_estado_de_entrega'),
      'y el sobre lo nombra, que es lo que impide que un agente lo dé por pendiente'
    );
    assert.ok(items[0].courseShortname, 'con su materia, para no obligar a otra llamada');
    assert.ok(
      unknownKinds(result).includes('pva_calendario'),
      'se dice que el feed solo trae lo pendiente: si no, un agente concluiría que lo entregado ya no existe'
    );

    // Una ventana corta no arrastra lo de dentro de un mes.
    assert.equal(call('get_pva_due', { days: 1 }).payload.data.items.length, 0);
  }

  // ── Una tarea ──
  {
    const porNombre = call('get_pva_assignment', { query: 'Segunda' });
    pvaAssignmentEnvelopeSchema.parse(porNombre.payload);
    assert.equal(porNombre.payload.data.assignment.assignmentId, 900006, 'una sola coincidencia se resuelve sola');
    assert.equal(porNombre.payload.data.assignment.submission, null, 'de esa nunca se consultó el estado');
    assert.ok(
      unknownKinds(porNombre).includes('pva_estado_de_entrega'),
      'y eso se dice: no se asume que está sin entregar'
    );

    const ambigua = call('get_pva_assignment', { query: 'tarea de prueba' });
    assert.equal(ambigua.payload.data.assignment, null);
    assert.equal(ambigua.payload.data.matches.length, 2, 'con dos coincidencias devuelve las opciones, no elige');

    const porId = call('get_pva_assignment', { assignmentId: 900001 });
    const tarea = porId.payload.data.assignment;
    assert.equal(tarea.submission.status, 'submitted');
    assert.equal(tarea.submission.isLate, false);
    assert.equal(tarea.submission.acceptsLate, true, 'sin corte se acepta tarde indefinidamente');
    assert.equal(tarea.grade.raw, '85.00000', 'la nota en texto, como la manda el servidor');
    assert.match(tarea.grade.comment, /Buen trabajo/);
    assert.ok(
      porIdIncluye(porId, 'pva_nota'),
      'una nota del aula viene con la aclaración de que no es la del expediente'
    );
    assert.ok(
      porId.payload.warnings.some((entry) => entry.kind === 'pva_sin_corte'),
      'y con el aviso de que sin corte todavía se puede entregar'
    );

    const inexistente = call('get_pva_assignment', { query: 'no existe esta tarea' });
    assert.equal(inexistente.payload.data.assignment, null);
    assert.deepEqual(inexistente.payload.data.matches, []);
  }

  // ── Notas del aula ──
  {
    const result = call('get_pva_grades', { course: 'MAT-101-01' });
    pvaGradesEnvelopeSchema.parse(result.payload);
    assert.equal(result.payload.data.reachable, true);
    assert.equal(result.payload.data.total, '85.50');
    const items = result.payload.data.items;
    assert.equal(items.length, 3);
    assert.equal(items[0].isGradable, true, 'califica y todavía no tiene nota');
    assert.equal(items[1].isGradable, false, 'y este no califica: no está "pendiente", no va a tener nota nunca');
    assert.ok(unknownKinds(result).includes('pva_nota'), 'siempre se aclara que el aula no es el expediente');

    // Se puede nombrar la materia por id, como la nombraría un agente que ya
    // la vio en otra respuesta.
    assert.equal(call('get_pva_grades', { course: '800101' }).payload.data.courseId, 800101);
    assert.throws(() => call('get_pva_grades', { course: 'INEXISTENTE' }), /No encontré esa materia/);

    // ── El libro que el profesor ocultó ──
    markGradebookAccess(USER, 800101, { reachable: 0, errorcode: 'nopermissiontoviewgrades', now: NOW.getTime() });
    const oculto = call('get_pva_grades', { course: 'MAT-101-01' });
    assert.equal(oculto.payload.data.reachable, false);
    assert.equal(oculto.payload.data.items.length, 3, 'lo ya leído sigue estando: no se borra por no poder releerlo');
    assert.ok(
      unknownKinds(oculto).includes('pva_libro_oculto'),
      'y la respuesta dice que hay un hueco, en vez de contestar que no hay notas'
    );
    assert.match(
      oculto.payload.unknown.find((entry) => entry.kind === 'pva_libro_oculto').reason,
      /tarea por tarea/,
      'con la salida que sí existe: la nota se ve en la tarea'
    );
    markGradebookAccess(USER, 800101, { reachable: 1, errorcode: null, now: NOW.getTime() });
  }

  // ── Avisos ──
  {
    const result = call('get_pva_announcements');
    pvaAnnouncementsEnvelopeSchema.parse(result.payload);
    const items = result.payload.data.items;
    assert.equal(items.length, 2);
    const anuncio = items.find((item) => item.kind === 'anuncio');
    assert.ok(anuncio, 'el aviso de foro cuyo cmid resuelve a un foro news es el anuncio del profesor');
    assert.equal(anuncio.notificationId, 980002);
    const tarea = items.find((item) => item.kind === 'tarea_por_vencer');
    assert.equal(tarea.notificationId, 980001, 'y el de la tarea no se disfraza de anuncio');
    assert.ok(
      unknownKinds(result).includes('pva_anuncios'),
      'del anuncio se sabe que existe, no qué dice: eso se declara'
    );
  }

  // ── Contenido de una materia ──
  {
    const result = call('get_pva_section', { course: 'MAT-101-01' });
    pvaSectionsEnvelopeSchema.parse(result.payload);
    const sections = result.payload.data.sections;
    assert.equal(sections.length, 2);
    assert.equal(sections[1].modules.length, 0, 'la sección vacía se muestra vacía');
    const modules = sections[0].modules;
    assert.deepEqual(
      modules.map((module) => module.modname),
      ['assign', 'label', 'resource', 'forum', 'url'],
      'en el orden en que el profesor los puso'
    );
    const label = modules.find((module) => module.modname === 'label');
    assert.equal(label.inlineOnly, true, 'un label se pinta, no se abre: presentarlo como enlace lleva a un 404');
    assert.equal(label.url, null);
    assert.equal(modules[0].completion, 'hecho');
    assert.equal(modules.find((module) => module.cmid === 910005).completion, 'sin_seguimiento');
    assert.deepEqual(
      modules[0].dates.map((date) => date.kind),
      ['allowsubmissionsfromdate', 'duedate'],
      'las fechas van por su clave estable, no por la etiqueta traducida'
    );
    assert.ok(
      unknownKinds(result).includes('pva_archivos'),
      'del material que todavía no se bajó se sabe que existe, no qué dice adentro, y eso se declara'
    );

    // Una sección puntual.
    const una = call('get_pva_section', { course: 'MAT-101-01', section: 1 });
    assert.equal(una.payload.data.sections.length, 1);
    assert.equal(una.payload.data.sections[0].number, 1);

    // Los materiales cuelgan de su módulo, y un enlace externo NO es un
    // material: sale aparte para que nadie lo trate como descargable.
    const recurso = modules.find((module) => module.cmid === 910003);
    assert.equal(recurso.files.length, 1, 'el material cuelga de su módulo');
    assert.equal(recurso.files[0].filename, 'lectura-01.pdf');
    assert.equal(recurso.files[0].indexed, true, 'ese ya tiene texto buscable');
    assert.equal(recurso.files[0].declaredBytes > 0, true);

    const tarea = modules.find((module) => module.cmid === 910001);
    assert.equal(tarea.files[0].downloaded, false, 'el adjunto del enunciado todavía no se bajó, y se dice');
    assert.equal(tarea.files[0].indexed, false);
  }

  // ── Buscar dentro de los documentos ──
  {
    const result = call('search_pva_files', { query: 'integral' });
    pvaSearchEnvelopeSchema.parse(result.payload);
    assert.equal(result.payload.data.hits.length, 1);
    const hit = result.payload.data.hits[0];
    assert.equal(hit.filename, 'lectura-01.pdf');
    assert.equal(hit.courseShortname, 'MAT-101-01', 'con su materia, para no obligar a otra llamada');
    assert.ok(hit.moduleName, 'y el módulo donde vive');
    assert.match(hit.snippet, /«integral»/, 'con el fragmento donde aparece');

    assert.equal(call('search_pva_files', { query: 'funcion' }).payload.data.hits.length, 1, 'la búsqueda ignora acentos');
    assert.equal(
      call('search_pva_files', { query: 'integral continua' }).payload.data.hits.length,
      1,
      'dos palabras se piden las dos'
    );
    assert.equal(call('search_pva_files', { query: 'termodinamica' }).payload.data.hits.length, 0);

    // Sintaxis de FTS5 en la consulta del usuario: no puede reventar la
    // herramienta ni ejecutar operadores por accidente.
    for (const raro of ['"', 'a OR b', 'NEAR(', '- -', '*']) {
      const seguro = call('search_pva_files', { query: raro });
      pvaSearchEnvelopeSchema.parse(seguro.payload);
    }

    // Cero resultados no puede confundirse con cero materiales indexados.
    const vacio = call('search_pva_files', { query: 'termodinamica' });
    assert.equal(vacio.payload.data.corpus.indexed, 1);
    assert.ok(
      vacio.payload.unknown.some((entry) => entry.kind === 'pva_materiales_sin_bajar'),
      'lo que todavía no se bajó se declara: no está en la búsqueda'
    );
    assert.match(vacio.summary, /de 1 con texto buscable|indexado/, 'el resumen dice contra cuántos se buscó');
  }

  // ── Una sola semana: la entrega entra a la misma lista que las clases ──
  {
    const { READ_TOOLS: tools } = await import('../src/mcp/tools.js');
    const upcoming = tools.find((entry) => entry.name === 'get_upcoming').run({ horizonDays: 30, now: NOW });
    const items = upcoming.payload.data.items;
    const entregas = items.filter((item) => item.source === 'pva');
    assert.equal(entregas.length, 2, 'las entregas del aula viven en la misma agenda que las clases');
    assert.deepEqual(
      entregas.map((item) => item.kind).sort(),
      ['assign_due', 'forum_due'],
      'y un foro con fecha es una entrega más: mod_assign no lo reporta y vence igual'
    );

    const tarea = entregas.find((item) => item.kind === 'assign_due');
    assert.equal(tarea.allDay, false, 'una entrega tiene hora publicada: no es un evento de día completo');
    assert.equal(tarea.precision, 'datetime');
    assert.match(tarea.title, /MAT-101-01/, 'con su materia adelante, como las clases');

    // El id no lleva la fecha: si el profesor mueve la entrega, es la MISMA
    // entrega y quien consuma esto tiene que actualizarla, no duplicarla.
    assert.equal(/\d{4}-\d{2}-\d{2}/.test(tarea.id), false);
    assert.match(tarea.id, /^pva:/);

    // Lo ya entregado no es una tarea pendiente.
    assert.equal(
      entregas.some((item) => /Tarea de prueba$/.test(item.title)),
      false,
      'la que ya está entregada no aparece: quien consume esta lista crea tareas con ella'
    );

    // Y el orden es uno solo, por reloj, sin importar de qué plataforma salió.
    const fechas = items.map((item) => item.startsAt);
    assert.deepEqual(fechas, [...fechas].sort(), 'una sola línea de tiempo, ordenada');
  }

  // ── Nada identificatorio sale por ninguna de las siete ──
  {
    const nombres = READ_TOOLS.map((entry) => entry.name).filter((name) => /pva/.test(name));
    const args = {
      get_pva_grades: { course: 'MAT-101-01' },
      get_pva_section: { course: 'MAT-101-01' },
      get_pva_assignment: { assignmentId: 900001 },
      search_pva_files: { query: 'integral' },
    };
    const schemas = {
      search_pva_files: pvaSearchEnvelopeSchema,
      get_pva_courses: pvaCoursesEnvelopeSchema,
      get_pva_due: pvaDueEnvelopeSchema,
      get_pva_assignment: pvaAssignmentEnvelopeSchema,
      get_pva_grades: pvaGradesEnvelopeSchema,
      get_pva_announcements: pvaAnnouncementsEnvelopeSchema,
      get_pva_section: pvaSectionsEnvelopeSchema,
    };
    for (const name of nombres) {
      const payload = sanitize(call(name, args[name] ?? {}).payload);
      const texto = JSON.stringify(payload);
      assert.equal(texto.includes('llave-que-no-debe-salir'), false, `${name} no filtra la llave privada`);
      assert.equal(texto.includes('ab123456'), false, `${name} no filtra el usuario del portal`);
      assert.equal(/"moodleUserId"|"username"/.test(texto), false, `${name} no expone la identidad en Moodle`);
      // El servidor valida la respuesta DESPUÉS de sanitizarla: si la redacción
      // se llevara una clave del contrato, el cliente vería un error y esta
      // prueba, que valida el sobre crudo más arriba, no lo habría notado.
      schemas[name].parse(payload);
    }
  }

  // ── El glosario distingue las dos fuentes ──
  {
    assert.match(ABOUT_RESOURCE, /Dos fuentes/, 'el agente aprende que hay dos plataformas');
    assert.match(ABOUT_RESOURCE, /no tienen por qué coincidir/i, 'y que las notas no son la misma cosa');
    assert.match(ABOUT_RESOURCE, /La PVA \*\*no\*\* tiene horario/, 'y dónde NO buscar');
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

function porIdIncluye(result, kind) {
  return result.payload.unknown.some((entry) => entry.kind === kind);
}

console.log('✓ MCP de la PVA: siete herramientas con su contrato, el libro oculto se declara en vez de contestar cero, y la identidad no sale');
