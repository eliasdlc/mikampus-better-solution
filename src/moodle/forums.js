import { db, logSync } from '../db.js';
import { callPva } from './session.js';
import { moodleUserId } from './identity.js';
import { bool01, cmidFromUrl, int, nowSeconds, parseCustomData, text, textOrNull } from './shape.js';

// Foros y campanita. Dos fuentes que no se solapan: los mensajes directos
// viven en un tercer endpoint que esta fase no consume, porque no hay pantalla
// que los muestre y no generan avisos por decisión de producto.
//
// La regla de producto que gobierna este archivo: **silencio exigido**. Solo el
// foro de anuncios del profesor avisa; los demás foros y los mensajes directos
// no avisan nunca. Y el filtro NO puede ser "excluir mod_forum", porque el
// anuncio del profesor llega por ese mismo `component`: hay que resolver el cmid
// de la notificación contra la tabla de foros y mirar su `type`.
//
// Lo demás que el recon dejó claro y acá se respeta:
//
//   * `type` es el único discriminador confiable. El nombre del foro es
//     editable y dependiente del idioma: clasificar por "Avisos" se rompe.
//   * El foro de anuncios es opcional y frecuentemente no existe: de 3 cursos,
//     uno devolvió [], otro solo un `general`, y solo uno tenía el `news`.
//   * `forum.timemodified` es la fecha de la CONFIGURACIÓN, no del último
//     mensaje. Usarlo como "último anuncio" inventa actividad.
//   * `numdiscussions` es el contador barato de anuncios nuevos, pero solo sube
//     con discusiones nuevas: una edición o una respuesta no lo mueven.
//   * Un foro `general` con `duedate > 0` es una entrega con fecha que
//     `mod_assign` no reporta. El criterio es la fecha, no `scale`.
//   * La notificación trae dos ids del mismo objeto: el cmid en `contexturl` y
//     el id de instancia en `customdata.assignmentid`. Confundirlos hace join
//     contra la fila equivocada.

