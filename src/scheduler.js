import { enrollFromCart } from './peoplesoft/enroll.js';
import { withPage, SERVICE_USER_ID } from './session.js';
import { notifyFromEvent } from './notify.js';
import { db, logAction } from './db.js';
import { syncCatalogCourse } from './peoplesoft/catalog.js';
import { readTerms } from './terms.js';

// El scheduler por usuario (Fase 2): cada estudiante tiene SU disparo a hora
// fija y SU watcher, persistidos en DB (tablas schedules/watchers) — si el
// server se reinicia a las 5:59am, el disparo de las 6:00 sobrevive. En
// memoria viven solo los setTimeout, que restoreTimers() rearma al arrancar.

const listeners = new Set();
export function onEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Todo evento pasa por la política de notificaciones antes de llegar al SSE:
// nadie decide por su cuenta si molestar al usuario (ver notify.js). Un fallo
// notificando no puede tumbar la operación que lo emitió — la notificación es
// el accesorio, la inscripción es el trabajo.
//
// Los eventos personales llevan userId; el SSE de cada usuario filtra por él
// (un evento sin userId es de la app entera y lo ven todos).
function emit(event) {
  try {
    notifyFromEvent(event);
  } catch (err) {
    console.warn(`[notify] no se pudo notificar: ${err.message}`);
  }
  for (const fn of listeners) fn(event);
}

// El feed de actividad (SSE) es de toda la app, no solo del scheduler: otras
// operaciones en vivo (leer el horario, refrescar cupos) también publican acá.
export const emitEvent = emit;

// userId → { schedule: { atISO, timer } | null }. Los watchers no tienen timer
// propio: desde L4 hay un solo loop de la cuenta de servicio para todos.
const perUser = new Map();

function stateFor(userId) {
  let s = perUser.get(userId);
  if (!s) {
    s = { schedule: null };
    perUser.set(userId, s);
  }
  return s;
}

export function getState(userId) {
  const s = stateFor(userId);
  const watcher = db.prepare('SELECT last_check_at FROM watchers WHERE user_id = ?').get(userId);
  return {
    schedule: s.schedule ? { atISO: s.schedule.atISO } : null,
    // Es el ciclo efectivo, no una promesa de que el siguiente tick global le
    // toque a ESTA materia. Con N materias y presupuesto B, una materia se
    // revisa como máximo cada ceil(N / B) ticks.
    watcher: watcher ? { intervalMs: effectiveWatcherIntervalMs(), lastCheckAt: watcher.last_check_at ?? null } : null,
  };
}

export async function runEnrollNow(userId, reason) {
  emit({ type: 'log', userId, message: `Ejecutando inscripción (${reason})...` });
  let result;
  try {
    result = await withPage(userId, (page) => enrollFromCart(page), { retry: false });
  } catch (err) {
    // No se sabe si el submit llegó: el audit log lo dice tal cual (ok NULL).
    logAction({ userId, action: 'enroll', detail: reason, response: err.message, ok: null });
    emit({
      type: 'notice',
      userId,
      level: 'error',
      title: 'La inscripción falló',
      body: err.message,
      key: 'enroll-error',
    });
    throw err;
  }

  if (!result.ok) {
    logAction({ userId, action: 'enroll', detail: reason, response: result.reason, ok: false });
    emit({
      type: 'notice',
      userId,
      level: 'error',
      title: 'No se pudo procesar el carrito',
      body: result.reason,
      key: `enroll-not-ok:${result.reason}`,
    });
    return result;
  }

  // Una fila del audit log por materia, con la respuesta literal del portal
  // ("Success: ..." / "Error: Class 4521 is full"): la feature de confianza
  // del §8 se escribe acá, en el momento.
  for (const r of result.results) {
    logAction({ userId, action: 'enroll', detail: r.classLabel, response: r.message, ok: r.success });
  }

  const failures = result.results.filter((r) => !r.success);
  emit({ type: 'enroll-result', userId, results: result.results, reason });

  if (failures.length > 0) {
    emit({
      type: 'log',
      userId,
      message: `Sin cupo todavía: ${failures.map((f) => f.classLabel).join(', ')}`,
    });
  }
  return result;
}

// ── Disparo a hora fija (persistido) ───────────────────────────────────────

