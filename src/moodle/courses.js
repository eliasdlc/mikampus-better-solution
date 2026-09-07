import { db, logSync } from '../db.js';
import { callPva } from './session.js';
import { moodleUserId } from './identity.js';
import { bool01, epoch, hashOf, int, nowSeconds, real, text, textOrNull } from './shape.js';
import { harvestCourseFiles } from './files.js';

// Materias, secciones y módulos: la columna vertebral del dominio.
//
// `core_enrol_get_users_courses` da la matrícula entera (incluidos los ciclos
// viejos) y `core_course_get_contents` arma el árbol completo de un curso en una
// sola llamada. Las decisiones que este archivo hereda del mapa:
//
//   1. El conjunto activo se filtra SOLO por `hidden`. Agregarle la ventana
//      startdate/enddate baja de 12 materias a 4 y deja fuera materias con
//      contenido reciente y entregas sin corregir.
//   2. Ni las secciones ni los módulos traen campo de orden: el único orden es
//      el del array, y por eso se guarda `sort_index`. Guardar en un map y
//      después iterar pierde cómo se ve el curso.
//   3. `sections[].section` es la POSICIÓN y cambia si el profesor reordena;
//      la identidad es `sections[].id`. Para un módulo la identidad es el cmid.
//   4. Nada se borra. Lo que deja de venir conserva su `seen_at` viejo y se
//      filtra al leer: un cmid puede volver cuando el profesor reabre una
//      sección, y borrar en duro se lleva el historial local por delante.
//   5. `timemodified` del curso NO es un watermark: el contenido es más nuevo
//      que ese campo. El delta sale de `core_course_get_updates_since`.

// ── Matrícula ──────────────────────────────────────────────────────────────

