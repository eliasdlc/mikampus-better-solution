// El modelo de la PVA contra fixtures, sin red: identidad, catálogo, materias,
// el árbol del curso y el delta del servidor.
//
// Lo que se prueba es lo que el recon dejó documentado como trampa, porque es
// lo que se rompe solo: el label sin `url`, la sección vacía, el orden del
// array como único orden, el 0 que no es 1970, y el `configuration` del delta
// que trae la fecha y no es señal.
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-pva-model-'));
process.env.MIKAMPUS_DATA_DIR = dir;
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');

const { db } = await import('../src/db.js');
const { saveIdentity, saveSiteConfig, readIdentity, hasFunction, functionsHash, areaOf, siteSetting, featureEnabled, siteUpgraded } =
  await import('../src/moodle/identity.js');
const { saveCourses, activeCourses, saveCourseContents, courseTree, courseSyncState, readUpdateSignals, syncContents, contentsHash } =
  await import('../src/moodle/courses.js');

const fixture = async (name) => JSON.parse(await readFile(`fixtures/${name}`, 'utf8'));
const siteInfo = await fixture('pva-site-info.json');
const config = await fixture('pva-site-config.json');
const courses = await fixture('pva-courses.json');
const contents = await fixture('pva-contents.json');
const updates = await fixture('pva-updates-since.json');
const updatesEmpty = await fixture('pva-updates-since-vacio.json');

const USER = 1;

