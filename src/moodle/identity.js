import { db, logSync } from '../db.js';
import { callPva } from './session.js';
import { bool01, hashOf, int, nowSeconds, text, textOrNull } from './shape.js';

// Identidad y catálogo: la raíz de la que cuelga todo lo demás.
//
// `core_webservice_get_site_info` da el `moodle_userid` (parámetro obligatorio
// de casi todas las demás funciones), la `siteurl` con su subruta, los límites
// de subida y el catálogo de funciones. `tool_mobile_get_config` da la
// configuración del sitio.
//
// Dos cosas que este archivo hace a propósito y conviene no "arreglar":
//
//   1. `userprivateaccesskey` NO se guarda. Es una credencial: abre el
//      calendario y tokenpluginfile.php sin sesión. Serializar la respuesta
//      completa a la base o a un log la filtra, y es el error más fácil de
//      cometer de todo el dominio. Se descarta apenas llega.
//   2. El catálogo es del SERVICIO y del TOKEN, no del sitio: otro rol devuelve
//      otra lista. Por eso `pva_functions` va por usuario, y por eso el resto
//      del sync pregunta acá antes de programar una llamada: una función que no
//      está en la lista es una capacidad ausente, no un error.

const AREA_BY_PREFIX = [
  [/^core_webservice_|^core_user_|^tool_mobile_|^tool_policy_|^tool_dataprivacy_|^core_filters_|^core_ai_|^message_airnotifier_/, 'identidad'],
  [/^core_course_|^core_enrol_|^enrol_|^core_completion_|^core_courseformat_|^core_group_|^core_block_|^core_search_|^core_tag_/, 'cursos'],
  [/^mod_assign_/, 'tareas'],
  [/^gradereport_|^core_grade/, 'notas'],
  [/^core_calendar_/, 'calendario'],
  [/^mod_forum_/, 'foros'],
  [/^core_message_|^message_popup_|^core_notes_/, 'mensajes'],
  [/^core_files_|^core_h5p_/, 'archivos'],
];

// Las que mutan estado en la plataforma. No es una lista de permisos: es para
// que una herramienta de solo lectura pueda comprobar de un vistazo que no
// llamó ninguna. La escritura es de otra fase.
const WRITES = /^(mod_assign_(start_submission|save_submission|submit_for_grading|remove_submission)|mod_forum_(add_discussion|add_discussion_post|update_discussion_post|delete_post)|core_calendar_(create|delete)_calendar_events|core_message_(send_instant_messages|send_messages_to_conversation|mark_notification_read)|core_course_set_favourite_courses|core_user_(add_user_private_files|update_private_files|agree_site_policy)|core_completion_update_activity_completion_status_manually|mod_quiz_(start_attempt|save_attempt|process_attempt)|mod_choice_submit_choice_response)$/;

export function areaOf(name) {
  for (const [pattern, area] of AREA_BY_PREFIX) if (pattern.test(name)) return area;
  return 'modulos';
}

/**
 * El hash del catálogo: `name:version` ordenado. Mientras no cambie, las 438
 * filas no se vuelven a tocar. `functions[].version` es la del COMPONENTE, así
 * que un plugin de tercero mueve el hash sin que el sitio se haya actualizado.
 */
export function functionsHash(functions = []) {
  return hashOf(
    functions
      .map((fn) => `${fn.name}:${fn.version}`)
      .sort()
      .join('\n')
  );
}

// `userpictureurl` apunta a un placeholder público del tema cuando no hay foto,
// y a pluginfile.php cuando sí la hay. Pegarle el token al placeholder lo filtra
// a un recurso público; no pegárselo a la foto real devuelve 403.
function pictureNeedsToken(url) {
  return /\/webservice\/pluginfile\.php\//.test(String(url ?? '')) ? 1 : 0;
}

