import { db } from '../db.js';
import { KINO_KINDS, markKinoSent, pendingForKino } from './alerts.js';
import { int, text } from './shape.js';

// La subida de lo que publica el aula a Kino, que es donde Elias mira qué tiene
// que hacer.
//
// Este módulo no decide nada: los avisos ya están detectados y asentados por
// `alerts.js`, acá solo se les da la forma que espera la ruta `/academico` de
// Kino y se marca el libro cuando la subida llegó.
//
// Tres reglas que no son opcionales:
//
//   1. **Nace apagada.** Sin las dos variables no hay subida y no hay error:
//      una instalación de otra persona no manda sus tareas a un Kino ajeno por
//      haberse olvidado de una configuración.
//   2. **Se marca después de la respuesta, nunca antes.** Un aviso marcado sin
//      que la subida llegara es una tarea que no existe en ningún lado y un
//      aviso que no se reintenta.
//   3. **El mismo aviso puede subir dos veces.** El barrido corre en el laptop
//      y en agentbox, cada uno con su base y su libro. Quien resuelve eso es la
//      identidad `(userId, 'pva', externalId)` del lado de Kino, no un candado
//      acá: dos máquinas que se coordinan por un candado se bloquean cuando una
//      se apaga, que es justo el caso para el que existe la segunda.

/** Cuántos avisos viajan en un envío. El tope de la ruta de Kino es el mismo. */
export const KINO_BATCH_MAX = 50;

/** La URL de la ruta y el secreto del barrido, o null si esto está apagado. */
export function kinoConfig(env = process.env) {
  const url = (env.KINO_ACADEMICO_URL ?? '').trim();
  const token = (env.KINO_ACADEMICO_TOKEN ?? '').trim();
  if (!url || !token) return null;
  return { url, token };
}

/**
 * El id del objeto de Moodle tal como lo va a guardar Kino.
 *
 * Es el `subject_key` del aviso sin tocar, y eso es deliberado: `tarea_nueva` y
 * `tarea_por_vencer` de la misma tarea comparten llave, así que los dos avisos
 * caen en la misma tarea de Kino en vez de crear dos.
 */
export const externalIdOf = (alert) => alert.subjectKey;

const courseRow = (userId, courseId) =>
  db.prepare('SELECT shortname, fullname FROM pva_course WHERE user_id = ? AND course_id = ?').get(userId, courseId) ?? null;

const assignmentRow = (userId, assignmentId) =>
  db.prepare('SELECT name, duedate, cmid FROM pva_assignment WHERE user_id = ? AND assignment_id = ?').get(userId, assignmentId) ?? null;

const siteUrl = (userId) => db.prepare('SELECT siteurl FROM pva_identity WHERE user_id = ?').get(userId)?.siteurl ?? null;

/**
 * El id de la asignación detrás de un aviso de tarea, o null si no es de una
 * tarea. Un aviso de «por vencer» sin id de instancia viene con la llave
 * `cmid:<n>` (alerts.js); se traduce por `pva_assignment.cmid`.
 */
const assignmentIdOf = (alert, userId) => {
  if (alert.subjectKey.startsWith('assign:')) return int(alert.subjectKey.slice('assign:'.length));
  if (userId != null && alert.subjectKey.startsWith('cmid:')) {
    const cmid = int(alert.subjectKey.slice('cmid:'.length));
    return cmid ? int(db.prepare('SELECT assignment_id FROM pva_assignment WHERE user_id = ? AND cmid = ?').get(userId, cmid)?.assignment_id) : null;
  }
  return null;
};

/**
 * En qué estado está la entrega de esta tarea, según la última consulta.
 *
 *   - `entregada`: la última entrega está enviada, o la profesora ya la
 *     calificó sin entrega (una tarea presencial). No es algo que hacer:
 *     subirla la pondría a avisar de algo hecho.
 *   - `pendiente`: hay estado y no está entregada.
 *   - `desconocida`: todavía no se consultó. No sube ni se asienta: espera al
 *     barrido siguiente, porque subirla a ciegas es subir como pendiente lo
 *     que quizá se entregó en septiembre.
 */
