// Los cuatro avisos del aula. Sin red.
//
// Lo que se prueba es el silencio y la idempotencia, que es donde un sistema de
// avisos se vuelve inservible: el primer sync no puede avisar del semestre
// entero, un foro que no es el de anuncios no puede hablar nunca, un
// recordatorio repetido por la plataforma no puede sonar dos veces, y `read` de
// la campanita no decide nada porque lo mueve el portal web.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-pva-alertas-'));
process.env.MIKAMPUS_DATA_DIR = dir;
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.MIKAMPUS_SILENT = '1';

const { db } = await import('../src/db.js');
const { saveIdentity } = await import('../src/moodle/identity.js');
const { saveCourses } = await import('../src/moodle/courses.js');
const { saveAssignments } = await import('../src/moodle/assignments.js');
const { saveGradeItems } = await import('../src/moodle/grades.js');
const { saveForums, saveNotifications } = await import('../src/moodle/forums.js');
const {
  alertPrefs,
  setAlertPrefs,
  recordDueSoon,
  recordAnnouncements,
  recordGradeAlerts,
  pendingAlerts,
  readAlerts,
  deliverAlerts,
  ALERT_KINDS,
} = await import('../src/moodle/alerts.js');

const fixture = async (name) => JSON.parse(await readFile(`fixtures/${name}`, 'utf8'));
const USER = 1;
const NOW = 1_771_900_000_000;
const kindsOf = (rows) => rows.map((row) => row.kind).sort();