export function saveIdentity(userId, site, { now = Date.now() } = {}) {
  const hash = functionsHash(site.functions);
  const previous = db.prepare('SELECT functions_hash AS hash FROM pva_identity WHERE user_id = ?').get(userId);
  const stamp = nowSeconds(now);

  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO pva_identity (
         user_id, moodle_userid, username, firstname, lastname, fullname, siteurl, siteid, sitename,
         release, version, lang, theme, userpictureurl, picture_needs_token, mobilecssurl, userhomepage,
         downloadfiles, uploadfiles, usercanmanageownfiles, userquota, usermaxuploadfilesize,
         userissiteadmin, policyagreed, limitconcurrentlogins, usersessionscount,
         sitecalendartype, usercalendartype, functions_hash, fetched_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         moodle_userid = excluded.moodle_userid, username = excluded.username,
         firstname = excluded.firstname, lastname = excluded.lastname, fullname = excluded.fullname,
         siteurl = excluded.siteurl, siteid = excluded.siteid, sitename = excluded.sitename,
         release = excluded.release, version = excluded.version, lang = excluded.lang, theme = excluded.theme,
         userpictureurl = excluded.userpictureurl, picture_needs_token = excluded.picture_needs_token,
         mobilecssurl = excluded.mobilecssurl, userhomepage = excluded.userhomepage,
         downloadfiles = excluded.downloadfiles, uploadfiles = excluded.uploadfiles,
         usercanmanageownfiles = excluded.usercanmanageownfiles, userquota = excluded.userquota,
         usermaxuploadfilesize = excluded.usermaxuploadfilesize, userissiteadmin = excluded.userissiteadmin,
         policyagreed = excluded.policyagreed, limitconcurrentlogins = excluded.limitconcurrentlogins,
         usersessionscount = excluded.usersessionscount, sitecalendartype = excluded.sitecalendartype,
         usercalendartype = excluded.usercalendartype, functions_hash = excluded.functions_hash,
         fetched_at = datetime('now')`
    ).run(
      userId,
      int(site.userid),
      text(site.username),
      textOrNull(site.firstname),
      textOrNull(site.lastname),
      textOrNull(site.fullname),
      text(site.siteurl),
      int(site.siteid, 1),
      textOrNull(site.sitename),
      text(site.release),
      text(site.version),
      text(site.lang),
      textOrNull(site.theme),
      textOrNull(site.userpictureurl),
      pictureNeedsToken(site.userpictureurl),
      textOrNull(site.mobilecssurl),
      int(site.userhomepage),
      bool01(site.downloadfiles),
      bool01(site.uploadfiles),
      bool01(site.usercanmanageownfiles),
      int(site.userquota),
      int(site.usermaxuploadfilesize),
      bool01(site.userissiteadmin),
      bool01(site.policyagreed),
      int(site.limitconcurrentlogins),
      int(site.usersessionscount),
      textOrNull(site.sitecalendartype),
      textOrNull(site.usercalendartype),
      hash
    );

    // El catálogo solo se reescribe si cambió: son 438 filas y su contenido es
    // estable entre upgrades del sitio.
    if (previous?.hash !== hash) {
      const upsert = db.prepare(
        `INSERT INTO pva_functions (user_id, name, version, area, writes, first_seen_at, last_seen_at, gone_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'), NULL)
         ON CONFLICT(user_id, name) DO UPDATE SET
           version = excluded.version, area = excluded.area, writes = excluded.writes,
           last_seen_at = datetime('now'), gone_at = NULL`
      );
      const present = new Set();
      for (const fn of site.functions ?? []) {
        upsert.run(userId, fn.name, text(fn.version), areaOf(fn.name), WRITES.test(fn.name) ? 1 : 0);
        present.add(fn.name);
      }
      // Una función que dejó de venir tras un upgrade se marca, no se borra: la
      // rama del sync que la usaba tiene que poder decir desde cuándo no está.
      // Se compara contra el catálogo recién traído y no contra las marcas de
      // tiempo: dentro del mismo segundo todas las filas tienen la misma.
      const markGone = db.prepare(`UPDATE pva_functions SET gone_at = datetime('now') WHERE user_id = ? AND name = ?`);
      for (const row of db.prepare('SELECT name FROM pva_functions WHERE user_id = ? AND gone_at IS NULL').all(userId)) {
        if (!present.has(row.name)) markGone.run(userId, row.name);
      }
    }

    // Los interruptores globales del sitio viven con la config porque se leen
    // juntos: una función puede estar en el catálogo y aun así estar muerta
    // porque su feature está apagada.
    const feature = db.prepare(
      `INSERT INTO pva_site_config (source, name, value, is_numeric, fetched_at)
       VALUES ('advanced_feature', ?, ?, ?, datetime('now'))
       ON CONFLICT(source, name) DO UPDATE SET
         value = excluded.value, is_numeric = excluded.is_numeric, fetched_at = datetime('now')`
    );
    for (const entry of site.advancedfeatures ?? []) {
      feature.run(entry.name, String(entry.value), typeof entry.value === 'number' ? 1 : 0);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    moodleUserId: int(site.userid),
    functions: site.functions?.length ?? 0,
    catalogChanged: previous?.hash !== hash,
    firstSync: previous == null,
    siteVersion: text(site.version),
    fetchedAt: stamp,
  };
}

export function saveSiteConfig(settings = []) {
  const upsert = db.prepare(
    `INSERT INTO pva_site_config (source, name, value, is_numeric, fetched_at)
     VALUES ('mobile_config', ?, ?, ?, datetime('now'))
     ON CONFLICT(source, name) DO UPDATE SET
       value = excluded.value, is_numeric = excluded.is_numeric, fetched_at = datetime('now')`
  );
  db.exec('BEGIN');
  try {
    // `numsections` llega como number sin comillas mientras los otros 61 son
    // string: se guarda como texto y se recuerda cómo vino.
    for (const setting of settings) {
      upsert.run(setting.name, setting.value === null ? null : String(setting.value), typeof setting.value === 'number' ? 1 : 0);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return settings.length;
}

export async function syncIdentity(userId, { call = callPva, now = Date.now() } = {}) {
  const site = await call('core_webservice_get_site_info');
  const result = saveIdentity(userId, site, { now });
  logSync({
    userId,
    kind: 'pvaIdentity',
    status: 'ok',
    detail: `Moodle ${result.siteVersion} · ${result.functions} funciones`,
    rows: result.functions,
  });
  return result;
}

export async function syncSiteConfig({ call = callPva } = {}) {
  const config = await call('tool_mobile_get_config');
  const saved = saveSiteConfig(config.settings ?? []);
  logSync({ kind: 'pvaConfig', status: 'ok', detail: `${saved} ajuste(s)`, rows: saved });
  return { settings: saved };
}

export function readIdentity(userId) {
  return (
    db
      .prepare(
        `SELECT moodle_userid AS moodleUserId, username, siteurl AS siteUrl, release, version,
                lang, functions_hash AS functionsHash, fetched_at AS fetchedAt
         FROM pva_identity WHERE user_id = ?`
      )
      .get(userId) ?? null
  );
}

export function moodleUserId(userId) {
  return readIdentity(userId)?.moodleUserId ?? null;
}

/**
 * ¿Se puede llamar esta función con este token? Una respuesta negativa NO es un
 * error: es una capacidad ausente, y la rama del sync que la necesitaba se
 * salta sin contar como fallo.
 */
export function hasFunction(userId, name) {
  return Boolean(
    db.prepare('SELECT 1 FROM pva_functions WHERE user_id = ? AND name = ? AND gone_at IS NULL').get(userId, name)
  );
}

/** El valor de un ajuste del sitio, de cualquiera de las dos fuentes. */
export function siteSetting(name) {
  return (
    db
      .prepare(
        `SELECT value FROM pva_site_config WHERE name = ?
         ORDER BY CASE source WHEN 'mobile_config' THEN 0 ELSE 1 END LIMIT 1`
      )
      .get(name)?.value ?? null
  );
}

/** ¿El sitio dejó viva esta feature? Una función viva con su feature en 0 revienta. */
export function featureEnabled(name) {
  const row = db.prepare("SELECT value FROM pva_site_config WHERE source = 'advanced_feature' AND name = ?").get(name);
  return row ? row.value !== '0' : null;
}

// El sello de version es el disparador de invalidación global: si cambió, hubo
// upgrade del sitio y ningún parser puede darse por bueno sin volver a mirar.
// `release` no sirve para esto: es texto libre y ordena 5.1.10 antes que 5.1.5.
export function siteUpgraded(userId, version) {
  const current = readIdentity(userId);
  if (!current) return false;
  return int(current.version) !== int(version);
}