export function estadoDeEntrega(userId, assignmentId) {
  // Una tarea sin entrega en línea (presencial) no tiene estado que consultar:
  // Moodle no devuelve intento, así que esperar su estado sería esperar siempre.
  const sinEntrega = db.prepare('SELECT nosubmissions FROM pva_assignment WHERE user_id = ? AND assignment_id = ?').get(userId, assignmentId);
  const row = db
    .prepare(
      `SELECT status, grading_status AS gradingStatus FROM pva_submission
       WHERE user_id = ? AND assignment_id = ? AND is_latest = 1 ORDER BY attemptnumber DESC LIMIT 1`
    )
    .get(userId, assignmentId);
  if (!row) return sinEntrega?.nosubmissions ? 'pendiente' : 'desconocida';
  return row.status === 'submitted' || row.gradingStatus === 'graded' ? 'entregada' : 'pendiente';
}

/**
 * El título que Elias va a leer en su lista de tareas.
 *
 * El del aviso trae el prefijo del canal ("Tarea nueva en CSTI-1930: ..."), que
 * dentro de la carpeta de la materia es ruido: la materia ya está en la
 * carpeta. Cuando la tarea existe en la base se usa su nombre real; si no, se
 * recorta el prefijo del aviso.
 */
export function titleOf(userId, alert) {
  const assignmentId = assignmentIdOf(alert, userId);
  if (assignmentId) {
    const row = assignmentRow(userId, assignmentId);
    if (row?.name) return text(row.name);
  }
  const sinPrefijo = alert.title.replace(/^(Tarea nueva|Tarea por vencer|Material nuevo)[^:]*:\s*/u, '');
  return text(sinPrefijo || alert.title);
}

/** El cierre publicado, en epoch ms, o undefined si la plataforma no publica ninguno. */
export function dueDateOf(userId, alert) {
  const assignmentId = assignmentIdOf(alert, userId);
  if (!assignmentId) return undefined;
  const row = assignmentRow(userId, assignmentId);
  // Moodle guarda segundos y Kino espera milisegundos. `duedate` NULL es una
  // tarea sin fecha límite, que no es lo mismo que una fecha desconocida.
  return row?.duedate ? row.duedate * 1000 : undefined;
}

/** Un aviso, con la forma exacta que valida la ruta `/academico`. */
export function itemOf(userId, alert) {
  const course = alert.courseId ? courseRow(userId, alert.courseId) : null;
  const item = {
    externalId: externalIdOf(alert),
    title: titleOf(userId, alert),
  };
  if (course?.shortname) item.courseCode = text(course.shortname);
  if (course?.fullname) item.courseName = text(course.fullname);
  const dueDate = dueDateOf(userId, alert);
  if (dueDate) item.dueDate = dueDate;
  // El enlace a la actividad lleva su cmid, que es el número que la clase cita
  // al escribir la tarea («PVA cmid:…»). Con él, la revisión de la mañana
  // reconoce cuándo una tarea de la PVA y una de la clase son la misma entrega.
  const assignmentId = assignmentIdOf(alert, userId);
  const cmid = assignmentId ? int(assignmentRow(userId, assignmentId)?.cmid) : null;
  const site = cmid ? siteUrl(userId) : null;
  if (site) item.url = `${site.replace(/\/$/, '')}/mod/assign/view.php?id=${cmid}`;
  return item;
}

/**
 * Lo que subiría el próximo barrido, sin subirlo. Es lo que mira el `--dry-run`
 * del comando y lo que prueban los tests: el formato del envío se puede revisar
 * sin tocar la red.
 */
