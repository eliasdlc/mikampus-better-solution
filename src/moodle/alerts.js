import { db } from '../db.js';
import { readMetaJson, writeMetaJson } from '../appMeta.js';
import { cmidFromUrl, int, nowSeconds, text } from './shape.js';

// Los cuatro avisos del aula, y el libro que impide avisar dos veces.
//
// Cada uno tiene un disparo distinto porque la plataforma no ofrece el mismo
// para todos (MAPA §"Qué disparo tiene cada aviso"):
//
//   tarea por vencer   directo de la campanita (eventtype assign_due_soon).
//                      Es el único que Moodle avisa por su cuenta.
//   tarea nueva        SOLO diff. No existe notificación de creación en Moodle:
//                      esperarla es quedarse mudo para siempre.
//   nota publicada     diff sobre el libro, con la bitácora que ya escribe el
//                      sync de notas.
//   anuncio            híbrido: la notificación de mod_forum llega rápido pero
//                      depende de las preferencias del usuario y de
//                      forcesubscribe, así que el contador de discusiones del
//                      foro es un respaldo obligatorio, no un lujo.
//   material nuevo     SOLO diff, igual que la tarea nueva y por la misma
//                      razón: Moodle no avisa de un recurso subido. Sale del
//                      árbol del curso, que ya se sincroniza entero.
//
// Dos reglas duras:
//
//   * SILENCIO. Un foro que no sea el de anuncios y un mensaje directo no
//     avisan nunca. Y el filtro no puede ser "excluir mod_forum", porque el
//     anuncio del profesor llega por ese mismo component: hay que resolver el
//     cmid contra la tabla de foros y mirar su type.
//   * IDEMPOTENCIA por el objeto de Moodle, no por la notificación. `read` y
//     `timeread` son estado compartido con el portal web, así que no dicen nada
//     sobre si la app ya avisó: eso solo lo dice `delivered_at`.
//
// Nacen apagados. La preferencia vive en app_meta y hasta que alguien la
// encienda, los avisos se DETECTAN y se guardan igual: así el día que se
// enciende no llega de golpe el semestre entero, porque lo viejo ya está
// asentado y entregado en seco.

const PREFS_KEY = 'pva.alerts';
export const ALERT_KINDS = ['tarea_nueva', 'tarea_por_vencer', 'nota_publicada', 'anuncio', 'material_nuevo'];

export function alertPrefs() {
  const stored = readMetaJson(PREFS_KEY, null);
  return {
    enabled: stored?.enabled === true,
    kinds: Object.fromEntries(ALERT_KINDS.map((kind) => [kind, stored?.kinds?.[kind] !== false])),
  };
}

export function setAlertPrefs({ enabled, kinds } = {}) {
  const current = alertPrefs();
  return writeMetaJson(PREFS_KEY, {
    enabled: enabled === undefined ? current.enabled : Boolean(enabled),
    kinds: { ...current.kinds, ...(kinds ?? {}) },
  });
}

// ── El libro ───────────────────────────────────────────────────────────────

/**
 * Asienta un aviso. `INSERT OR IGNORE` sobre (usuario, tipo, objeto): el mismo
 * hecho detectado por dos caminos (la campanita y el diff) entra una sola vez,
 * que es justo lo que el disparo híbrido de los anuncios necesita.
 */
