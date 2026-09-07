// Calendario, foros y campanita contra fixtures, sin red.
//
// Las dos cosas que esta prueba existe para fijar:
//
//   1. `events[].instance` ES el cmid. El join va contra assignment.cmid, y
//      usarlo como assign.id no lanza error: simplemente no junta con nada.
//   2. El silencio. Un aviso de foro solo es anuncio del profesor si su cmid
//      resuelve a un foro `type = 'news'`. Filtrar por `component` deja pasar
//      cualquier foro, y filtrar excluyendo mod_forum apaga el anuncio real.
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-pva-avisos-'));
process.env.MIKAMPUS_DATA_DIR = dir;
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');

const { db } = await import('../src/db.js');
const { saveIdentity } = await import('../src/moodle/identity.js');
const { saveCourses, saveCourseContents } = await import('../src/moodle/courses.js');
const { saveAssignments } = await import('../src/moodle/assignments.js');
const { saveCalendarEvents, syncCalendar, upcoming, upcomingByDay, eventPayloadHash } = await import('../src/moodle/calendar.js');
const { saveForums, saveNotifications, announcementForums, forumsWithDueDate, isAnnouncement, readNotifications } =
  await import('../src/moodle/forums.js');

const fixture = async (name) => JSON.parse(await readFile(`fixtures/${name}`, 'utf8'));
const siteInfo = await fixture('pva-site-info.json');
const courses = await fixture('pva-courses.json');
const contents = await fixture('pva-contents.json');
const assignments = await fixture('pva-assignments.json');
const events = await fixture('pva-calendar-events.json');
const forums = await fixture('pva-forums.json');
const notifications = await fixture('pva-notifications.json');

const USER = 1;
const AHORA = 1_771_900_000_000;