export function previewBatch(userId, { limit = KINO_BATCH_MAX } = {}) {
  const alerts = pendingForKino(userId, { limit });
  // Dos avisos de la misma tarea (`tarea_nueva` y `tarea_por_vencer`) son un
  // solo item: Kino los resolvería igual por su llave, pero viajarían dos veces.
  // Y una tarea ya entregada no viaja: sus avisos se asientan sin crear nada.
  const items = new Map();
  const entregadas = [];
  const huerfanas = [];
  const enEspera = [];
  const listos = [];
  for (const alert of alerts) {
    const assignmentId = assignmentIdOf(alert, userId);
    // Un aviso de tarea cuya tarea no está en la base después de sincronizar
    // las tareas no es de una materia en curso (oculta, de otro ciclo): subirlo
    // sería una tarea sin materia, sin fecha y sin enlace. Se asienta sin subir,
    // como lo entregado; esperarlo sería esperar siempre.
    const exists = assignmentId && db.prepare('SELECT 1 FROM pva_assignment WHERE user_id = ? AND assignment_id = ?').get(userId, assignmentId);
    const estado = !assignmentId || !exists ? 'huerfana' : estadoDeEntrega(userId, assignmentId);
    if (estado === 'huerfana') {
      huerfanas.push(alert);
      continue;
    }
    if (estado === 'entregada') {
      entregadas.push(alert);
      continue;
    }
    if (estado === 'desconocida') {
      enEspera.push(alert);
      continue;
    }
    listos.push(alert);
    const item = itemOf(userId, alert);
    if (!items.has(item.externalId)) items.set(item.externalId, item);
  }
  return { alerts: listos, items: [...items.values()], entregadas, huerfanas, enEspera };
}

/**
 * Sube a Kino lo que el aula publicó y todavía no era una tarea.
 *
 * Devuelve siempre un resumen, nunca lanza por un fallo de red: el barrido
 * corre cada seis horas sin nadie mirando, y una excepción ahí solo consigue
 * que la vuelta siguiente empiece igual. Lo que no se pudo subir se queda sin
 * marcar y se reintenta solo.
 */
export async function pushToKino(userId, { fetchImpl = fetch, env = process.env, limit = KINO_BATCH_MAX, now = Date.now() } = {}) {
  const config = kinoConfig(env);
  if (!config) return { skipped: 'no-configurado', sent: 0 };

  const { alerts, items, entregadas, huerfanas, enEspera } = previewBatch(userId, { limit });
  // Lo que se asienta sin subir: lo entregado y los avisos sin tarea en curso.
  const sinSubir = [...entregadas, ...huerfanas];
  if (!items.length) {
    const marked = markKinoSent(sinSubir.map((alert) => alert.alertId), { now });
    return { skipped: null, sent: 0, pending: enEspera.length, marked, entregadas: entregadas.length, huerfanas: huerfanas.length, enEspera: enEspera.length };
  }

  let response;
  try {
    response = await fetchImpl(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ source: 'pva', items }),
    });
  } catch (err) {
    return { skipped: null, sent: 0, pending: items.length, error: String(err?.message ?? err) };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return { skipped: null, sent: 0, pending: items.length, status: response.status, error: body.slice(0, 200) };
  }

  const result = await response.json().catch(() => ({}));
  const marked = markKinoSent(
    [...alerts, ...sinSubir].map((alert) => alert.alertId),
    { now }
  );
  return { skipped: null, sent: items.length, marked, entregadas: entregadas.length, huerfanas: huerfanas.length, enEspera: enEspera.length, kino: result };
}

/** Cuántos avisos esperan turno, por si alguien quiere mirarlo sin subir nada. */
export function pendingCount(userId) {
  return db
    .prepare(
      `SELECT COUNT(1) AS n FROM pva_alert
       WHERE user_id = ? AND kino_at IS NULL AND kind IN (${[...KINO_KINDS].map(() => '?').join(', ')})`
    )
    .get(userId, ...KINO_KINDS).n;
}