try {
  saveIdentity(USER, await fixture('pva-site-info.json'));
  saveCourses(USER, await fixture('pva-courses.json'), { now: NOW });

  // ── Nacen apagados ──
  {
    const prefs = alertPrefs();
    assert.equal(prefs.enabled, false, 'sin que nadie los encienda, no interrumpen');
    assert.deepEqual(Object.keys(prefs.kinds).sort(), [...ALERT_KINDS].sort());
    for (const kind of ALERT_KINDS) assert.equal(prefs.kinds[kind], true, `${kind} está listo para cuando se enciendan`);
  }

  // ── Tarea nueva: solo por diff, y el primer sync siembra ──
  {
    const assignments = await fixture('pva-assignments.json');
    const primera = saveAssignments(USER, assignments, { now: NOW });
    assert.equal(primera.seeded, true, 'la primera corrida no conocía ninguna tarea');
    assert.equal(primera.created.length, 2);
    assert.deepEqual(
      pendingAlerts(USER).filter((alert) => alert.kind === 'tarea_nueva'),
      [],
      'sembrar no avisa: si no, encender la app avisaría del semestre entero'
    );

    // Una tarea que aparece después sí es novedad.
    const conNueva = structuredClone(assignments);
    conNueva.courses[0].assignments.push({
      ...conNueva.courses[0].assignments[0],
      id: 900009,
      cmid: 910009,
      name: 'Tarea recién publicada',
    });
    const segunda = saveAssignments(USER, conNueva, { now: NOW + 60_000 });
    assert.deepEqual(segunda.created, [900009]);
    assert.equal(segunda.seeded, false);

    const nuevas = pendingAlerts(USER).filter((alert) => alert.kind === 'tarea_nueva');
    assert.equal(nuevas.length, 1);
    assert.match(nuevas[0].title, /Tarea recién publicada/);
    assert.match(nuevas[0].title, /MAT-101-01/, 'con su materia, que es lo primero que uno pregunta');
    assert.equal(nuevas[0].subjectKey, 'assign:900009', 'la llave es el objeto de Moodle');

    // Volver a verla no genera un segundo aviso.
    saveAssignments(USER, conNueva, { now: NOW + 120_000 });
    assert.equal(pendingAlerts(USER).filter((alert) => alert.kind === 'tarea_nueva').length, 1);
  }

  // ── Tarea por vencer: directo de la campanita, sin diff ──
  {
    saveForums(USER, await fixture('pva-forums.json'), { now: NOW });
    saveNotifications(USER, await fixture('pva-notifications.json'), { now: NOW });
    recordDueSoon(USER, { now: NOW });

    const vencer = pendingAlerts(USER).filter((alert) => alert.kind === 'tarea_por_vencer');
    assert.equal(vencer.length, 1);
    assert.equal(vencer[0].subjectKey, 'assign:900001', 'la llave usa el id de INSTANCIA, no el cmid ni el de la notificación');
    assert.equal(vencer[0].source, 'notification');

    // La plataforma repite el recordatorio: no puede sonar dos veces.
    recordDueSoon(USER, { now: NOW + 3600_000 });
    assert.equal(pendingAlerts(USER).filter((alert) => alert.kind === 'tarea_por_vencer').length, 1);
  }

  // ── Anuncio: el híbrido, y el silencio ──
  {
    const anuncios = pendingAlerts(USER).filter((alert) => alert.kind === 'anuncio');
    assert.equal(anuncios.length, 1, 'el aviso de foro cuyo cmid resuelve a un foro news sí habla');
    assert.equal(anuncios[0].source, 'notification');

    // El respaldo por contador: obligatorio, porque la notificación depende de
    // las preferencias del usuario y de forcesubscribe.
    const forums = await fixture('pva-forums.json');
    const conAnuncio = [{ ...forums[0], numdiscussions: forums[0].numdiscussions + 2 }, forums[1]];
    const delta = saveForums(USER, conAnuncio, { now: NOW + 60_000 });
    recordAnnouncements(USER, { newAnnouncements: delta.newAnnouncements, now: NOW + 60_000 });
    const conRespaldo = pendingAlerts(USER).filter((alert) => alert.kind === 'anuncio');
    assert.equal(conRespaldo.length, 2);
    assert.ok(conRespaldo.some((alert) => alert.source === 'diff' && /2 anuncios/.test(alert.title)));

    // El silencio: un foro general llega por el MISMO component y no avisa.
    const general = {
      notifications: [
        {
          id: 980003,
          useridfrom: 90002,
          useridto: 90001,
          component: 'mod_forum',
          eventtype: 'posts',
          subject: 'Alguien respondió en el foro de debate',
          smallmessage: 'respuesta',
          fullmessagehtml: '<p>x</p>',
          contexturl: 'https://campusvirtual.pucmm.edu.do/moodle/mod/forum/view.php?id=910007',
          contexturlname: 'Foro de debate',
          customdata: '',
          timecreated: 1771890000,
          read: false,
          timeread: null,
          deleted: false,
          iconurl: '',
        },
      ],
      unreadcount: 1,
    };
    saveNotifications(USER, general, { now: NOW + 120_000 });
    recordAnnouncements(USER, { now: NOW + 120_000 });
    assert.equal(
      pendingAlerts(USER).filter((alert) => alert.kind === 'anuncio').length,
      2,
      'un foro que no es el de anuncios no genera aviso: el filtro es el type del foro, no el component'
    );
  }

  // ── Nota publicada, y la recalificación que no se pierde ──
  {
    const items = await fixture('pva-grade-items.json');
    saveGradeItems(USER, 800101, items, { now: NOW });
    recordGradeAlerts(USER, { now: NOW });
    assert.deepEqual(
      pendingAlerts(USER).filter((alert) => alert.kind === 'nota_publicada'),
      [],
      'el primer sync del libro siembra y no avisa'
    );

    const conNota = structuredClone(items);
    Object.assign(conNota.usergrades[0].gradeitems[0], { graderaw: 85, gradedategraded: 1772100000, gradeformatted: '85,00' });
    saveGradeItems(USER, 800101, conNota, { now: NOW + 60_000 });
    recordGradeAlerts(USER, { now: NOW + 60_000 });
    const publicadas = pendingAlerts(USER).filter((alert) => alert.kind === 'nota_publicada');
    assert.equal(publicadas.length, 1);
    assert.match(publicadas[0].title, /Nota publicada/);
    assert.equal(publicadas[0].subjectKey, 'gradeitem:960001');

    // La bitácora queda marcada: el mismo cambio no se vuelve a mirar.
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM pva_grade_change WHERE notified_at IS NULL').get().n,
      0,
      'lo ya convertido en aviso no se reprocesa'
    );

    // Y si el profesor la cambia, eso también se avisa: con la llave pelada del
    // mapa, una recalificación no habría generado nada.
    const recalificada = structuredClone(items);
    Object.assign(recalificada.usergrades[0].gradeitems[0], { graderaw: 95, gradedategraded: 1772200000, gradeformatted: '95,00' });
    saveGradeItems(USER, 800101, recalificada, { now: NOW + 120_000 });
    recordGradeAlerts(USER, { now: NOW + 120_000 });
    const conRecalificacion = pendingAlerts(USER).filter((alert) => alert.kind === 'nota_publicada');
    assert.equal(conRecalificacion.length, 2);
    assert.ok(conRecalificacion.some((alert) => /cambiaron la nota/.test(alert.title)));
  }

  // ── La entrega ──
  {
    const antes = pendingAlerts(USER);
    assert.deepEqual(
      [...new Set(kindsOf(antes))],
      ['anuncio', 'nota_publicada', 'tarea_nueva', 'tarea_por_vencer'],
      'los cuatro tipos, detectados sin que nadie los haya encendido'
    );

    // Apagados: se marcan entregados igual, en silencio. Si se acumularan, el
    // día que se encienden llegaría el semestre entero de una vez.
    const emitidos = [];
    const enSilencio = deliverAlerts(USER, { emit: (event) => emitidos.push(event), now: NOW + 200_000 });
    assert.equal(enSilencio.pending, antes.length);
    assert.equal(enSilencio.delivered, 0);
    assert.equal(enSilencio.silenced, antes.length);
    assert.deepEqual(emitidos, [], 'nada interrumpió');
    assert.deepEqual(pendingAlerts(USER), [], 'y no quedan acumulados');

    // Encendidos: el siguiente aviso sí sale por el canal que ya existe.
    setAlertPrefs({ enabled: true });
    assert.equal(alertPrefs().enabled, true);
    const conNueva = await fixture('pva-assignments.json');
    conNueva.courses[0].assignments.push({
      ...conNueva.courses[0].assignments[0],
      id: 900011,
      cmid: 910011,
      name: 'Otra tarea nueva',
    });
    saveAssignments(USER, conNueva, { now: NOW + 300_000 });
    const entregados = [];
    const conAvisos = deliverAlerts(USER, { emit: (event) => entregados.push(event), now: NOW + 300_000 });
    assert.equal(conAvisos.delivered, 1);
    assert.equal(entregados[0].type, 'notice', 'entra por el mismo camino que el resto de las notificaciones');
    assert.match(entregados[0].title, /Otra tarea nueva/);
    assert.equal(entregados[0].key, 'pva:tarea_nueva:assign:900011', 'la llave del feed es la del objeto de Moodle');
    assert.equal(entregados[0].userId, USER);

    // Un tipo apagado a mano no habla, y los demás siguen.
    setAlertPrefs({ kinds: { tarea_nueva: false } });
    const otra = await fixture('pva-assignments.json');
    otra.courses[0].assignments.push({ ...otra.courses[0].assignments[0], id: 900012, cmid: 910012, name: 'Tarea silenciada' });
    saveAssignments(USER, otra, { now: NOW + 400_000 });
    const silenciados = [];
    const parcial = deliverAlerts(USER, { emit: (event) => silenciados.push(event), now: NOW + 400_000 });
    assert.equal(parcial.delivered, 0);
    assert.equal(parcial.silenced, 1);
    assert.deepEqual(silenciados, []);

    // Lo entregado queda en el libro con su fecha: es el registro de qué se
    // avisó y cuándo, que `read` de la campanita no puede dar.
    const historial = readAlerts(USER);
    assert.ok(historial.length >= 6);
    assert.ok(historial.every((alert) => alert.deliveredAt != null), 'todo lo procesado queda fechado');
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ avisos del aula: nacen apagados, el primer sync siembra sin avisar, solo el foro news habla y un recordatorio repetido suena una vez');