try {
  // ── Identidad: la raíz, sin la credencial disfrazada de dato ──
  {
    const withKey = { ...siteInfo, userprivateaccesskey: 'llave-privada-de-prueba' };
    const result = saveIdentity(USER, withKey);
    assert.equal(result.moodleUserId, 90001, 'de acá sale el userid que piden casi todas las funciones');
    assert.equal(result.firstSync, true);
    assert.equal(result.catalogChanged, true);

    const identity = readIdentity(USER);
    assert.equal(identity.siteUrl, 'https://campusvirtual.pucmm.edu.do/moodle', 'la base incluye la subruta');
    assert.equal(identity.version, '2025100605', 'el sello es lo único comparable; release es texto libre');

    // La regla más importante del dominio: esa llave abre el calendario y los
    // archivos sin sesión, así que no puede quedar en ninguna columna.
    const dump = JSON.stringify(db.prepare('SELECT * FROM pva_identity').all());
    assert.equal(dump.includes('llave-privada-de-prueba'), false, 'userprivateaccesskey no entra a la base');
    assert.equal(dump.includes('accesskey'), false, 'ni siquiera con otro nombre');
  }

  // ── El catálogo es del token: se guarda por usuario y con su área ──
  {
    assert.equal(hasFunction(USER, 'core_course_get_contents'), true);
    assert.equal(hasFunction(USER, 'mod_forum_get_forum_discussions'), false, 'lo que no está es capacidad ausente');
    assert.equal(areaOf('mod_assign_save_submission'), 'tareas');
    assert.equal(areaOf('local_algo_de_la_universidad'), 'modulos', 'lo desconocido cae en un área, no revienta');
    const writes = db.prepare('SELECT count(*) AS n FROM pva_functions WHERE user_id = ? AND writes = 1').get(USER).n;
    assert.equal(writes, 0, 'ninguna de las seis del fixture muta estado');

    // Segundo sync con el mismo catálogo: no cambia nada.
    const again = saveIdentity(USER, siteInfo);
    assert.equal(again.catalogChanged, false, 'el hash evita reescribir 438 filas por nada');

    // Un catálogo recortado marca la que ya no está, sin borrarla.
    saveIdentity(USER, { ...siteInfo, functions: siteInfo.functions.slice(0, 3) });
    const gone = db.prepare('SELECT name FROM pva_functions WHERE user_id = ? AND gone_at IS NOT NULL').all(USER);
    assert.equal(gone.length, 3, 'las que dejaron de venir se marcan');
    assert.equal(hasFunction(USER, gone[0].name), false, 'y dejan de contar como disponibles');
    saveIdentity(USER, siteInfo);
    assert.equal(hasFunction(USER, gone[0].name), true, 'si vuelven, vuelven: gone_at se limpia');
  }
  assert.notEqual(functionsHash(siteInfo.functions), functionsHash(siteInfo.functions.slice(1)), 'el hash distingue catálogos');
  assert.equal(siteUpgraded(USER, '2025100605'), false);
  assert.equal(siteUpgraded(USER, '2026010100'), true, 'un sello nuevo es un upgrade del sitio');

  // ── Configuración del sitio: el único valor numérico y los vacíos ──
  {
    saveSiteConfig(config.settings);
    assert.equal(siteSetting('timezone'), 'America/Santo_Domingo', 'la zona está impuesta al sitio');
    assert.equal(siteSetting('calendar_startwday'), '1', 'la semana arranca lunes');
    assert.equal(siteSetting('sitepolicy'), '', 'cadena vacía se conserva: no es lo mismo que ausente');
    const numeric = db.prepare("SELECT is_numeric AS n FROM pva_site_config WHERE name = 'numsections'").get();
    assert.equal(numeric.n, 1, 'numsections es el único que llega sin comillas, y se recuerda');
    assert.equal(featureEnabled('enableglobalsearch'), false, 'una feature apagada mata sus funciones aunque estén en el catálogo');
    assert.equal(featureEnabled('messaging'), true);
    assert.equal(featureEnabled('inventada'), null, 'lo que el sitio no declaró no es ni true ni false');
  }

  // ── Materias: hidden es el único filtro del ciclo ──
  {
    const result = saveCourses(USER, courses);
    assert.deepEqual(result, { total: 2, active: 1 }, 'la oculta no cuenta como del ciclo');
    const active = activeCourses(USER);
    assert.equal(active.length, 1);
    assert.equal(active[0].courseId, 800101);
    assert.equal(active[0].showGrades, 1, 'showgrades es la precondición del libro');

    const hidden = db.prepare('SELECT progress, completed, lang FROM pva_course WHERE course_id = 800202').get();
    assert.equal(hidden.progress, null, 'progress llega null en cursos sin seguimiento, y null se conserva');
    assert.equal(hidden.completed, null, 'completed es tri-estado');

    // Una materia que deja de venir se marca, no se borra.
    saveCourses(USER, [courses[0]]);
    const marked = db.prepare('SELECT missing_since FROM pva_course WHERE course_id = 800202').get();
    assert.ok(marked.missing_since > 0, 'la que no vino queda marcada');
    assert.equal(db.prepare('SELECT count(*) AS n FROM pva_course').get().n, 2, 'pero sigue en la base');
    saveCourses(USER, courses);
    assert.equal(db.prepare('SELECT missing_since FROM pva_course WHERE course_id = 800202').get().missing_since, null, 'y si vuelve, se desmarca');
  }

  // ── El árbol del curso ──
  {
    const saved = saveCourseContents(USER, 800101, contents);
    assert.deepEqual({ sections: saved.sections, modules: saved.modules }, { sections: 2, modules: 5 });

    const tree = courseTree(USER, 800101);
    assert.equal(tree.length, 2);
    assert.equal(tree[1].modules.length, 0, 'la sección vacía existe: es un curso con plantilla y sin contenido');
    assert.deepEqual(
      tree[0].modules.map((module) => module.modname),
      ['assign', 'label', 'resource', 'forum', 'url'],
      'el orden es el del array, que es el único orden que hay'
    );

    const label = tree[0].modules.find((module) => module.modname === 'label');
    assert.equal(label.url, null, 'el label es el único modname sin la clave url');
    assert.equal(label.noViewLink, 1, 'y no_view_link es el discriminador correcto, no la ausencia de url');

    const assign = tree[0].modules[0];
    assert.deepEqual(
      assign.dates.map((date) => date.dataId),
      ['allowsubmissionsfromdate', 'duedate'],
      'las fechas se identifican por data_id, nunca por la etiqueta, que viene traducida'
    );
    assert.equal(assign.completionState, 1);

    const sinCompletion = db.prepare('SELECT completion_rule, completion_state, completed_at FROM pva_module WHERE cmid = 910005').get();
    assert.equal(sinCompletion.completion_rule, 0);
    assert.equal(sinCompletion.completion_state, null, 'sin seguimiento no hay estado: la clave completiondata no viene');

    const descriptions = db.prepare('SELECT cmid, description_html FROM pva_module WHERE user_id = ? ORDER BY cmid').all(USER);
    assert.equal(descriptions.find((row) => row.cmid === 910004).description_html, null, 'clave ausente se guarda NULL');
    assert.ok(descriptions.find((row) => row.cmid === 910001).description_html.includes('<p'), 'y el HTML crudo se conserva');

    const customdata = db.prepare('SELECT customdata_json FROM pva_module WHERE cmid = 910003').get().customdata_json;
    assert.ok(customdata.includes('printintro'), 'customdata se guarda crudo: adentro hay PHP serializado');
  }

  // ── Delta local: el mismo árbol no reescribe nada ──
  {
    const before = courseSyncState(USER, 800101);
    assert.equal(before.hashTree, contentsHash(contents));
    const updatedBefore = db.prepare('SELECT updated_at FROM pva_module WHERE cmid = 910001').get().updated_at;
    saveCourseContents(USER, 800101, contents, { now: Date.now() + 60_000 });
    const updatedAfter = db.prepare('SELECT updated_at FROM pva_module WHERE cmid = 910001').get().updated_at;
    assert.equal(updatedAfter, updatedBefore, 'un módulo sin cambios no mueve su updated_at');
  }

  // ── Un módulo que desaparece se filtra, no se borra ──
  {
    const recortado = [{ ...contents[0], modules: contents[0].modules.slice(0, 2) }, contents[1]];
    saveCourseContents(USER, 800101, recortado, { now: Date.now() + 120_000 });
    assert.equal(courseTree(USER, 800101)[0].modules.length, 2, 'la vista solo muestra lo de la última corrida');
    assert.equal(db.prepare('SELECT count(*) AS n FROM pva_module WHERE user_id = ?').get(USER).n, 5, 'y los otros tres siguen en la base');
    saveCourseContents(USER, 800101, contents, { now: Date.now() + 180_000 });
    assert.equal(courseTree(USER, 800101)[0].modules.length, 5, 'si el profesor reabre la sección, vuelven');
  }

  // ── El delta del servidor ──
  {
    const señales = readUpdateSignals(updates);
    assert.deepEqual(señales.changed, [910001], 'solo cuenta el módulo con una señal que no sea configuration');
    assert.equal(señales.newestConfigAt, 1771500000, 'y configuration se conserva por su fecha, que es la única que hay');
    assert.deepEqual(readUpdateSignals(updatesEmpty), { changed: [], newestConfigAt: null }, 'vacío es una respuesta válida, no una función capada');
    // Un payload donde SOLO hay configuration: es el 100% de los módulos, así
    // que tratarlo como señal anularía el delta entero.
    assert.deepEqual(
      readUpdateSignals({ instances: [{ contextlevel: 'module', id: 910003, updates: [{ name: 'configuration', timeupdated: 1 }] }] }).changed,
      [],
      'configuration solo no es cambio'
    );
  }

  // ── syncContents: pide el delta y solo baja lo que cambió ──
  {
    const calls = [];
    const now = Date.now() + 240_000;
    const call = (updatesPayload) => async (fn) => {
      calls.push(fn);
      if (fn === 'core_course_get_updates_since') return updatesPayload;
      if (fn === 'core_course_get_contents') return contents;
      throw new Error(`llamada inesperada: ${fn}`);
    };

    // Sin cursor guardado no hay delta que pedir: el primer sync baja el árbol.
    const primero = await syncContents(USER, { call: call(updatesEmpty), now });
    assert.equal(primero.fetched, 1, 'la primera vez se baja entero');
    assert.deepEqual(calls, ['core_course_get_contents'], 'y ni se molesta en preguntar el delta');
    const cursor = courseSyncState(USER, 800101).serverSince;
    assert.ok(cursor > 0 && cursor <= Math.floor(now / 1000) - 60, 'el cursor avanza con el reloj de la petición menos el margen');

    // Con cursor y sin señal, la llamada cara no se hace.
    calls.length = 0;
    const sinSeñal = await syncContents(USER, { call: call(updatesEmpty), now: now + 60_000 });
    assert.equal(sinSeñal.skipped, 1, 'sin señal no se baja el árbol');
    assert.equal(sinSeñal.fetched, 0);
    assert.deepEqual(calls, ['core_course_get_updates_since'], 'una sola llamada, la barata');

    calls.length = 0;
    const conSeñal = await syncContents(USER, { call: call(updates), now: now + 120_000 });
    assert.equal(conSeñal.fetched, 1, 'con señal sí se baja');
    assert.deepEqual(calls, ['core_course_get_updates_since', 'core_course_get_contents']);
  }

  // ── Un curso que falla no aborta el ciclo ──
  {
    saveCourses(USER, [courses[0], { ...courses[1], hidden: false, id: 800303, shortname: 'MAT-303-01' }]);
    const result = await syncContents(USER, {
      call: async (fn, args) => {
        if (args.courseid === 800303) throw new Error('nopermission en ese curso');
        return fn === 'core_course_get_updates_since' ? updates : contents;
      },
      now: Date.now() + 400_000,
    });
    assert.equal(result.failed, 1);
    assert.equal(result.fetched, 1, 'la materia sana se sincronizó igual');
    assert.match(courseSyncState(USER, 800303).lastError, /nopermission/, 'y el motivo queda en su propia fila');
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ modelo de la PVA: identidad sin la llave privada, catálogo por token, árbol con su orden, delta que no borra');