function armSchedule(userId, atISO) {
  const s = stateFor(userId);
  clearTimeout(s.schedule?.timer);
  const ms = new Date(atISO).getTime() - Date.now();
  const timer = setTimeout(() => {
    s.schedule = null;
    db.prepare('DELETE FROM schedules WHERE user_id = ?').run(userId);
    runEnrollNow(userId, 'hora programada').catch(() => {});
  }, Math.max(ms, 0));
  s.schedule = { atISO, timer };
}

export function scheduleFixedTime(userId, atISO) {
  cancelSchedule(userId);
  const at = new Date(atISO).getTime();
  if (Number.isNaN(at)) throw new Error('Fecha/hora inválida');
  if (at - Date.now() <= 0) throw new Error('La hora debe ser en el futuro');

  db.prepare(
    `INSERT INTO schedules (user_id, at_iso) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET at_iso = excluded.at_iso, created_at = datetime('now')`
  ).run(userId, new Date(at).toISOString());
  armSchedule(userId, new Date(at).toISOString());
  emit({ type: 'schedule-set', userId, atISO });
  emit({ type: 'log', userId, message: `Inscripción programada para ${new Date(at).toLocaleString('es-DO')}` });
}

export function cancelSchedule(userId) {
  const s = stateFor(userId);
  db.prepare('DELETE FROM schedules WHERE user_id = ?').run(userId);
  if (s.schedule) {
    clearTimeout(s.schedule.timer);
    s.schedule = null;
    emit({ type: 'schedule-set', userId, atISO: null });
    emit({ type: 'log', userId, message: 'Programación cancelada' });
  }
}

// ── Watcher compartido (persistido) ───────────────────────────────────────
//
// El carrito es una preferencia personal, pero el cupo de ICC-321 es el mismo
// para todos. Leer N carritos cada 45s era N sesiones y N navegaciones para
// descubrir ese único dato. Ahora los carritos cacheados forman la unión de
// materias vigiladas y la cuenta de servicio consulta cada materia una vez.

function positiveEnv(name, fallback, minimum = 1) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum ? Math.floor(value) : fallback;
}

const WATCHER_TICK_MS = positiveEnv('WATCHER_INTERVAL_MS', 45_000, 30_000);
const WATCHER_SCRAPE_BUDGET = positiveEnv('WATCHER_SCRAPE_BUDGET', 1);
const WATCHER_CAREER = process.env.SYNC_CAREER || 'GRDO';

let sharedTimer = null;
let sharedRunning = false;
let lastCourseKey = null;

// Es una costura de transporte, no una alternativa de producto: permite que
// el test ejercite el diff y la persistencia sin abrir Chromium ni tocar PUCMM.
let scanWatchedCourse = (target) =>
  withPage(SERVICE_USER_ID, (page) =>
    syncCatalogCourse(page, { term: target.term, career: target.career, courseCode: target.courseCode })
  );

export function setSharedWatcherScanner(scanner) {
  const previous = scanWatchedCourse;
  scanWatchedCourse = scanner;
  return () => {
    scanWatchedCourse = previous;
  };
}

function watcherTerm() {
  // El scraper necesita un STRM; una etiqueta como "Septiembre de 2026" no
  // sirve para el select del portal. SYNC_TERM permite operar antes del primer
  // sync de términos, como ya lo hace el cron de catálogo.
  return process.env.SYNC_TERM || readTerms().next?.code || null;
}

function watchedCourses() {
  return db
    .prepare(
      `SELECT DISTINCT c.course_code AS course_code, COALESCE(k.career, ?) AS career
       FROM watchers w
       JOIN cart_rows c ON c.user_id = w.user_id
       LEFT JOIN courses k ON k.code = c.course_code
       WHERE c.course_code IS NOT NULL
       ORDER BY c.course_code, career`
    )
    .all(WATCHER_CAREER)
    .map((row) => ({ courseCode: row.course_code, career: row.career || WATCHER_CAREER }));
}

function effectiveWatcherIntervalMs() {
  return Math.ceil(Math.max(watchedCourses().length, 1) / WATCHER_SCRAPE_BUDGET) * WATCHER_TICK_MS;
}