export function recordAlert(userId, { kind, source, subjectKey, title, url = null, courseId = null, notificationId = null, occurredAt, now = Date.now() }) {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO pva_alert
         (user_id, kind, source, subject_key, notification_id, course_id, title, url, occurred_at, created_at, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .run(userId, kind, source, subjectKey, notificationId, courseId, text(title), url, int(occurredAt, nowSeconds(now)), nowSeconds(now));
  return info.changes > 0;
}

export function pendingAlerts(userId) {
  return db
    .prepare(
      `SELECT alert_id AS alertId, kind, source, subject_key AS subjectKey, course_id AS courseId,
              title, url, occurred_at AS occurredAt
       FROM pva_alert
       WHERE user_id = ? AND delivered_at IS NULL
       ORDER BY occurred_at DESC`
    )
    .all(userId);
}

export function readAlerts(userId, { limit = 50 } = {}) {
  return db
    .prepare(
      `SELECT alert_id AS alertId, kind, source, title, url, course_id AS courseId,
              occurred_at AS occurredAt, delivered_at AS deliveredAt
       FROM pva_alert WHERE user_id = ? ORDER BY occurred_at DESC LIMIT ?`
    )
    .all(userId, limit);
}

// ── Los cuatro disparos ────────────────────────────────────────────────────

/**
 * Tarea nueva. `created` son los ids que no estaban antes, y `seeded` dice si
 * era la primera vez que se veían tareas de ese usuario: el primer sync siembra
 * y no avisa, o el día que alguien enciende la app le llega el semestre entero.
 */
export function recordNewAssignments(userId, { created = [], seeded = false, now = Date.now() } = {}) {
  if (seeded || !created.length) return 0;
  const rows = db
    .prepare(
      `SELECT a.assignment_id AS assignmentId, a.name, a.course_id AS courseId, a.cmid, a.duedate,
              c.shortname AS courseShortname
       FROM pva_assignment a
       LEFT JOIN pva_course c ON c.user_id = a.user_id AND c.course_id = a.course_id
       WHERE a.user_id = ? AND a.assignment_id IN (${created.map(() => '?').join(', ')})`
    )
    .all(userId, ...created);
  let recorded = 0;
  for (const row of rows) {
    const where = row.courseShortname ? ` en ${row.courseShortname}` : '';
    if (
      recordAlert(userId, {
        kind: 'tarea_nueva',
        source: 'diff',
        subjectKey: `assign:${row.assignmentId}`,
        title: `Tarea nueva${where}: ${row.name}`,
        url: `/aula/tarea/${row.assignmentId}`,
        courseId: row.courseId,
        occurredAt: nowSeconds(now),
        now,
      })
    ) {
      recorded += 1;
    }
  }
  return recorded;
}

/**
 * Qué módulos de Moodle son material de estudio.
 *
 * Fuera quedan los que ya tienen su propio aviso (`assign` es tarea nueva,
 * `forum` es anuncio) y `label`, que es un texto suelto en la página del curso
 * y no un recurso que se pueda abrir. Un `quiz` sí entra: es algo que hay que
 * hacer, aunque no se entregue por la bandeja de tareas.
 */
const MATERIAL_MODNAMES = new Set(['resource', 'folder', 'url', 'page', 'book', 'quiz', 'lesson', 'glossary', 'wiki']);

export function isMaterialModname(modname) {
  return MATERIAL_MODNAMES.has(String(modname ?? '').toLowerCase());
}

/**
 * Material nuevo. `created` son los cmid que no estaban en el árbol antes, y
 * `seeded` dice si era la primera vez que se veía el curso: el primer sync
 * siembra y no avisa, igual que con las tareas, o encender esto cualquier día
 * de noviembre trae el cuatrimestre entero de golpe.
 */
export function recordNewMaterial(userId, { created = [], seeded = false, now = Date.now() } = {}) {
  if (seeded || !created.length) return 0;
  const rows = db
    .prepare(
      `SELECT m.cmid, m.name, m.modname, m.course_id AS courseId, c.shortname AS courseShortname
       FROM pva_module m
       LEFT JOIN pva_course c ON c.user_id = m.user_id AND c.course_id = m.course_id
       WHERE m.user_id = ? AND m.uservisible = 1 AND m.cmid IN (${created.map(() => '?').join(', ')})`
    )
    .all(userId, ...created);
  let recorded = 0;
  for (const row of rows) {
    if (!isMaterialModname(row.modname)) continue;
    const where = row.courseShortname ? ` en ${row.courseShortname}` : '';
    if (
      recordAlert(userId, {
        kind: 'material_nuevo',
        source: 'diff',
        subjectKey: `cmid:${row.cmid}`,
        title: `Material nuevo${where}: ${row.name}`,
        url: `/aula/material/${row.cmid}`,
        courseId: row.courseId,
        occurredAt: nowSeconds(now),
        now,
      })
    ) {
      recorded += 1;
    }
  }
  return recorded;
}

/**
 * Tarea por vencer. Sale directo de la campanita, sin diff: es el único aviso
 * que la plataforma manda por su cuenta. Un recordatorio repetido colapsa en el
 * mismo aviso porque la llave es la tarea, no la notificación.
 */
export function recordDueSoon(userId, { now = Date.now() } = {}) {
  const rows = db
    .prepare(
      `SELECT n.notification_id AS notificationId, n.subject, n.contexturl_name AS contextName,
              n.contexturl, n.instance_id AS instanceId, n.cmid, n.course_id AS courseId,
              n.created_at AS createdAt
       FROM pva_notification n
       WHERE n.user_id = ? AND n.eventtype = 'assign_due_soon' AND n.deleted_remote = 0
       ORDER BY n.created_at DESC`
    )
    .all(userId);
  let recorded = 0;
  for (const row of rows) {
    // La notificación trae dos ids del mismo objeto: el de instancia en
    // customdata y el cmid en la URL. La llave usa el de instancia, que es el
    // que comparte con el diff de tareas.
    const key = row.instanceId ? `assign:${row.instanceId}` : `cmid:${row.cmid ?? cmidFromUrl(row.contexturl)}`;
    if (
      recordAlert(userId, {
        kind: 'tarea_por_vencer',
        source: 'notification',
        subjectKey: key,
        title: text(row.contextName) ? `Vence pronto: ${row.contextName}` : row.subject,
        url: row.contexturl,
        courseId: row.courseId,
        notificationId: row.notificationId,
        occurredAt: row.createdAt,
        now,
      })
    ) {
      recorded += 1;
    }
  }
  return recorded;
}

/**
 * Nota publicada. La bitácora la escribe el sync de notas; acá solo se
 * convierte en aviso lo que todavía no se avisó.
 *
 * La llave se aparta del mapa en un punto y a propósito: una recalificación del
 * mismo item lleva la fecha en la llave. Con la llave pelada, que un profesor
 * te cambie la nota después no generaría ningún aviso, y eso es exactamente lo
 * que uno quiere saber.
 */
export function recordGradeAlerts(userId, { now = Date.now() } = {}) {
  const rows = db
    .prepare(
      `SELECT ch.change_id AS changeId, ch.kind, ch.new_graded_at AS newGradedAt, ch.new_raw_src AS newRaw,
              i.item_id AS itemId, i.itemname AS name, i.course_id AS courseId, i.cmid,
              c.shortname AS courseShortname
       FROM pva_grade_change ch
       JOIN pva_grade_item i ON i.item_id = ch.item_id
       LEFT JOIN pva_course c ON c.user_id = i.user_id AND c.course_id = i.course_id
       WHERE i.user_id = ? AND ch.notified_at IS NULL AND ch.kind IN ('published', 'regraded', 'unhidden')
       ORDER BY ch.detected_at`
    )
    .all(userId);

  const markNotified = db.prepare('UPDATE pva_grade_change SET notified_at = ? WHERE change_id = ?');
  let recorded = 0;
  for (const row of rows) {
    const key = row.kind === 'regraded' ? `gradeitem:${row.itemId}@${row.newGradedAt ?? 0}` : `gradeitem:${row.itemId}`;
    const where = row.courseShortname ? ` de ${row.courseShortname}` : '';
    const what = row.name ? `${row.name}${where}` : `una actividad${where}`;
    if (
      recordAlert(userId, {
        kind: 'nota_publicada',
        source: 'diff',
        subjectKey: key,
        title: row.kind === 'regraded' ? `Te cambiaron la nota de ${what}` : `Nota publicada: ${what}`,
        url: `/aula/notas/${row.courseId}`,
        courseId: row.courseId,
        occurredAt: row.newGradedAt ?? nowSeconds(now),
        now,
      })
    ) {
      recorded += 1;
    }
    // La bitácora se marca aunque el aviso ya existiera: lo que importa es no
    // volver a mirar ese cambio, y el aviso ya está asentado.
    markNotified.run(nowSeconds(now), row.changeId);
  }
  return recorded;
}

/**
 * Anuncio del profesor, por los dos caminos.
 *
 * El rápido es la notificación, y solo cuenta si su cmid resuelve a un foro
 * `type = 'news'`: cualquier otro foro llega por el mismo component y no puede
 * avisar. El respaldo es el contador de discusiones, que es obligatorio porque
 * la notificación depende de las preferencias del usuario y de forcesubscribe.
 */
export function recordAnnouncements(userId, { newAnnouncements = [], now = Date.now() } = {}) {
  let recorded = 0;

  const notifications = db
    .prepare(
      `SELECT n.notification_id AS notificationId, n.subject, n.contexturl_name AS contextName,
              n.contexturl, n.cmid, n.course_id AS courseId, n.created_at AS createdAt,
              f.forum_id AS forumId, c.shortname AS courseShortname
       FROM pva_notification n
       JOIN pva_forum f ON f.user_id = n.user_id AND f.cmid = n.cmid AND f.type = 'news'
       LEFT JOIN pva_course c ON c.user_id = n.user_id AND c.course_id = f.course_id
       WHERE n.user_id = ? AND n.component = 'mod_forum' AND n.deleted_remote = 0
       ORDER BY n.created_at DESC`
    )
    .all(userId);
  for (const row of notifications) {
    // Si la URL apunta a una discusión concreta, esa es la identidad del
    // anuncio; si no, lo mejor que hay es el foro más el momento.
    const discussion = /[?&]d=(\d+)/.exec(row.contexturl ?? '')?.[1] ?? null;
    const where = row.courseShortname ? ` de ${row.courseShortname}` : '';
    if (
      recordAlert(userId, {
        kind: 'anuncio',
        source: 'notification',
        subjectKey: discussion ? `discussion:${discussion}` : `forum:${row.forumId}:${row.createdAt}`,
        title: `Anuncio${where}: ${text(row.contextName, row.subject)}`,
        url: row.contexturl,
        courseId: row.courseId,
        notificationId: row.notificationId,
        occurredAt: row.createdAt,
        now,
      })
    ) {
      recorded += 1;
    }
  }

  for (const forum of newAnnouncements) {
    const course = db
      .prepare('SELECT shortname FROM pva_course WHERE user_id = ? AND course_id = ?')
      .get(userId, forum.courseId);
    const where = course?.shortname ? ` de ${course.shortname}` : '';
    // El contador solo dice CUÁNTOS hay, no cuál es: la llave lleva el número
    // para que dos anuncios seguidos no colapsen en uno.
    if (
      recordAlert(userId, {
        kind: 'anuncio',
        source: 'diff',
        subjectKey: `forum:${forum.forumId}:count:${forum.added}:${forum.total ?? ''}`,
        title: forum.added > 1 ? `${forum.added} anuncios nuevos${where}` : `Anuncio nuevo${where}`,
        url: `/aula/materia/${forum.courseId}`,
        courseId: forum.courseId,
        occurredAt: nowSeconds(now),
        now,
      })
    ) {
      recorded += 1;
    }
  }
  return recorded;
}

// ── La entrega ─────────────────────────────────────────────────────────────

const URGENCY = {
  tarea_por_vencer: 'critical',
  tarea_nueva: 'normal',
  nota_publicada: 'normal',
  anuncio: 'normal',
  material_nuevo: 'low',
};

/**
 * Entrega lo pendiente por los canales que ya existen. Con los avisos apagados
 * igual se marca como entregado: lo que se detectó mientras estaban en silencio
 * queda asentado y no se acumula para el día que alguien los encienda.
 */
export function deliverAlerts(userId, { emit = null, now = Date.now() } = {}) {
  const prefs = alertPrefs();
  const pending = pendingAlerts(userId);
  const mark = db.prepare('UPDATE pva_alert SET delivered_at = ? WHERE alert_id = ?');
  const summary = { pending: pending.length, delivered: 0, silenced: 0 };

  for (const alert of pending) {
    const shouldEmit = prefs.enabled && prefs.kinds[alert.kind] !== false;
    if (shouldEmit && emit) {
      emit({
        type: 'notice',
        userId,
        title: alert.title,
        body: alert.url ? '' : 'Abrí el aula para verlo.',
        // La llave del feed reusa la del libro: el dedupe de notificaciones y
        // el de acá hablan del mismo objeto de Moodle.
        key: `pva:${alert.kind}:${alert.subjectKey}`,
        level: 'info',
        link: alert.url && alert.url.startsWith('/') ? alert.url : null,
        urgency: URGENCY[alert.kind] ?? 'normal',
      });
      summary.delivered += 1;
    } else {
      summary.silenced += 1;
    }
    mark.run(nowSeconds(now), alert.alertId);
  }
  return summary;
}

// ── El libro de Kino ───────────────────────────────────────────────────────
//
// Segundo libro, con su propia fecha. `delivered_at` dice si la notificación
// local salió; `kino_at` dice si el hecho llegó a las tareas. Un aviso
// silenciado en el escritorio igual tiene que convertirse en tarea, y por eso
// una marca no puede consumir a la otra.

/** Qué tipos de aviso se convierten en una tarea de Kino, y cuáles no. */
export const KINO_KINDS = new Set(['tarea_nueva', 'tarea_por_vencer', 'material_nuevo']);

/**
 * Lo que todavía no subió a Kino, de los tipos que allá significan algo.
 *
 * Una nota publicada no es algo que hacer y un anuncio casi nunca lo es: los
 * dos se quedan en el aviso local. Lo que sí sube es lo que ocupa tiempo.
 *
 * `tarea_por_vencer` comparte `subject_key` con `tarea_nueva` (las dos apuntan
 * a `assign:<instanceid>`), así que cuando los dos avisos de la misma tarea
 * están pendientes, Kino recibe el mismo `externalId` dos veces y su
 * idempotencia lo resuelve en una sola tarea.
 */
export function pendingForKino(userId, { limit = 50 } = {}) {
  return db
    .prepare(
      `SELECT alert_id AS alertId, kind, subject_key AS subjectKey, course_id AS courseId,
              title, url, occurred_at AS occurredAt
       FROM pva_alert
       WHERE user_id = ? AND kino_at IS NULL AND kind IN (${[...KINO_KINDS].map(() => '?').join(', ')})
       ORDER BY occurred_at ASC
       LIMIT ?`
    )
    .all(userId, ...KINO_KINDS, limit);
}

/**
 * Asienta que estos avisos ya son tareas. Se llama después de que Kino
 * responde, nunca antes: un aviso marcado sin que la subida llegara es un aviso
 * que no vuelve a intentarse y una tarea que no existe en ningún lado.
 */
export function markKinoSent(alertIds, { now = Date.now() } = {}) {
  if (!alertIds.length) return 0;
  const mark = db.prepare('UPDATE pva_alert SET kino_at = ? WHERE alert_id = ? AND kino_at IS NULL');
  const stamp = nowSeconds(now);
  let marked = 0;
  db.exec('BEGIN');
  try {
    for (const id of alertIds) marked += mark.run(stamp, id).changes;
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return marked;
}