export function saveForums(userId, forums, { now = Date.now() } = {}) {
  const stamp = nowSeconds(now);
  const upsert = db.prepare(
    `INSERT INTO pva_forum (
       forum_id, user_id, course_id, cmid, type, name, intro_html, forcesubscribe, trackingtype,
       is_tracked, can_create_discussions, num_discussions, duedate, cutoffdate, scale, assessed,
       grade_forum, config_modified_at, fetched_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(forum_id) DO UPDATE SET
       course_id = excluded.course_id, cmid = excluded.cmid, type = excluded.type, name = excluded.name,
       intro_html = excluded.intro_html, forcesubscribe = excluded.forcesubscribe,
       trackingtype = excluded.trackingtype, is_tracked = excluded.is_tracked,
       can_create_discussions = excluded.can_create_discussions,
       num_discussions = excluded.num_discussions, duedate = excluded.duedate,
       cutoffdate = excluded.cutoffdate, scale = excluded.scale, assessed = excluded.assessed,
       grade_forum = excluded.grade_forum, config_modified_at = excluded.config_modified_at,
       fetched_at = excluded.fetched_at`
  );

  // Anuncios nuevos desde la última corrida, por el único contador que hay.
  const before = new Map(
    db
      .prepare("SELECT forum_id AS id, num_discussions AS n FROM pva_forum WHERE user_id = ? AND type = 'news'")
      .all(userId)
      .map((row) => [row.id, row.n])
  );

  const newAnnouncements = [];
  db.exec('BEGIN');
  try {
    for (const forum of forums) {
      const id = int(forum.id);
      const discussions = int(forum.numdiscussions, 0);
      upsert.run(
        id,
        userId,
        int(forum.course),
        int(forum.cmid),
        text(forum.type),
        text(forum.name),
        textOrNull(forum.intro),
        int(forum.forcesubscribe, 0),
        int(forum.trackingtype, 0),
        bool01(forum.istracked),
        bool01(forum.cancreatediscussions),
        discussions,
        // Acá NO se normaliza el 0 a NULL: la columna del mapa es NOT NULL con
        // default 0 y el 0 sigue significando "sin fecha".
        int(forum.duedate, 0),
        int(forum.cutoffdate, 0),
        int(forum.scale, 0),
        int(forum.assessed, 0),
        int(forum.grade_forum, 0),
        int(forum.timemodified, 0),
        stamp
      );
      if (text(forum.type) === 'news' && before.has(id) && discussions > before.get(id)) {
        newAnnouncements.push({ forumId: id, courseId: int(forum.course), added: discussions - before.get(id) });
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    forums: forums.length,
    announcements: forums.filter((forum) => text(forum.type) === 'news').length,
    newAnnouncements,
  };
}

export async function syncForums(userId, { call = callPva, courseIds, now = Date.now() } = {}) {
  if (!courseIds?.length) {
    logSync({ userId, kind: 'pvaForums', status: 'ok', detail: 'sin materias activas', rows: 0 });
    return { forums: 0, announcements: 0, newAnnouncements: [] };
  }
  const forums = await call('mod_forum_get_forums_by_courses', { courseids: courseIds });
  const result = saveForums(userId, forums, { now });
  logSync({
    userId,
    kind: 'pvaForums',
    status: 'ok',
    detail: `${result.forums} foro(s), ${result.announcements} de anuncios`,
    rows: result.forums,
  });
  return result;
}

export function announcementForums(userId) {
  return db
    .prepare(
      `SELECT forum_id AS forumId, course_id AS courseId, cmid, name, num_discussions AS numDiscussions
       FROM pva_forum WHERE user_id = ? AND type = 'news' ORDER BY course_id`
    )
    .all(userId);
}

/** Foros con fecha de entrega: son entregas reales que mod_assign no reporta. */
export function forumsWithDueDate(userId) {
  return db
    .prepare(
      `SELECT forum_id AS forumId, course_id AS courseId, cmid, name, duedate, cutoffdate
       FROM pva_forum WHERE user_id = ? AND duedate > 0 ORDER BY duedate`
    )
    .all(userId);
}

// ── La campanita ───────────────────────────────────────────────────────────

// El curso no viene en la notificación: se resuelve por el cmid del contexturl,
// primero contra los módulos y después contra los foros. Puede quedar sin
// resolver legítimamente (el cmid puede ser de un curso que no sincronizamos), y
// en ese caso el aviso igual se muestra con su contexturlname.
function resolveCourse(userId, cmid) {
  if (!cmid) return null;
  return (
    db.prepare('SELECT course_id AS courseId FROM pva_module WHERE user_id = ? AND cmid = ?').get(userId, cmid)?.courseId ??
    db.prepare('SELECT course_id AS courseId FROM pva_forum WHERE user_id = ? AND cmid = ?').get(userId, cmid)?.courseId ??
    null
  );
}

export function saveNotifications(userId, payload, { now = Date.now() } = {}) {
  const stamp = nowSeconds(now);
  const notifications = payload?.notifications ?? [];
  const upsert = db.prepare(
    `INSERT INTO pva_notification (
       notification_id, user_id, userid_from, component, eventtype, subject, small_message,
       full_message_html, contexturl, contexturl_name, cmid, course_id, customdata_raw, instance_id,
       customdata_duedate, icon_url, created_at, read_remote, read_at_remote, deleted_remote, fetched_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(notification_id) DO UPDATE SET
       course_id = COALESCE(excluded.course_id, pva_notification.course_id),
       read_remote = excluded.read_remote, read_at_remote = excluded.read_at_remote,
       deleted_remote = excluded.deleted_remote, fetched_at = excluded.fetched_at`
  );

  let inserted = 0;
  db.exec('BEGIN');
  try {
    for (const notification of notifications) {
      const id = int(notification.id);
      const known = db.prepare('SELECT 1 FROM pva_notification WHERE notification_id = ?').get(id);
      if (!known) inserted += 1;
      const cmid = cmidFromUrl(notification.contexturl);
      const custom = parseCustomData(notification.customdata);
      upsert.run(
        id,
        userId,
        // Puede ser NEGATIVO: -10 es el pseudo usuario de sistema. No es FK.
        int(notification.useridfrom, 0),
        text(notification.component),
        text(notification.eventtype),
        text(notification.subject),
        textOrNull(notification.smallmessage),
        textOrNull(notification.fullmessagehtml),
        textOrNull(notification.contexturl),
        textOrNull(notification.contexturlname),
        cmid,
        resolveCourse(userId, cmid),
        // Crudo: puede venir '' o null, y las dos son "no hay".
        textOrNull(notification.customdata),
        // customdata.assignmentid es el id de INSTANCIA, no el cmid.
        custom ? int(custom.assignmentid) : null,
        custom ? int(custom.duedate) : null,
        textOrNull(notification.iconurl),
        int(notification.timecreated, 0),
        // Estado COMPARTIDO con el portal web y la app oficial: sirve para
        // mostrar, nunca para decidir si ya se avisó.
        bool01(notification.read),
        int(notification.timeread),
        bool01(notification.deleted),
        stamp
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    // `unreadcount` es el total de no leídas, NO el largo del arreglo.
    unreadCount: int(payload?.unreadcount, 0),
    received: notifications.length,
    inserted,
    watermark: notifications.reduce((max, notification) => Math.max(max, int(notification.timecreated, 0)), 0),
  };
}

export async function syncNotifications(userId, { call = callPva, now = Date.now(), limit = 20 } = {}) {
  const useridto = moodleUserId(userId);
  if (!useridto) throw new Error('La PVA todavía no sabe quién sos: falta sincronizar la identidad');
  // El parámetro se llama useridto, no userid: es la única función del dominio
  // que lo nombra distinto.
  const payload = await call('message_popup_get_popup_notifications', { useridto, limit });
  const result = saveNotifications(userId, payload, { now });
  logSync({
    userId,
    kind: 'pvaNotifications',
    status: 'ok',
    detail: `${result.received} aviso(s), ${result.unreadCount} sin leer`,
    rows: result.received,
  });
  return result;
}

/**
 * ¿Esta notificación es un anuncio del profesor? Solo si su cmid resuelve a un
 * foro `type = 'news'`. Un foro cualquiera llega por el mismo `component` y no
 * puede avisar.
 */
export function isAnnouncement(userId, notification) {
  if (notification.component !== 'mod_forum') return false;
  const cmid = notification.cmid ?? cmidFromUrl(notification.contexturl);
  if (!cmid) return false;
  return Boolean(
    db.prepare("SELECT 1 FROM pva_forum WHERE user_id = ? AND cmid = ? AND type = 'news'").get(userId, cmid)
  );
}

export function readNotifications(userId, { limit = 50 } = {}) {
  return db
    .prepare(
      `SELECT notification_id AS notificationId, component, eventtype, subject,
              contexturl_name AS contextName, contexturl, cmid, course_id AS courseId,
              instance_id AS instanceId, customdata_duedate AS customDueDate,
              created_at AS createdAt, read_remote AS readRemote
       FROM pva_notification
       WHERE user_id = ? AND deleted_remote = 0
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(userId, limit);
}