function watchersForCourse(courseCode) {
  return db
    .prepare(
      `SELECT w.user_id AS user_id, c.class_nbr AS class_nbr
       FROM watchers w JOIN cart_rows c ON c.user_id = w.user_id
       WHERE c.course_code = ?`
    )
    .all(courseCode);
}

function seatState(courseCode, term) {
  return new Map(
    db
      .prepare(
        `SELECT s.class_nbr AS class_nbr, s.section AS section, latest.status AS status
         FROM sections s
         JOIN courses c ON c.id = s.course_id
         LEFT JOIN seats_snapshot latest ON latest.id = (
           SELECT id FROM seats_snapshot WHERE section_id = s.id ORDER BY captured_at DESC, id DESC LIMIT 1
         )
         WHERE c.code = ? AND s.term = ?`
      )
      .all(courseCode, term)
      .map((row) => [row.class_nbr, row])
  );
}

function publishWatcherState() {
  for (const row of db.prepare('SELECT user_id FROM watchers').all()) {
    emit({ type: 'watcher-set', userId: row.user_id, enabled: true, intervalMs: effectiveWatcherIntervalMs() });
  }
}

function nextWatchedCourses(courses) {
  if (!courses.length) return [];
  const start = Math.max(
    courses.findIndex((course) => `${course.courseCode}:${course.career}` === lastCourseKey) + 1,
    0
  );
  const selected = Array.from({ length: Math.min(WATCHER_SCRAPE_BUDGET, courses.length) }, (_, offset) =>
    courses[(start + offset) % courses.length]
  );
  lastCourseKey = `${selected.at(-1).courseCode}:${selected.at(-1).career}`;
  return selected;
}

function markChecked(courseCode, at) {
  const owners = watchersForCourse(courseCode);
  for (const owner of owners) {
    db.prepare('UPDATE watchers SET last_check_at = ? WHERE user_id = ?').run(at, owner.user_id);
  }
  return owners;
}

async function handleCourseScan(target) {
  const before = seatState(target.courseCode, target.term);
  const hadBaseline = [...before.values()].some((section) => section.status != null);
  const owners = watchersForCourse(target.courseCode);

  try {
    await scanWatchedCourse(target);
  } catch (err) {
    for (const owner of owners) {
      emit({
        type: 'notice',
        userId: owner.user_id,
        level: 'error',
        title: `El watcher no pudo consultar ${target.courseCode}`,
        body: err.message,
        key: `watcher-course-error:${target.courseCode}`,
      });
    }
    return;
  }

  const checkedAt = new Date().toISOString();
  const activeOwners = markChecked(target.courseCode, checkedAt);
  const after = seatState(target.courseCode, target.term);

  // Una primera observación llena el baseline, no anuncia como "nuevo" todo
  // el catálogo que todavía no estaba cacheado. A partir de ahí, cada NRC que
  // aparezca con cupo sí es una oportunidad distinta para elegir en el carrito.
  if (hadBaseline) {
    const newOpen = [...after.values()].filter((section) => !before.has(section.class_nbr) && section.status === 'open');
    if (newOpen.length) {
      const labels = newOpen.map((section) => `NRC ${section.class_nbr}${section.section ? ` (${section.section})` : ''}`).join(', ');
      for (const userId of new Set(activeOwners.map((owner) => owner.user_id))) {
        emit({
          type: 'notice',
          userId,
          level: 'info',
          title: `Abrieron grupo nuevo de ${target.courseCode}`,
          body: `${labels} tiene cupo. Entrá al carrito para cambiar de sección.`,
          key: `watcher-new-section:${target.courseCode}:${newOpen.map((section) => section.class_nbr).join('|')}`,
        });
      }
    }
  }

  // Solo la sección que el usuario eligió puede disparar inscripción. Otra
  // sección abierta es una sugerencia de swap, no permiso para cambiarle el
  // horario a alguien. La cola FIFO/appointment-aware se incorpora en la capa
  // siguiente; por ahora se conserva el comportamiento de auto-enroll previo.
  const openedByUser = new Map();
  for (const owner of activeOwners) {
    const previous = before.get(owner.class_nbr);
    const current = after.get(owner.class_nbr);
    if (!previous || previous.status === 'open' || current?.status !== 'open') continue;
    const classNbrs = openedByUser.get(owner.user_id) ?? [];
    classNbrs.push(owner.class_nbr);
    openedByUser.set(owner.user_id, classNbrs);
  }
  for (const [userId, classNbrs] of openedByUser) {
    emit({
      type: 'notice',
      userId,
      level: 'info',
      title: `Apareció cupo en ${target.courseCode}`,
      body: `Tu sección (NRC ${classNbrs.join(', ')}) tiene cupo; intentando inscribirte.`,
      key: `watcher-seat-open:${target.courseCode}:${classNbrs.join('|')}`,
    });
    emit({ type: 'log', userId, message: 'Se detectó cupo nuevo — inscribiendo...' });
    await runEnrollNow(userId, 'cupo detectado').catch(() => {});
  }
}