try {
  saveIdentity(USER, siteInfo);
  saveCourses(USER, courses);
  saveCourseContents(USER, 800101, contents);
  saveAssignments(USER, assignments, { now: AHORA });

  // ── El calendario, y el null explícito que no es cero ──
  {
    const result = saveCalendarEvents(USER, events, { now: AHORA, windowFrom: 1_770_000_000, limit: 50 });
    assert.deepEqual({ events: result.events, changed: result.changed }, { events: 2, changed: 2 });

    const row = db.prepare('SELECT * FROM pva_calendar_event WHERE event_id = 970001').get();
    assert.equal(row.cmid, 910001, 'instance es el cmid, pese al nombre');
    assert.equal(row.category_id, null, 'categoryid llega null explícito: no es 0 ni ausente');
    assert.equal(row.group_id, null);
    assert.equal(row.repeat_id, null);
    assert.equal(row.event_count, null);
    assert.equal(row.activityname, 'Tarea de prueba', 'el título que pinta la UI es activityname');
    assert.notEqual(row.name, row.activityname, 'el name guardado no es derivable del título');

    // Las credenciales y el copy re-derivable no se guardan.
    const columnas = db.prepare('PRAGMA table_info(pva_calendar_event)').all().map((column) => column.name);
    for (const prohibida of ['editurl', 'deleteurl', 'formattedtime', 'normalisedeventtypetext', 'courseimage']) {
      assert.equal(columnas.includes(prohibida), false, `${prohibida} no tiene columna: trae sesskey, copy localizado o peso muerto`);
    }

    // El hash ignora la imagen del curso: una purga de caché del tema reescribe
    // ese data URI y no puede contar como cambio del evento.
    const conImagen = { ...events.events[0], course: { ...events.events[0].course, courseimage: 'data:image/svg+xml;base64,AAAA' } };
    assert.equal(eventPayloadHash(conImagen), eventPayloadHash(events.events[0]), 'courseimage no entra al hash');
    const soloSesskey = { ...events.events[0], editurl: 'https://x/course/mod.php?update=1&sesskey=abc' };
    assert.equal(eventPayloadHash(soloSesskey), eventPayloadHash(events.events[0]), 'ni la URL con sesskey');
  }

  // ── El join que importa: evento con su tarea y su entrega ──
  {
    const lista = upcoming(USER, { now: AHORA, days: 30 });
    assert.equal(lista.length, 2);
    assert.deepEqual(
      lista.map((evento) => evento.assignmentId),
      [900001, 900006],
      'el evento se une con la tarea por cmid, no por assign.id'
    );
    assert.equal(lista[0].courseShortname, 'MAT-101-01', 'y con la materia por course_id');

    const porDia = upcomingByDay(USER, { now: AHORA, days: 30 });
    assert.equal(porDia.length, 2, 'agrupado por la medianoche local que ya calculó el servidor');
    assert.match(porDia[0].day, /^\d{4}-\d{2}-\d{2}$/);
    // La trampa de la zona horaria: una entrega de las 11:59 pm agrupada por
    // timesort caería en el día siguiente. timeusermidnight la deja en el suyo.
    const evento = db.prepare('SELECT timesort, timeusermidnight, local_day FROM pva_calendar_event WHERE event_id = 970001').get();
    assert.equal(evento.local_day, new Date((evento.timeusermidnight + 43200) * 1000).toISOString().slice(0, 10));
  }

  // ── Un evento que deja de venir se marca, nunca se borra ──
  {
    const soloUno = { ...events, events: [events.events[0]] };
    saveCalendarEvents(USER, soloUno, { now: AHORA + 60_000, windowFrom: 1_770_000_000, limit: 50 });
    const marcado = db.prepare('SELECT missing_since FROM pva_calendar_event WHERE event_id = 970002').get();
    assert.ok(marcado.missing_since > 0, 'desaparecer es ambiguo: pudo ser entrega, borrado o ventana');
    assert.equal(db.prepare('SELECT count(*) AS n FROM pva_calendar_event').get().n, 2, 'pero el evento sigue ahí');
    assert.equal(upcoming(USER, { now: AHORA, days: 30 }).length, 1, 'y deja de pintarse');
    assert.equal(upcoming(USER, { now: AHORA, days: 30, includeMissing: true }).length, 2, 'salvo que se pidan');

    saveCalendarEvents(USER, events, { now: AHORA + 120_000, windowFrom: 1_770_000_000, limit: 50 });
    assert.equal(db.prepare('SELECT missing_since FROM pva_calendar_event WHERE event_id = 970002').get().missing_since, null, 'si vuelve, se desmarca');
  }

  // ── Una respuesta que llegó al tope no cubre la ventana ──
  {
    // Con limitnum alcanzado, lo que está más allá del último evento no se
    // puede declarar ausente: eso es paginación, no ausencia.
    const soloPrimero = { ...events, events: [events.events[0]] };
    saveCalendarEvents(USER, soloPrimero, { now: AHORA + 180_000, windowFrom: 1_770_000_000, limit: 1 });
    assert.equal(
      db.prepare('SELECT missing_since FROM pva_calendar_event WHERE event_id = 970002').get().missing_since,
      null,
      'el evento posterior al último devuelto no se marca'
    );
  }

  // ── syncCalendar pide la ventana con el margen hacia atrás ──
  {
    const llamadas = [];
    const result = await syncCalendar(USER, {
      call: async (fn, args) => {
        llamadas.push([fn, args]);
        return events;
      },
      now: AHORA,
      daysBack: 30,
      limit: 50,
    });
    assert.equal(result.events, 2);
    assert.equal(llamadas[0][0], 'core_calendar_get_action_events_by_timesort');
    assert.equal(llamadas[0][1].timesortfrom, Math.floor(AHORA / 1000) - 30 * 86400, 'se pide desde 30 días atrás');
    assert.equal(llamadas[0][1].limitnum, 50);
  }

  // ── Foros: el tipo es el único discriminador ──
  {
    const result = saveForums(USER, forums, { now: AHORA });
    assert.deepEqual({ forums: result.forums, announcements: result.announcements }, { forums: 2, announcements: 1 });
    assert.deepEqual(result.newAnnouncements, [], 'la primera corrida siembra el contador, no avisa');

    const anuncios = announcementForums(USER);
    assert.equal(anuncios.length, 1);
    assert.equal(anuncios[0].forumId, 950001);

    const conFecha = forumsWithDueDate(USER);
    assert.equal(conFecha.length, 1, 'un foro general con duedate es una entrega que mod_assign no reporta');
    assert.equal(conFecha[0].forumId, 950002);
    const general = db.prepare('SELECT scale, assessed FROM pva_forum WHERE forum_id = 950002').get();
    assert.equal(general.scale, 100);
    assert.equal(general.assessed, 0, 'con assessed 0 la escala está inerte: el criterio es la fecha, no scale');

    // El contador barato detecta anuncios nuevos.
    const conAnuncioNuevo = [{ ...forums[0], numdiscussions: 4 }, forums[1]];
    const delta = saveForums(USER, conAnuncioNuevo, { now: AHORA + 60_000 });
    assert.deepEqual(delta.newAnnouncements, [{ forumId: 950001, courseId: 800101, added: 1 }]);
    // Una edición del profesor no mueve numdiscussions: detecta nuevos, no cambios.
    const sinMovimiento = saveForums(USER, conAnuncioNuevo, { now: AHORA + 120_000 });
    assert.deepEqual(sinMovimiento.newAnnouncements, []);
  }

  // ── La campanita ──
  {
    const result = saveNotifications(USER, notifications, { now: AHORA });
    assert.equal(result.received, 2);
    assert.equal(result.inserted, 2);
    assert.equal(result.unreadCount, 3, 'unreadcount es el total de no leídas, no el largo del arreglo');

    const aviso = db.prepare('SELECT * FROM pva_notification WHERE notification_id = 980001').get();
    assert.equal(aviso.userid_from, -10, 'el remitente puede ser negativo: es el pseudo usuario de sistema');
    assert.equal(aviso.cmid, 910001, 'el cmid sale del ?id= del contexturl');
    assert.equal(aviso.instance_id, 900001, 'y customdata.assignmentid es el id de INSTANCIA, no el cmid');
    assert.notEqual(aviso.cmid, aviso.instance_id, 'son dos ids distintos del mismo objeto');
    assert.equal(aviso.course_id, 800101, 'el curso se resuelve por cmid: la notificación no lo dice');
    assert.equal(aviso.customdata_duedate, 1772000000);

    const sinCustomdata = db.prepare('SELECT customdata_raw, instance_id FROM pva_notification WHERE notification_id = 980002').get();
    assert.equal(sinCustomdata.instance_id, null, "customdata '' es truthy: parsear y comprobar que dio objeto");

    // Idempotente, y el estado de lectura del portal se actualiza sin duplicar.
    const otra = saveNotifications(USER, { ...notifications, notifications: [{ ...notifications.notifications[0], read: true, timeread: 1771950000 }] }, { now: AHORA + 60_000 });
    assert.equal(otra.inserted, 0, 'el id de Moodle es la llave natural');
    assert.equal(db.prepare('SELECT read_remote FROM pva_notification WHERE notification_id = 980001').get().read_remote, 1);
  }

  // ── El silencio: qué avisa y qué no ──
  {
    const lista = readNotifications(USER);
    const deForo = lista.find((aviso) => aviso.notificationId === 980002);
    const deTarea = lista.find((aviso) => aviso.notificationId === 980001);
    assert.equal(isAnnouncement(USER, deForo), true, 'su cmid resuelve a un foro type=news: es el anuncio del profesor');
    assert.equal(isAnnouncement(USER, deTarea), false, 'una notificación de tarea no es un anuncio');

    // El mismo component, otro foro: no avisa.
    const deForoGeneral = { ...deForo, cmid: 910007 };
    assert.equal(
      isAnnouncement(USER, deForoGeneral),
      false,
      'un foro general llega por el mismo component y no puede avisar nunca'
    );
    assert.equal(isAnnouncement(USER, { ...deForo, cmid: null, contexturl: null }), false, 'sin cmid no se adivina');
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ avisos de la PVA: instance es el cmid, el evento ausente se marca, y solo el foro news habla');