export function saveCourses(userId, courses, { now = Date.now() } = {}) {
  const stamp = nowSeconds(now);
  const upsert = db.prepare(
    `INSERT INTO pva_course (
       course_id, user_id, shortname, fullname, displayname, idnumber, category_id,
       summary_html, summary_format, format, lang, startdate, enddate, visible, hidden,
       show_grades, enable_completion, completion_tracked, progress, completed, last_access,
       enrolled_users, is_favourite, remote_timemodified, first_seen_at, last_seen_at, missing_since
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(user_id, course_id) DO UPDATE SET
       shortname = excluded.shortname, fullname = excluded.fullname, displayname = excluded.displayname,
       idnumber = excluded.idnumber, category_id = excluded.category_id, summary_html = excluded.summary_html,
       summary_format = excluded.summary_format, format = excluded.format, lang = excluded.lang,
       startdate = excluded.startdate, enddate = excluded.enddate, visible = excluded.visible,
       hidden = excluded.hidden, show_grades = excluded.show_grades,
       enable_completion = excluded.enable_completion, completion_tracked = excluded.completion_tracked,
       progress = excluded.progress, completed = excluded.completed, last_access = excluded.last_access,
       enrolled_users = excluded.enrolled_users, is_favourite = excluded.is_favourite,
       remote_timemodified = excluded.remote_timemodified, last_seen_at = excluded.last_seen_at,
       missing_since = NULL`
  );

  db.exec('BEGIN');
  try {
    const present = new Set();
    for (const course of courses) {
      const id = int(course.id);
      present.add(id);
      upsert.run(
        id,
        userId,
        text(course.shortname),
        text(course.fullname),
        textOrNull(course.displayname),
        textOrNull(course.idnumber),
        int(course.category),
        text(course.summary),
        int(course.summaryformat, 1),
        textOrNull(course.format),
        text(course.lang),
        epoch(course.startdate),
        epoch(course.enddate),
        bool01(course.visible, 1),
        bool01(course.hidden),
        bool01(course.showgrades, 1),
        bool01(course.enablecompletion),
        bool01(course.completionusertracked),
        real(course.progress),
        course.completed === null || course.completed === undefined ? null : bool01(course.completed),
        epoch(course.lastaccess),
        int(course.enrolledusercount),
        bool01(course.isfavourite),
        epoch(course.timemodified),
        stamp,
        stamp
      );
    }
    // Una materia que deja de venir se marca. Puede ser una baja, pero también
    // una matrícula que el sistema todavía no reflejó: el dato viejo sigue
    // siendo el mejor que hay.
    const mark = db.prepare('UPDATE pva_course SET missing_since = ? WHERE user_id = ? AND course_id = ? AND missing_since IS NULL');
    for (const row of db.prepare('SELECT course_id AS id FROM pva_course WHERE user_id = ? AND missing_since IS NULL').all(userId)) {
      if (!present.has(row.id)) mark.run(stamp, userId, row.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const active = courses.filter((course) => bool01(course.hidden) === 0).length;
  return { total: courses.length, active };
}

export async function syncCourses(userId, { call = callPva, now = Date.now() } = {}) {
  const userid = moodleUserId(userId);
  if (!userid) throw new Error('La PVA todavía no sabe quién sos: falta sincronizar la identidad');
  const courses = await call('core_enrol_get_users_courses', { userid });
  const result = saveCourses(userId, courses, { now });
  logSync({
    userId,
    kind: 'pvaCourses',
    status: 'ok',
    detail: `${result.active} materia(s) del ciclo de ${result.total} matriculadas`,
    rows: result.total,
  });
  return result;
}

/**
 * Las materias del ciclo. `hidden` es el único filtro: la ventana de fechas
 * deja fuera materias activas (MAPA §"Cuál es el conjunto activo").
 */
export function activeCourses(userId) {
  return db
    .prepare(
      `SELECT course_id AS courseId, shortname, fullname, show_grades AS showGrades, format, lang
       FROM pva_course
       WHERE user_id = ? AND hidden = 0 AND missing_since IS NULL
       ORDER BY shortname`
    )
    .all(userId);
}

// ── El árbol de un curso ───────────────────────────────────────────────────

// El hash de un módulo cubre lo que la UI muestra, no la respuesta entera: así
// un cambio de icono por purga de caché del tema no cuenta como cambio.
function moduleHash(module) {
  return hashOf({
    name: module.name,
    url: module.url ?? null,
    description: Object.hasOwn(module, 'description') ? module.description : null,
    visible: module.visible,
    uservisible: module.uservisible,
    completion: module.completion,
    state: module.completiondata?.state ?? null,
    dates: (module.dates ?? []).map((date) => [date.dataid, date.timestamp]),
    customdata: module.customdata ?? null,
    contents: (module.contents ?? []).map((file) => [file.filename, file.filesize, file.timemodified]),
  });
}

export function contentsHash(sections) {
  return hashOf(
    sections.map((section) => [section.id, section.section, section.name, section.summary, (section.modules ?? []).map(moduleHash)])
  );
}

export function saveCourseContents(userId, courseId, sections, { now = Date.now() } = {}) {
  const stamp = new Date(now).toISOString();
  const hash = contentsHash(sections);

  const upsertSection = db.prepare(
    `INSERT INTO pva_course_section (
       section_id, user_id, course_id, section_number, name, summary_html, summary_format,
       visible, uservisible, hidden_by_numsecs, component, item_id, sort_index, seen_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(section_id) DO UPDATE SET
       course_id = excluded.course_id, section_number = excluded.section_number, name = excluded.name,
       summary_html = excluded.summary_html, summary_format = excluded.summary_format,
       visible = excluded.visible, uservisible = excluded.uservisible,
       hidden_by_numsecs = excluded.hidden_by_numsecs, component = excluded.component,
       item_id = excluded.item_id, sort_index = excluded.sort_index, seen_at = excluded.seen_at,
       updated_at = excluded.updated_at`
  );
  const upsertModule = db.prepare(
    `INSERT INTO pva_module (
       cmid, user_id, course_id, section_id, sort_index, modname, instance, context_id, name, url,
       description_html, visible, uservisible, visible_on_page, no_view_link, can_display, purpose,
       indent, group_mode, download_content, icon_url, completion_rule, completion_state, completed_at,
       completion_override_by, completion_automatic, completion_tracked, customdata_json, content_hash,
       seen_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cmid) DO UPDATE SET
       course_id = excluded.course_id, section_id = excluded.section_id, sort_index = excluded.sort_index,
       modname = excluded.modname, instance = excluded.instance, context_id = excluded.context_id,
       name = excluded.name, url = excluded.url, description_html = excluded.description_html,
       visible = excluded.visible, uservisible = excluded.uservisible,
       visible_on_page = excluded.visible_on_page, no_view_link = excluded.no_view_link,
       can_display = excluded.can_display, purpose = excluded.purpose, indent = excluded.indent,
       group_mode = excluded.group_mode, download_content = excluded.download_content,
       icon_url = excluded.icon_url, completion_rule = excluded.completion_rule,
       completion_state = excluded.completion_state, completed_at = excluded.completed_at,
       completion_override_by = excluded.completion_override_by,
       completion_automatic = excluded.completion_automatic,
       completion_tracked = excluded.completion_tracked, customdata_json = excluded.customdata_json,
       content_hash = excluded.content_hash, seen_at = excluded.seen_at,
       updated_at = CASE WHEN pva_module.content_hash IS excluded.content_hash
                         THEN pva_module.updated_at ELSE excluded.updated_at END`
  );
  const upsertDate = db.prepare(
    `INSERT INTO pva_module_date (cmid, data_id, ts, label, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(cmid, data_id) DO UPDATE SET ts = excluded.ts, label = excluded.label, updated_at = excluded.updated_at`
  );
  const dropDates = db.prepare(`DELETE FROM pva_module_date WHERE cmid = ? AND data_id NOT IN (SELECT value FROM json_each(?))`);

  let moduleCount = 0;
  db.exec('BEGIN');
  try {
    sections.forEach((section, sectionIndex) => {
      upsertSection.run(
        int(section.id),
        userId,
        courseId,
        int(section.section, 0),
        text(section.name),
        text(section.summary),
        int(section.summaryformat, 1),
        bool01(section.visible, 1),
        bool01(section.uservisible, 1),
        bool01(section.hiddenbynumsections),
        textOrNull(section.component),
        int(section.itemid),
        sectionIndex,
        stamp,
        stamp
      );

      (section.modules ?? []).forEach((module, moduleIndex) => {
        const completion = module.completiondata ?? null;
        upsertModule.run(
          int(module.id),
          userId,
          courseId,
          int(section.id),
          moduleIndex,
          text(module.modname),
          int(module.instance, 0),
          int(module.contextid, 0),
          text(module.name),
          // La clave `url` no existe en los label, y es el único modname sin
          // ella. Quien decide si un módulo se abre mira `no_view_link`.
          textOrNull(module.url),
          // Ausente y vacía son estados distintos: 99 módulos no traen la clave
          // y uno la trae vacía.
          Object.hasOwn(module, 'description') ? text(module.description) : null,
          bool01(module.visible, 1),
          bool01(module.uservisible, 1),
          bool01(module.visibleoncoursepage, 1),
          bool01(module.noviewlink),
          bool01(module.candisplay, 1),
          textOrNull(module.purpose),
          int(module.indent, 0),
          int(module.groupmode, 0),
          int(module.downloadcontent, 1),
          textOrNull(module.modicon),
          bool01(module.completion),
          completion ? int(completion.state, 0) : null,
          completion ? epoch(completion.timecompleted) : null,
          completion ? int(completion.overrideby) : null,
          completion ? bool01(completion.isautomatic) : null,
          completion ? bool01(completion.istrackeduser) : null,
          // Crudo a propósito: adentro conviven tipos distintos para el mismo
          // campo y un valor serializado por PHP. Normalizarlo sería inventar.
          textOrNull(module.customdata),
          moduleHash(module),
          stamp,
          stamp
        );
        const dates = module.dates ?? [];
        for (const date of dates) {
          upsertDate.run(int(module.id), text(date.dataid), int(date.timestamp, 0), textOrNull(date.label), stamp);
        }
        dropDates.run(int(module.id), JSON.stringify(dates.map((date) => text(date.dataid))));
        moduleCount += 1;
      });
    });

    db.prepare(
      `INSERT INTO pva_course_sync (user_id, course_id, contents_at, hash_tree, sections, modules, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, datetime('now'))
       ON CONFLICT(user_id, course_id) DO UPDATE SET
         contents_at = excluded.contents_at, hash_tree = excluded.hash_tree,
         sections = excluded.sections, modules = excluded.modules, last_error = NULL,
         updated_at = datetime('now')`
    ).run(userId, courseId, stamp, hash, sections.length, moduleCount);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Los archivos se anotan acá porque acá está el payload: `contents[]` solo
  // viene dentro del árbol y no hay ninguna función que los liste aparte.
  // Anotar no es bajar: la descarga decide después, con presupuesto.
  const harvested = harvestCourseFiles(userId, courseId, sections, { now });

  return { sections: sections.length, modules: moduleCount, hash, stamp, ...harvested };
}

export async function syncCourseContents(userId, courseId, { call = callPva, now = Date.now() } = {}) {
  const sections = await call('core_course_get_contents', { courseid: courseId });
  const previous = db
    .prepare('SELECT hash_tree AS hash FROM pva_course_sync WHERE user_id = ? AND course_id = ?')
    .get(userId, courseId);
  const hash = contentsHash(sections);
  // El árbol entero se descarta sin recorrerlo cuando el hash coincide, pero la
  // marca de tiempo igual avanza: el curso se consultó y está al día.
  if (previous?.hash === hash) {
    db.prepare(
      `UPDATE pva_course_sync SET contents_at = ?, last_error = NULL, updated_at = datetime('now')
       WHERE user_id = ? AND course_id = ?`
    ).run(new Date(now).toISOString(), userId, courseId);
    return { sections: sections.length, modules: null, unchanged: true };
  }
  return { ...saveCourseContents(userId, courseId, sections, { now }), unchanged: false };
}

// ── Delta de servidor ──────────────────────────────────────────────────────

/**
 * ¿Qué dice `core_course_get_updates_since` que cambió?
 *
 * La trampa está documentada: `configuration` aparece en el 100% de los módulos
 * y es el único update que trae `timeupdated`. Tratarlo como señal anula el
 * delta entero, así que se descarta como señal y se conserva solo como fecha.
 * Los updates que sí son señal (contentfiles, introfiles, completion, grades,
 * submissions, discussions...) no traen ninguna fecha.
 */
export function readUpdateSignals(payload) {
  const cmids = new Set();
  let newestConfig = null;
  for (const instance of payload?.instances ?? []) {
    for (const update of instance.updates ?? []) {
      if (update.name === 'configuration') {
        const ts = epoch(update.timeupdated);
        if (ts && (newestConfig == null || ts > newestConfig)) newestConfig = ts;
        continue;
      }
      cmids.add(int(instance.id));
    }
  }
  return { changed: [...cmids], newestConfigAt: newestConfig };
}

/**
 * Sincroniza el contenido de las materias activas gastando lo mínimo: pregunta
 * el delta y solo baja el árbol de los cursos que el servidor marcó. Un curso
 * sin cursor guardado se baja entero, que es su primer sync.
 *
 * El cursor se avanza con el reloj de la petición menos 60 s de margen: NO se
 * puede derivar del payload, porque los updates que sirven de señal no traen
 * fecha (MAPA §"Delta, capa por capa", punto 6).
 */
export async function syncContents(userId, { call = callPva, now = Date.now(), courses } = {}) {
  const list = courses ?? activeCourses(userId);
  const cursor = db.prepare('SELECT server_since AS since FROM pva_course_sync WHERE user_id = ? AND course_id = ?');
  const saveCursor = db.prepare(
    `INSERT INTO pva_course_sync (user_id, course_id, server_since, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, course_id) DO UPDATE SET server_since = excluded.server_since, updated_at = datetime('now')`
  );
  const saveError = db.prepare(
    `INSERT INTO pva_course_sync (user_id, course_id, last_error, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, course_id) DO UPDATE SET last_error = excluded.last_error, updated_at = datetime('now')`
  );

  const summary = { checked: 0, fetched: 0, skipped: 0, failed: 0, modules: 0 };
  for (const course of list) {
    summary.checked += 1;
    const since = cursor.get(userId, course.courseId)?.since ?? null;
    const requestedAt = nowSeconds(now);
    try {
      let fetch = since == null;
      if (!fetch) {
        const updates = await call('core_course_get_updates_since', { courseid: course.courseId, since });
        fetch = readUpdateSignals(updates).changed.length > 0;
      }
      if (!fetch) {
        summary.skipped += 1;
        saveCursor.run(userId, course.courseId, requestedAt - 60);
        continue;
      }
      const result = await syncCourseContents(userId, course.courseId, { call, now });
      summary.fetched += 1;
      summary.modules += result.modules ?? 0;
      saveCursor.run(userId, course.courseId, requestedAt - 60);
    } catch (err) {
      // Un curso que falla no aborta el ciclo: el resto de la matrícula se
      // sincroniza igual y el motivo queda escrito en su propia fila.
      summary.failed += 1;
      saveError.run(userId, course.courseId, err.message);
    }
  }

  logSync({
    userId,
    kind: 'pvaContents',
    status: summary.failed && !summary.fetched ? 'error' : 'ok',
    detail: `${summary.fetched} bajado(s), ${summary.skipped} sin cambios, ${summary.failed} con error`,
    rows: summary.modules,
  });
  return summary;
}

// ── Lectura ────────────────────────────────────────────────────────────────

/**
 * El árbol como lo ve el estudiante: solo lo que vino en la última corrida.
 * Lo que dejó de venir queda en la base con su `seen_at` viejo y no se pinta.
 */
export function courseTree(userId, courseId) {
  const sync = db
    .prepare('SELECT contents_at AS contentsAt FROM pva_course_sync WHERE user_id = ? AND course_id = ?')
    .get(userId, courseId);
  if (!sync?.contentsAt) return [];
  const sections = db
    .prepare(
      `SELECT section_id AS sectionId, section_number AS sectionNumber, name, summary_html AS summaryHtml, sort_index AS sortIndex
       FROM pva_course_section
       WHERE user_id = ? AND course_id = ? AND seen_at = ?
       ORDER BY sort_index`
    )
    .all(userId, courseId, sync.contentsAt);
  const modules = db.prepare(
    `SELECT cmid, modname, instance, name, url, no_view_link AS noViewLink, purpose,
            completion_rule AS completionRule, completion_state AS completionState, sort_index AS sortIndex
     FROM pva_module
     WHERE user_id = ? AND section_id = ? AND seen_at = ?
     ORDER BY sort_index`
  );
  const dates = db.prepare('SELECT data_id AS dataId, ts, label FROM pva_module_date WHERE cmid = ? ORDER BY data_id');
  return sections.map((section) => ({
    ...section,
    modules: modules.all(userId, section.sectionId, sync.contentsAt).map((module) => ({
      ...module,
      dates: dates.all(module.cmid),
    })),
  }));
}

export function courseSyncState(userId, courseId) {
  return (
    db
      .prepare(
        `SELECT contents_at AS contentsAt, server_since AS serverSince, hash_tree AS hashTree,
                sections, modules, last_error AS lastError
         FROM pva_course_sync WHERE user_id = ? AND course_id = ?`
      )
      .get(userId, courseId) ?? null
  );
}