export async function runSharedWatcherTick() {
  if (sharedRunning) return false;
  const term = watcherTerm();
  const courses = watchedCourses();
  if (!courses.length || !term) return false;

  sharedRunning = true;
  try {
    for (const course of nextWatchedCourses(courses)) {
      await handleCourseScan({ ...course, term });
    }
    publishWatcherState();
    return true;
  } finally {
    sharedRunning = false;
  }
}

function armSharedWatcher() {
  if (sharedTimer || db.prepare('SELECT COUNT(*) AS n FROM watchers').get().n === 0) return;
  runSharedWatcherTick().catch(() => {});
  sharedTimer = setInterval(() => runSharedWatcherTick().catch(() => {}), WATCHER_TICK_MS);
}

function disarmSharedWatcherIfIdle() {
  if (db.prepare('SELECT COUNT(*) AS n FROM watchers').get().n > 0) return;
  clearInterval(sharedTimer);
  sharedTimer = null;
  lastCourseKey = null;
}

export function startWatcher(userId) {
  stopWatcher(userId);
  db.prepare(
    `INSERT INTO watchers (user_id, interval_ms) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET interval_ms = excluded.interval_ms, created_at = datetime('now')`
  ).run(userId, WATCHER_TICK_MS);
  armSharedWatcher();
  publishWatcherState();
  emit({ type: 'log', userId, message: `Watcher compartido activado (ciclo efectivo: ${Math.round(effectiveWatcherIntervalMs() / 1000)}s)` });
}

export function stopWatcher(userId) {
  const existed = db.prepare('SELECT 1 FROM watchers WHERE user_id = ?').get(userId);
  db.prepare('DELETE FROM watchers WHERE user_id = ?').run(userId);
  if (existed) {
    disarmSharedWatcherIfIdle();
    emit({ type: 'watcher-set', userId, enabled: false });
    publishWatcherState();
    emit({ type: 'log', userId, message: 'Watcher desactivado' });
  }
}

// ── Restauración al arrancar ───────────────────────────────────────────────
// Un disparo cuya hora pasó mientras el server estaba caído se ejecuta igual
// si el atraso es corto (el reboot de las 5:59 no puede costar el cupo de las
// 6:00); si ya pasó hace rato, avisar es más honesto que someter un carrito
// viejo sin que nadie lo pida.
const LATE_FIRE_GRACE_MS = 30 * 60_000;

export function restoreTimers(now = Date.now()) {
  const restored = { schedules: 0, watchers: 0, dropped: 0 };

  for (const row of db.prepare('SELECT user_id, at_iso FROM schedules').all()) {
    const at = new Date(row.at_iso).getTime();
    if (at <= now - LATE_FIRE_GRACE_MS) {
      db.prepare('DELETE FROM schedules WHERE user_id = ?').run(row.user_id);
      emit({
        type: 'notice',
        userId: row.user_id,
        level: 'error',
        title: 'Tu inscripción programada no se ejecutó',
        body: `El server estuvo caído a las ${new Date(at).toLocaleString('es-DO')}. Programala de nuevo o inscribí ahora.`,
        key: `schedule-missed:${row.at_iso}`,
      });
      restored.dropped++;
      continue;
    }
    armSchedule(row.user_id, row.at_iso);
    restored.schedules++;
  }

  const watcherCount = db.prepare('SELECT COUNT(*) AS n FROM watchers').get().n;
  if (watcherCount) armSharedWatcher();
  restored.watchers = watcherCount;
  return restored;
}
