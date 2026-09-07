import { db, logSync } from '../db.js';
import { callPva } from './session.js';
import { bool01, epoch, hashOf, int, nowSeconds, text, textOrNull } from './shape.js';

// Calendario: lo que vence.
//
// `core_calendar_get_action_events_by_timesort` no es un calendario, es una
// lista de pendientes: solo devuelve eventos con acción pendiente. Lo ya
// entregado y lo vencido no aparecen, así que una agenda construida solo con
// esto se vacía sola y nunca enseña historial. Aun así es la mejor fuente que
// hay: una llamada trae las entregas de todas las materias, ordenadas, y el
// servidor ya calculó `overdue`.
//
// Tres cosas que este archivo hace a propósito:
//
//   1. `events[].instance` ES EL CMID, pese al nombre. El join correcto es
//      contra `pva_assignment.cmid`, nunca contra `assignment_id`. Usarlo mal no
//      lanza error: simplemente no junta con nada y el calendario queda huérfano.
//   2. No se guardan `editurl` ni `deleteurl`: traen un `sesskey`, que es una
//      credencial de sesión, y además rota, así que la URL guardada nace
//      inválida. Tampoco `formattedtime` ni los textos localizados que se pueden
//      volver a derivar, ni `course.courseimage`, que es el 75% del peso.
//   3. Un evento que deja de venir NO se borra: puede ser que lo entregaste, que
//      el profesor lo borró, o que quedó fuera de la ventana pedida. Son tres
//      cosas distintas y el feed no las distingue, así que se marca.

/**
 * El hash del evento, sin la imagen del curso. Incluirla haría que una purga de
 * caché del tema, que reescribe el data URI, contara como cambio del evento.
 */
export function eventPayloadHash(event) {
  const { course = {}, ...rest } = event;
  const { courseimage, ...courseRest } = course;
  return hashOf({ ...rest, formattedtime: null, editurl: null, deleteurl: null, course: courseRest });
}

