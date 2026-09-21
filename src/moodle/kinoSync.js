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
  db.prepare('SELECT name, duedate FROM pva_assignment WHERE user_id = ? AND assignment_id = ?').get(userId, assignmentId) ?? null;

/**
 * El título que Elias va a leer en su lista de tareas.
 *
 * El del aviso trae el prefijo del canal ("Tarea nueva en CSTI-1930: ..."), que
 * dentro de la carpeta de la materia es ruido: la materia ya está en la
 * carpeta. Cuando la tarea existe en la base se usa su nombre real; si no, se
 * recorta el prefijo del aviso.
 */
export function titleOf(userId, alert) {
  const assignmentId = alert.subjectKey.startsWith('assign:') ? int(alert.subjectKey.slice('assign:'.length)) : null;
  if (assignmentId) {
    const row = assignmentRow(userId, assignmentId);
    if (row?.name) return text(row.name);
  }
  const sinPrefijo = alert.title.replace(/^(Tarea nueva|Tarea por vencer|Material nuevo)[^:]*:\s*/u, '');
  return text(sinPrefijo || alert.title);
}

/** El cierre publicado, en epoch ms, o undefined si la plataforma no publica ninguno. */
export function dueDateOf(userId, alert) {
  if (!alert.subjectKey.startsWith('assign:')) return undefined;
  const row = assignmentRow(userId, int(alert.subjectKey.slice('assign:'.length)));
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
  return item;
}

/**
 * Lo que subiría el próximo barrido, sin subirlo. Es lo que mira el `--dry-run`
 * del comando y lo que prueban los tests: el formato del envío se puede revisar
 * sin tocar la red.
 */
export function previewBatch(userId, { limit = KINO_BATCH_MAX } = {}) {
  const alerts = pendingForKino(userId, { limit });
  return { alerts, items: alerts.map((alert) => itemOf(userId, alert)) };
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

  const { alerts, items } = previewBatch(userId, { limit });
  if (!items.length) return { skipped: null, sent: 0, pending: 0 };

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
    alerts.map((alert) => alert.alertId),
    { now }
  );
  return { skipped: null, sent: items.length, marked, kino: result };
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