export function saveCalendarEvents(userId, payload, { now = Date.now(), windowFrom = null, limit = null } = {}) {
  const stamp = nowSeconds(now);
  const events = payload?.events ?? [];
  const upsert = db.prepare(
    `INSERT INTO pva_calendar_event (
       event_id, user_id, course_id, cmid, component, modulename, eventtype, normalised_eventtype,
       name, activityname, activitystr, description_html, description_format, location,
       timestart, timesort, timeduration, timeusermidnight, timemodified, visible, overdue,
       is_action_event, is_course_event, is_category_event, category_id, group_id, event_userid,
       repeat_id, event_count, purpose, icon_key, icon_component, action_name, action_url,
       action_itemcount, action_actionable, module_url, calendar_view_url, source, payload_hash,
       first_seen_at, last_seen_at, missing_since
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'action_timesort', ?, ?, ?, NULL)
     ON CONFLICT(event_id) DO UPDATE SET
       course_id = excluded.course_id, cmid = excluded.cmid, component = excluded.component,
       modulename = excluded.modulename, eventtype = excluded.eventtype,
       normalised_eventtype = excluded.normalised_eventtype, name = excluded.name,
       activityname = excluded.activityname, activitystr = excluded.activitystr,
       description_html = excluded.description_html, description_format = excluded.description_format,
       location = excluded.location, timestart = excluded.timestart, timesort = excluded.timesort,
       timeduration = excluded.timeduration, timeusermidnight = excluded.timeusermidnight,
       timemodified = excluded.timemodified, visible = excluded.visible, overdue = excluded.overdue,
       is_action_event = excluded.is_action_event, is_course_event = excluded.is_course_event,
       is_category_event = excluded.is_category_event, category_id = excluded.category_id,
       group_id = excluded.group_id, event_userid = excluded.event_userid, repeat_id = excluded.repeat_id,
       event_count = excluded.event_count, purpose = excluded.purpose, icon_key = excluded.icon_key,
       icon_component = excluded.icon_component, action_name = excluded.action_name,
       action_url = excluded.action_url, action_itemcount = excluded.action_itemcount,
       action_actionable = excluded.action_actionable, module_url = excluded.module_url,
       calendar_view_url = excluded.calendar_view_url, payload_hash = excluded.payload_hash,
       last_seen_at = excluded.last_seen_at, missing_since = NULL`
  );

  let changed = 0;
  db.exec('BEGIN');
  try {
    const present = new Set();
    for (const event of events) {
      const id = int(event.id);
      present.add(id);
      const hash = eventPayloadHash(event);
      const before = db.prepare('SELECT payload_hash AS hash FROM pva_calendar_event WHERE event_id = ?').get(id);
      if (before?.hash !== hash) changed += 1;
      upsert.run(
        id,
        userId,
        int(event.course?.id, 0),
        // instance ES el cmid: el join va contra assignment.cmid.
        int(event.instance),
        textOrNull(event.component),
        textOrNull(event.modulename),
        text(event.eventtype),
        text(event.normalisedeventtype),
        // El nombre guardado no se deriva de activityname: en 2 de 7 no sigue
        // la plantilla, y recortar el sufijo en español con una regex rompe.
        text(event.name),
        textOrNull(event.activityname),
        textOrNull(event.activitystr),
        text(event.description),
        int(event.descriptionformat, 1),
        text(event.location),
        int(event.timestart, 0),
        int(event.timesort, 0),
        int(event.timeduration, 0),
        // La medianoche local del día del evento, que Moodle ya calculó en la
        // zona del usuario: es la forma correcta de agrupar por día sin una
        // base de zonas horarias. Agrupar por timesort corre las entregas de
        // las 11:59 pm un día hacia adelante.
        int(event.timeusermidnight, 0),
        int(event.timemodified, 0),
        bool01(event.visible, 1),
        bool01(event.overdue),
        bool01(event.isactionevent),
        bool01(event.iscourseevent),
        bool01(event.iscategoryevent),
        int(event.categoryid),
        int(event.groupid),
        int(event.userid),
        int(event.repeatid),
        int(event.eventcount),
        textOrNull(event.purpose),
        textOrNull(event.icon?.key),
        textOrNull(event.icon?.component),
        textOrNull(event.action?.name),
        textOrNull(event.action?.url),
        int(event.action?.itemcount),
        // "Se puede actuar ahora mismo", no "está pendiente": filtrar la agenda
        // por esto deja una lista de un solo item.
        bool01(event.action?.actionable),
        textOrNull(event.url),
        textOrNull(event.viewurl),
        hash,
        stamp,
        stamp
      );
    }

    // Solo se marca lo que la corrida pudo haber visto. Si la respuesta llegó
    // al tope pedido, la ventana no está cubierta hasta el final: marcar más
    // allá del último evento sería inventar una ausencia que es paginación.
    const covered = limit != null && events.length >= limit ? Math.max(...events.map((event) => int(event.timesort, 0))) : null;
    const rows = db
      .prepare('SELECT event_id AS id, timesort FROM pva_calendar_event WHERE user_id = ? AND missing_since IS NULL')
      .all(userId);
    const mark = db.prepare('UPDATE pva_calendar_event SET missing_since = ? WHERE event_id = ?');
    for (const row of rows) {
      if (present.has(row.id)) continue;
      if (windowFrom != null && row.timesort < windowFrom) continue;
      if (covered != null && row.timesort > covered) continue;
      mark.run(stamp, row.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { events: events.length, changed };
}

export async function syncCalendar(userId, { call = callPva, now = Date.now(), daysBack = 30, limit = 50 } = {}) {
  const timesortfrom = nowSeconds(now) - daysBack * 86400;
  const payload = await call('core_calendar_get_action_events_by_timesort', { timesortfrom, limitnum: limit });
  const result = saveCalendarEvents(userId, payload, { now, windowFrom: timesortfrom, limit });
  logSync({
    userId,
    kind: 'pvaCalendar',
    status: 'ok',
    detail: `${result.events} evento(s) con acción pendiente`,
    rows: result.events,
  });
  return result;
}

/**
 * Lo que vence, unido con la tarea por cmid. El join es `event.cmid` contra
 * `assignment.cmid`, que es lo que el mapa dejó comprobado por dos vías.
 */
export function upcoming(userId, { now = Date.now(), days = 14, includeMissing = false } = {}) {
  const from = nowSeconds(now);
  const to = from + days * 86400;
  return db
    .prepare(
      `SELECT e.event_id AS eventId, e.course_id AS courseId, e.cmid, e.activityname AS activityName,
              e.name, e.timesort, e.timeusermidnight AS dayStart, e.local_day AS localDay,
              e.overdue, e.action_actionable AS actionable, e.module_url AS url,
              e.missing_since AS missingSince,
              c.shortname AS courseShortname,
              a.assignment_id AS assignmentId, a.duedate, a.cutoffdate,
              s.status AS submissionStatus, s.grading_status AS gradingStatus
       FROM pva_calendar_event e
       LEFT JOIN pva_course c ON c.user_id = e.user_id AND c.course_id = e.course_id
       LEFT JOIN pva_assignment a ON a.user_id = e.user_id AND a.cmid = e.cmid
       LEFT JOIN pva_submission s ON s.assignment_id = a.assignment_id AND s.is_latest = 1
       WHERE e.user_id = ? AND e.timesort BETWEEN ? AND ?
         ${includeMissing ? '' : 'AND e.missing_since IS NULL'}
       ORDER BY e.timesort`
    )
    .all(userId, from, to);
}

/** Los días con algo que vence, agrupados por la medianoche local del servidor. */
export function upcomingByDay(userId, options = {}) {
  const grouped = new Map();
  for (const event of upcoming(userId, options)) {
    const day = event.localDay;
    if (!grouped.has(day)) grouped.set(day, []);
    grouped.get(day).push(event);
  }
  return [...grouped.entries()].map(([day, events]) => ({ day, events }));
}
