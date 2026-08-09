import { enrollFromCart, finishPreparedEnrollment, prepareEnrollment } from './peoplesoft/enroll.js';
import { hasLiveCredentials, hasUnattendedCredential, withPage, resetSession } from './session.js';
import { LOCAL_USER_ID } from './users.js';
import { notifyFromEvent } from './notify.js';
import { db, logAction } from './db.js';
import { readMeta, writeMeta } from './appMeta.js';
import { syncCatalogCourse } from './peoplesoft/catalog.js';
import { syncSchedule } from './peoplesoft/mySchedule.js';
import { readTerms } from './terms.js';
import { reportOperatorFailure, reportOperatorSuccess } from './operatorNotify.js';

// El scheduler del único operador persiste el disparo y el watcher para que
// sobrevivan un reinicio. user_id sigue en las tablas por compatibilidad con
// datos locales antiguos, pero el runtime solo autentica la identidad local.

// Qué mira el watcher. La distinción no es cosmética: son dos hechos distintos
// del portal y le sirven a personas distintas.
//
//   seats  — se liberó un asiento en LA sección que ya elegiste en el carrito.
//            Es lo que te deja entrar sin cambiar nada de tu horario, y es lo
//            único que puede disparar una auto-inscripción.
//   groups — apareció un NRC que antes no existía, con cupo. No es tu sección:
//            es la universidad abriendo un grupo nuevo, y sirve para decidir un
//            swap. Nunca inscribe solo.
//
// Elegir uno no cambia lo que se le pide al portal —el scan de una materia es
// el mismo y lo comparten todos los watchers—, solo qué te interrumpe. Por eso
// acotar el alcance no hace el watcher más rápido ni más liviano: lo hace menos
// ruidoso, que es el problema real.
export const WATCHER_SCOPES = ['seats', 'groups', 'both'];
export const DEFAULT_WATCHER_SCOPE = 'both';
export const WATCHER_SCOPE_LABELS = {
  seats: 'solo cupos de tus secciones',
  groups: 'solo grupos nuevos',
  both: 'cupos y grupos nuevos',
};

function scopeWatches(scope, what) {
  return scope === 'both' || scope === what;
}

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

// userId → { schedule: { atISO, timer } | null }. Solo existe la entrada del
// operador; la forma mantiene migraciones locales compatibles.
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
  const watcher = db
    .prepare('SELECT last_check_at, auto_enroll, activation_order, appointment_at, status, next_check_at, consecutive_failures, pause_reason, last_state, scope FROM watchers WHERE user_id = ?')
    .get(userId);
  return {
    schedule: s.schedule ? { atISO: s.schedule.atISO, prewarmAtISO: s.schedule.prewarmAtISO, prewarmed: s.schedule.prewarmed } : null,
    // Es el ciclo efectivo, no una promesa de que el siguiente tick global le
    // toque a ESTA materia. Con N materias y presupuesto B, una materia se
    // revisa como máximo cada ceil(N / B) ticks.
    // El ritmo configurado se sirve SIEMPRE, haya watcher o no: la pantalla
    // tiene que poder mostrarlo y dejarlo cambiar antes de encenderlo, no
    // solamente mientras corre.
    watcherSettings: {
      tickMs: watcherTickMs(),
      minTickMs: MIN_WATCHER_TICK_MS,
      maxTickMs: MAX_WATCHER_TICK_MS,
      watchedCourses: watchedCourses().length,
      effectiveIntervalMs: effectiveWatcherIntervalMs(),
    },
    watcher: watcher
      ? {
          intervalMs: effectiveWatcherIntervalMs(),
          tickMs: watcherTickMs(),
          lastCheckAt: watcher.last_check_at ?? null,
          autoEnroll: watcher.auto_enroll === 1,
          scope: watcher.scope ?? DEFAULT_WATCHER_SCOPE,
          activationOrder: watcher.activation_order,
          appointmentAt: watcher.appointment_at ?? null,
          status: watcher.status,
          nextCheckAt: watcher.next_check_at ?? null,
          consecutiveFailures: watcher.consecutive_failures ?? 0,
          pauseReason: watcher.pause_reason ?? null,
          lastState: watcher.last_state ?? null,
          queue: queuePositionsForUser(userId),
        }
      : null,
  };
}

// ── Prioridad sobre la única sesión del portal (P1) ─────────────────────────
//
// `withPage` es una fila FIFO: encolar un refresh de carrito delante de un
// submit lo retrasa de verdad, y ese retraso se mide en cupos perdidos. El
// orquestador de sincronización consulta este gate ANTES de encolar nada.
//
// Se cuentan las operaciones vivas en vez de mirar solo la tabla `schedules`
// porque una auto-inscripción disparada por el watcher es igual de crítica y no
// tiene fila propia hasta que termina.
let criticalOps = 0;

async function withEnrollmentPriority(fn) {
  criticalOps += 1;
  try {
    return await fn();
  } finally {
    criticalOps -= 1;
  }
}

// Desde el pre-warm hasta el submit, el portal es del que inscribe. El margen
// duplica PREWARM_LEAD_MS a propósito: el jitter puede adelantar el pre-warm y
// una consulta que arranca justo antes todavía estaría corriendo en T0.
const ENROLLMENT_PRIORITY_WINDOW_MS = 2 * 8 * 60_000;

/**
 * Por qué una operación no crítica no debe tocar el portal ahora. null = libre.
 */
export function portalPriorityHold(userId, now = Date.now()) {
  if (criticalOps > 0) return 'hay una inscripción en curso: el portal queda para esa operación';
  const row = db
    .prepare('SELECT at_iso, state FROM schedules WHERE user_id = ? ORDER BY at_iso LIMIT 1')
    .get(userId);
  if (!row) return null;
  if (['preparing', 'submitting'].includes(row.state)) {
    return 'hay una inscripción programada preparándose: el portal queda para esa operación';
  }
  if (row.state !== 'pending') return null;
  const at = new Date(row.at_iso).getTime();
  if (Number.isNaN(at)) return null;
  if (at - now <= ENROLLMENT_PRIORITY_WINDOW_MS && at + 60_000 >= now) {
    return 'tu inscripción programada está por dispararse: no se consulta nada más hasta que termine';
  }
  return null;
}

export async function runEnrollNow(userId, reason) {
  emit({ type: 'log', userId, message: `Ejecutando inscripción (${reason})...` });
  let result;
  try {
    result = await withEnrollmentPriority(() => withPage(userId, (page) => enrollFromCart(page), { retry: false }));
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

  return recordEnrollResult(userId, result, reason);
}

function recordEnrollResult(userId, result, reason) {
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

const PREWARM_LEAD_MS = 8 * 60_000;
const PREWARM_RETRY_MS = 60_000;
// Los logins de una misma escuela llegan concentrados a la misma hora. Si
// todos los pre-warms arrancan exactamente en T-8, solo movimos el pico de
// las 6:00 a las 5:52. El offset es estable por usuario+disparo: reparte CPU
// y tráfico, y un reinicio no reordena ni vuelve a concentrar los logins.
const PREWARM_JITTER_MS = positiveEnv('PREWARM_JITTER_MS', 3 * 60_000, 0);

function stableJitter(userId, atISO, maximum) {
  if (!maximum) return 0;
  let hash = 2166136261;
  for (const char of `${userId}:${atISO}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % (maximum + 1);
}

// Se exporta para que el ensayo del día-D pueda comprobar la distribución sin
// esperar timers reales ni abrir una sesión de PeopleSoft.
export function prewarmAtFor(userId, atISO, now = Date.now()) {
  const at = new Date(atISO).getTime();
  if (Number.isNaN(at)) throw new Error('Fecha/hora inválida');
  // Reservamos al menos un minuto antes de T0 para que un fallo de pre-warm
  // tenga una oportunidad de reintento. Un disparo creado con menos margen
  // empieza a preparar de inmediato, que es mejor que esperar al jitter.
  const latest = at - PREWARM_RETRY_MS;
  const jitter = Math.min(PREWARM_JITTER_MS, Math.max(0, PREWARM_LEAD_MS - PREWARM_RETRY_MS));
  const staggered = at - PREWARM_LEAD_MS + stableJitter(userId, atISO, jitter);
  return new Date(Math.max(now, Math.min(staggered, latest))).toISOString();
}

async function prewarmSchedule(userId, schedule) {
  if (schedule.prewarmed || Date.now() >= new Date(schedule.atISO).getTime()) return;
  if (!hasUnattendedCredential(userId)) {
    cancelSchedule(userId);
    await resetSession(userId);
    emit({ type: 'notice', userId, level: 'error', title: 'Disparo detenido: venció la autorización', body: 'Iniciá sesión y autorizalo de nuevo antes de programar una inscripción.', key: 'schedule-credentials-required' });
    return;
  }
  emit({ type: 'log', userId, message: 'Preparando sesión y asistente de inscripción…' });
  try {
    const result = await withEnrollmentPriority(() => withPage(userId, (page) => prepareEnrollment(page), { retry: true }));
    if (!result.ok) throw new Error(`PeopleSoft no dejó listo el asistente (${result.reason})`);
    schedule.prewarmed = true;
    emit({ type: 'log', userId, message: 'Disparo preparado: a la hora exacta solo se enviará la inscripción.' });
    reportOperatorSuccess(`prewarm:user:${userId}`);
  } catch (err) {
    emit({ type: 'notice', userId, level: 'error', title: 'No se pudo preparar tu inscripción', body: err.message, key: 'schedule-prewarm-error' });
    reportOperatorFailure(`prewarm:user:${userId}`, err.message).catch(() => {});
    const remaining = new Date(schedule.atISO).getTime() - Date.now();
    if (remaining > PREWARM_RETRY_MS) {
      schedule.prewarmTimer = setTimeout(() => prewarmSchedule(userId, schedule), PREWARM_RETRY_MS);
    }
  }
}

async function fireSchedule(userId, schedule) {
  // La fila no se borra antes de conocer la respuesta. Un crash/timeout entre
  // submit y respuesta es "uncertain", nunca permiso para enviar de nuevo.
  db.prepare("UPDATE schedules SET state = 'submitting', updated_at = datetime('now'), last_error = NULL WHERE user_id = ?").run(userId);
  const s = stateFor(userId);
  if (s.schedule === schedule) s.schedule = null;
  clearTimeout(schedule.prewarmTimer);
  try {
    // Si el pre-warm sobrevivió hasta T0, no hay navegación ni Step 1 aquí.
    // Si no, el fallback completo es más lento pero todavía intenta inscribir.
    if (schedule.prewarmed) {
      const prepared = await withEnrollmentPriority(() => withPage(userId, (page) => finishPreparedEnrollment(page), { retry: false }));
      if (prepared.ok) {
        const result = await recordEnrollResult(userId, prepared, 'hora programada');
        db.prepare("UPDATE schedules SET state = 'succeeded', updated_at = datetime('now') WHERE user_id = ?").run(userId);
        return result;
      }
    }
    const result = await runEnrollNow(userId, 'hora programada (sin pre-warm)');
    db.prepare(`UPDATE schedules SET state = ?, updated_at = datetime('now'), last_error = ? WHERE user_id = ?`).run(result.ok ? 'succeeded' : 'failed', result.ok ? null : result.reason ?? 'El portal rechazó la inscripción', userId);
    return result;
  } catch (err) {
    db.prepare("UPDATE schedules SET state = 'uncertain', updated_at = datetime('now'), last_error = ? WHERE user_id = ?").run(err.message, userId);
    emit({ type: 'notice', userId, level: 'error', title: 'El disparo programado falló', body: err.message, key: 'schedule-fire-error' });
    reportOperatorFailure(`schedule:user:${userId}`, err.message).catch(() => {});
    throw err;
  }
}

function armSchedule(userId, atISO) {
  const s = stateFor(userId);
  clearTimeout(s.schedule?.timer);
  clearTimeout(s.schedule?.prewarmTimer);
  const ms = new Date(atISO).getTime() - Date.now();
  const prewarmAtISO = prewarmAtFor(userId, atISO);
  const prewarmAt = Math.max(0, new Date(prewarmAtISO).getTime() - Date.now());
  const schedule = { atISO, prewarmAtISO, prewarmed: false, prewarmTimer: null, timer: null };
  schedule.prewarmTimer = setTimeout(() => prewarmSchedule(userId, schedule), prewarmAt);
  schedule.timer = setTimeout(() => fireSchedule(userId, schedule).catch(() => {}), Math.max(ms, 0));
  s.schedule = schedule;
}

export function scheduleFixedTime(userId, atISO) {
  cancelSchedule(userId);
  const at = new Date(atISO).getTime();
  if (Number.isNaN(at)) throw new Error('Fecha/hora inválida');
  if (at - Date.now() <= 0) throw new Error('La hora debe ser en el futuro');

  db.prepare(
    `INSERT INTO schedules (user_id, at_iso) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET at_iso = excluded.at_iso, state = 'pending', last_error = NULL, created_at = datetime('now'), updated_at = datetime('now')`
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
    clearTimeout(s.schedule.prewarmTimer);
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

// El ritmo del watcher es una decisión de quien lo enciende, no del despliegue.
// Antes solo se podía cambiar con WATCHER_INTERVAL_MS antes de arrancar el
// agente: para vigilar más agresivamente durante tu hora de inscripción había
// que reiniciar todo. Ahora la variable de entorno solo fija el DEFAULT y la
// preferencia vive en app_meta, donde backup/restore/erase ya la cubren.
//
// El piso de 30s no es negociable desde la UI: por debajo de eso se le pega al
// portal más rápido de lo que una página de PeopleSoft termina de cargar, y lo
// único que se consigue es que la cuenta llame la atención. El techo de una
// hora es donde "vigilar" deja de significar algo durante una inscripción.
const WATCHER_TICK_DEFAULT_MS = positiveEnv('WATCHER_INTERVAL_MS', 45_000, 30_000);
export const MIN_WATCHER_TICK_MS = 30_000;
export const MAX_WATCHER_TICK_MS = 60 * 60_000;
const WATCHER_TICK_KEY = 'watcher.tickMs';

const WATCHER_SCRAPE_BUDGET = positiveEnv('WATCHER_SCRAPE_BUDGET', 1);
const WATCHER_CAREER = process.env.SYNC_CAREER || 'GRDO';

export function watcherTickMs() {
  // El valor ausente se compara contra null y no se pasa por Number():
  // Number(null) es 0, que es finito, y sin este cuidado "nunca lo configuré"
  // se leía como "cero milisegundos" y terminaba pegado al piso de 30s.
  const raw = readMeta(WATCHER_TICK_KEY);
  if (raw == null || raw === '') return WATCHER_TICK_DEFAULT_MS;
  const stored = Number(raw);
  if (!Number.isFinite(stored)) return WATCHER_TICK_DEFAULT_MS;
  return Math.min(Math.max(Math.floor(stored), MIN_WATCHER_TICK_MS), MAX_WATCHER_TICK_MS);
}

/**
 * Cambia el ritmo y lo aplica ya: si el watcher está corriendo, el timer se
 * rearma con el valor nuevo en vez de esperar a que alguien lo apague y lo
 * vuelva a encender. `next_check_at` se recalcula sobre el último check real
 * para que la cuenta regresiva de la UI no quede mintiendo.
 */
export function setWatcherTickMs(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < MIN_WATCHER_TICK_MS || value > MAX_WATCHER_TICK_MS) {
    throw new Error(
      `El intervalo tiene que estar entre ${MIN_WATCHER_TICK_MS / 1000}s y ${MAX_WATCHER_TICK_MS / 60_000} min`
    );
  }
  writeMeta(WATCHER_TICK_KEY, String(Math.floor(value)));
  const tick = watcherTickMs();
  db.prepare('UPDATE watchers SET interval_ms = ?').run(tick);
  if (sharedTimer) {
    clearInterval(sharedTimer);
    sharedTimer = setInterval(() => runSharedWatcherTick().catch(() => {}), tick);
  }
  // La próxima consulta se recalcula en JS y no con datetime() de SQLite: la
  // columna guarda ISO-8601 con zona, y dejar que SQLite escriba su propio
  // formato produciría dos formatos distintos en la misma columna.
  const step = effectiveWatcherIntervalMs();
  for (const row of db.prepare("SELECT user_id, last_check_at AS lastCheckAt FROM watchers WHERE status = 'running'").all()) {
    const base = row.lastCheckAt ? new Date(row.lastCheckAt).getTime() : Date.now();
    db.prepare('UPDATE watchers SET next_check_at = ? WHERE user_id = ?').run(
      new Date(base + step).toISOString(),
      row.user_id
    );
  }
  publishWatcherState();
  emit({ type: 'log', message: `Ritmo del watcher: cada ${Math.round(tick / 1000)}s` });
  return tick;
}

let sharedTimer = null;
let sharedRunning = false;
let lastCourseKey = null;

// Es una costura de transporte, no una alternativa de producto: permite que
// el test ejercite el diff y la persistencia sin abrir Chromium ni tocar PUCMM.
let scanWatchedCourse = (target) =>
  withPage(LOCAL_USER_ID, (page) =>
    syncCatalogCourse(page, { term: target.term, career: target.career, courseCode: target.courseCode })
  );

export function setSharedWatcherScanner(scanner) {
  const previous = scanWatchedCourse;
  scanWatchedCourse = scanner;
  return () => {
    scanWatchedCourse = previous;
  };
}

// Igual que el scanner inyectable: permite probar la política FIFO sin abrir
// Chromium ni ejecutar una matrícula real.
let enrollWatcherCandidate = runEnrollNow;
export function setWatcherEnrollmentRunner(runner) {
  const previous = enrollWatcherCandidate;
  enrollWatcherCandidate = runner;
  return () => {
    enrollWatcherCandidate = previous;
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
       WHERE c.course_code IS NOT NULL AND w.status = 'running'
       ORDER BY c.course_code, career`
    )
    .all(WATCHER_CAREER)
    .map((row) => ({ courseCode: row.course_code, career: row.career || WATCHER_CAREER }));
}

function effectiveWatcherIntervalMs() {
  return Math.ceil(Math.max(watchedCourses().length, 1) / WATCHER_SCRAPE_BUDGET) * watcherTickMs();
}

function watchersForCourse(courseCode) {
  return db
    .prepare(
      `SELECT w.user_id AS user_id, c.class_nbr AS class_nbr,
              w.auto_enroll AS auto_enroll, w.activation_order AS activation_order,
              w.appointment_at AS appointment_at, w.scope AS scope
       FROM watchers w JOIN cart_rows c ON c.user_id = w.user_id
       WHERE c.course_code = ? AND w.status = 'running'
       ORDER BY w.activation_order, w.user_id`
    )
    .all(courseCode);
}

function queuePositionsForUser(userId) {
  const mine = db.prepare('SELECT activation_order FROM watchers WHERE user_id = ?').get(userId);
  if (!mine?.activation_order) return [];
  return db
    .prepare(
      `SELECT c.course_code AS courseCode,
              1 + (SELECT COUNT(*) FROM watchers earlier
                   JOIN cart_rows earlier_cart ON earlier_cart.user_id = earlier.user_id
                   WHERE earlier_cart.course_code = c.course_code
                     AND earlier.auto_enroll = 1
                     AND earlier.activation_order < ?) AS position,
              (SELECT COUNT(*) FROM watchers queued
                   JOIN cart_rows queued_cart ON queued_cart.user_id = queued.user_id
                   WHERE queued_cart.course_code = c.course_code
                     AND queued.auto_enroll = 1) AS total
       FROM cart_rows c
       WHERE c.user_id = ?
       GROUP BY c.course_code
       HAVING total > 1
       ORDER BY c.course_code`
    )
    .all(mine.activation_order, userId);
}

// Una fecha sin hora no autoriza una matrícula automática: antes de que el
// usuario llegue a su appointment exacto, PeopleSoft la rechazaría. El watcher
// sigue avisando; auto-enroll se habilita cuando se conoce una hora concreta
// (el disparo programado sirve como fuente) o cuando el portal la publique.
function autoEnrollEligibility(owner, now = Date.now()) {
  if (owner.auto_enroll !== 1) return { ok: false, reason: 'solo-notificar' };
  if (owner.appointment_at && now < new Date(owner.appointment_at).getTime()) return { ok: false, reason: 'antes-de-appointment' };
  if (!owner.appointment_at) {
    const window = db
      .prepare('SELECT starts_at, precision FROM enrollment_windows WHERE user_id = ? ORDER BY starts_at LIMIT 1')
      .get(owner.user_id);
    if (window?.precision !== 'datetime') return { ok: false, reason: 'appointment-sin-hora' };
    if (now < new Date(window.starts_at).getTime()) return { ok: false, reason: 'antes-de-appointment' };
  }
  if (!hasLiveCredentials(owner.user_id)) return { ok: false, reason: 'sin-credencial' };
  return { ok: true };
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
  for (const row of db.prepare('SELECT user_id, status, pause_reason FROM watchers').all()) {
    emit({ type: 'watcher-set', userId: row.user_id, enabled: row.status === 'running', status: row.status, reason: row.pause_reason ?? null, intervalMs: effectiveWatcherIntervalMs() });
  }
}

function activeWatcherCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM watchers WHERE status = 'running'").get().n;
}

function pauseWatcher(userId, status, reason) {
  db.prepare('UPDATE watchers SET status = ?, pause_reason = ?, next_check_at = NULL WHERE user_id = ?').run(status, reason, userId);
  disarmSharedWatcherIfIdle();
  emit({ type: 'watcher-set', userId, enabled: false, status, reason });
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
    db.prepare("UPDATE watchers SET last_check_at = ?, next_check_at = ?, status = 'running', consecutive_failures = 0, pause_reason = NULL, last_state = 'checked' WHERE user_id = ?")
      .run(at, new Date(new Date(at).getTime() + effectiveWatcherIntervalMs()).toISOString(), owner.user_id);
  }
  return owners;
}

async function handleCourseScan(target, progress = {}) {
  const before = seatState(target.courseCode, target.term);
  const hadBaseline = [...before.values()].some((section) => section.status != null);
  const owners = watchersForCourse(target.courseCode);
  for (const owner of owners) {
    if (!hasUnattendedCredential(owner.user_id)) {
      pauseWatcher(owner.user_id, 'credentials-required', 'La autorización o la credencial ya no está disponible');
      emit({ type: 'notice', userId: owner.user_id, level: 'error', title: 'Watcher detenido: venció la autorización', body: 'Iniciá sesión y autorizalo de nuevo para volver a consultar el portal.', key: 'watcher-credentials-required' });
    }
  }
  const credentialedOwners = watchersForCourse(target.courseCode);
  if (!credentialedOwners.length) return;

  // El watcher tarda segundos por materia y hasta ahora era una caja negra: la
  // UI solo veía el resultado. Estos eventos existen para que la pantalla pueda
  // mostrar QUÉ se está consultando mientras pasa, no solo qué pasó.
  emit({
    type: 'watcher-tick',
    phase: 'course',
    courseCode: target.courseCode,
    term: target.term,
    index: progress.index ?? 0,
    total: progress.total ?? 1,
  });

  try {
    await scanWatchedCourse(target);
    reportOperatorSuccess(`watcher:${target.courseCode}`);
  } catch (err) {
    emit({
      type: 'watcher-tick',
      phase: 'course-error',
      courseCode: target.courseCode,
      index: progress.index ?? 0,
      total: progress.total ?? 1,
      error: err.message,
    });
    for (const owner of credentialedOwners) {
      if (err?.needsCredentials || err?.credentialRejected) {
        // Un rechazo de password, MFA o CAPTCHA no se reintenta en bucle. Se
        // corta el watcher y se elimina la excepción persistida; la persona
        // deberá iniciar sesión y consentir de nuevo desde la UI.
        pauseWatcher(owner.user_id, 'credentials-required', 'PeopleSoft pidió volver a iniciar sesión o rechazó la credencial');
      } else {
        db.prepare("UPDATE watchers SET status = 'backing-off', consecutive_failures = consecutive_failures + 1, pause_reason = ?, next_check_at = ? WHERE user_id = ?")
          .run(err.message, new Date(Date.now() + effectiveWatcherIntervalMs()).toISOString(), owner.user_id);
      }
      emit({
        type: 'notice',
        userId: owner.user_id,
        level: 'error',
        title: err?.needsCredentials ? 'Watcher detenido: se requiere iniciar sesión' : `El watcher no pudo consultar ${target.courseCode}`,
        body: err?.needsCredentials ? 'El portal rechazó, pidió un paso adicional o venció la credencial. No se harán más intentos automáticos.' : err.message,
        key: `watcher-course-error:${target.courseCode}`,
      });
    }
    reportOperatorFailure(`watcher:${target.courseCode}`, err.message).catch(() => {});
    return;
  }

  const checkedAt = new Date().toISOString();
  const activeOwners = markChecked(target.courseCode, checkedAt);
  const after = seatState(target.courseCode, target.term);

  // El resultado de ESTA materia, con números: cuántas secciones se miraron y
  // cuántas quedaron abiertas. Es lo que hace que la pantalla pueda decir "3 de
  // 7 secciones abiertas" en vez de un spinner sin contenido.
  const sections = [...after.values()];
  emit({
    type: 'watcher-tick',
    phase: 'course-done',
    courseCode: target.courseCode,
    index: progress.index ?? 0,
    total: progress.total ?? 1,
    at: checkedAt,
    sections: sections.length,
    open: sections.filter((section) => section.status === 'open').length,
    // Un cambio de estado respecto del snapshot anterior es lo único que
    // justifica que alguien mire la pantalla: el resto es rutina.
    changed: sections.filter((section) => before.get(section.class_nbr)?.status !== section.status).length,
  });

  // Una primera observación llena el baseline, no anuncia como "nuevo" todo
  // el catálogo que todavía no estaba cacheado. A partir de ahí, cada NRC que
  // aparezca con cupo sí es una oportunidad distinta para elegir en el carrito.
  if (hadBaseline) {
    const newOpen = [...after.values()].filter((section) => !before.has(section.class_nbr) && section.status === 'open');
    if (newOpen.length) {
      const labels = newOpen.map((section) => `NRC ${section.class_nbr}${section.section ? ` (${section.section})` : ''}`).join(', ');
      const audience = new Set(
        activeOwners.filter((owner) => scopeWatches(owner.scope, 'groups')).map((owner) => owner.user_id)
      );
      for (const userId of audience) {
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
  // horario a alguien. Todos reciben la push de oportunidad; solo quienes
  // aceptaron auto-enroll con credencial viva entran en la cola FIFO.
  const openedByUser = new Map();
  for (const owner of activeOwners) {
    if (!scopeWatches(owner.scope, 'seats')) continue;
    const previous = before.get(owner.class_nbr);
    const current = after.get(owner.class_nbr);
    if (!previous || previous.status === 'open' || current?.status !== 'open') continue;
    const classNbrs = openedByUser.get(owner.user_id) ?? [];
    classNbrs.push(owner.class_nbr);
    openedByUser.set(owner.user_id, classNbrs);
  }
  const candidates = [];
  for (const [userId, classNbrs] of openedByUser) {
    const owner = activeOwners.find((entry) => entry.user_id === userId);
    const eligible = autoEnrollEligibility(owner);
    emit({
      type: 'notice',
      userId,
      level: 'info',
      title: `Apareció cupo en ${target.courseCode}`,
      body: eligible.ok
        ? `Tu sección (NRC ${classNbrs.join(', ')}) tiene cupo; quedaste en la fila de inscripción.`
        : `Tu sección (NRC ${classNbrs.join(', ')}) tiene cupo; entrá a confirmar.`,
      key: `watcher-seat-open:${target.courseCode}:${classNbrs.join('|')}`,
    });
    if (eligible.ok) candidates.push({ ...owner, classNbrs });
    else if (eligible.reason === 'antes-de-appointment' || eligible.reason === 'appointment-sin-hora') {
      emit({ type: 'log', userId, message: 'Hay cupo, pero tu ventana de inscripción todavía no permite auto-inscribir.' });
    }
  }

  for (const candidate of candidates.sort((a, b) => a.activation_order - b.activation_order || a.user_id - b.user_id)) {
    const position = candidates.findIndex((entry) => entry.user_id === candidate.user_id) + 1;
    emit({ type: 'log', userId: candidate.user_id, message: `Se detectó cupo nuevo — posición ${position} en la fila FIFO; inscribiendo...` });
    const result = await enrollWatcherCandidate(candidate.user_id, 'cupo detectado').catch(() => null);
    // Un resultado exitoso consume el asiento observado. Seguir enviando
    // asistentes después de eso solo castiga al portal y a quienes ya perdieron
    // el cupo; en el siguiente snapshot se abre una nueva ronda si reaparece.
    if (result?.ok && result.results.some((entry) => entry.success)) break;
  }
}

export async function runSharedWatcherTick() {
  if (sharedRunning) return false;
  const term = watcherTerm();
  const courses = watchedCourses();
  if (!courses.length || !term) return false;

  sharedRunning = true;
  const startedAt = new Date().toISOString();
  const batch = nextWatchedCourses(courses);
  try {
    emit({
      type: 'watcher-tick',
      phase: 'start',
      at: startedAt,
      total: batch.length,
      // El universo completo, no solo el lote: el watcher rota entre materias
      // para no pedirle todo al portal de una vez, y esconder eso hacía parecer
      // que solo vigilaba una.
      watching: courses.map((course) => course.courseCode),
      courses: batch.map((course) => course.courseCode),
    });
    for (const [index, course] of batch.entries()) {
      await handleCourseScan({ ...course, term }, { index, total: batch.length });
    }
    publishWatcherState();
    emit({
      type: 'watcher-tick',
      phase: 'done',
      at: new Date().toISOString(),
      total: batch.length,
      elapsedMs: Date.now() - new Date(startedAt).getTime(),
      nextCheckAt: new Date(Date.now() + effectiveWatcherIntervalMs()).toISOString(),
    });
    return true;
  } finally {
    sharedRunning = false;
  }
}

function armSharedWatcher() {
  if (sharedTimer || activeWatcherCount() === 0) return;
  runSharedWatcherTick().catch(() => {});
  sharedTimer = setInterval(() => runSharedWatcherTick().catch(() => {}), watcherTickMs());
}

function disarmSharedWatcherIfIdle() {
  if (activeWatcherCount() > 0) return;
  clearInterval(sharedTimer);
  sharedTimer = null;
  lastCourseKey = null;
}

export function startWatcher(userId, { autoEnroll = false, appointmentAt = null, scope = DEFAULT_WATCHER_SCOPE } = {}) {
  if (!WATCHER_SCOPES.includes(scope)) throw new Error(`Alcance de watcher desconocido: ${scope}`);
  // Un grupo nuevo nunca inscribe a nadie: es una sección que la persona no
  // eligió, y meterla ahí le cambiaría el horario. Por eso vigilar SOLO grupos
  // nuevos y pedir auto-inscripción es una combinación sin significado, y se
  // rechaza acá en vez de aceptarla y no cumplirla en silencio.
  if (autoEnroll && scope === 'groups') {
    throw new Error('La auto-inscripción necesita vigilar el cupo de tu sección: elegí "cupos" o "ambas"');
  }
  stopWatcher(userId);
  const activationOrder = db.prepare('SELECT COALESCE(MAX(activation_order), 0) + 1 AS next FROM watchers').get().next;
  db.prepare(
    `INSERT INTO watchers (user_id, interval_ms, auto_enroll, activation_order, appointment_at, scope)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET interval_ms = excluded.interval_ms,
       auto_enroll = excluded.auto_enroll, activation_order = excluded.activation_order,
       appointment_at = excluded.appointment_at, scope = excluded.scope, status = 'running', pause_reason = NULL,
       consecutive_failures = 0, last_started_at = datetime('now'), created_at = datetime('now')`
  ).run(userId, watcherTickMs(), autoEnroll ? 1 : 0, activationOrder, appointmentAt, scope);
  armSharedWatcher();
  publishWatcherState();
  emit({
    type: 'log',
    userId,
    message: `Watcher compartido activado (${WATCHER_SCOPE_LABELS[scope]} · ${autoEnroll ? `auto-inscripción FIFO #${activationOrder}` : 'solo notificar'} · ciclo efectivo: ${Math.round(effectiveWatcherIntervalMs() / 1000)}s)`,
  });
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

  for (const row of db.prepare("SELECT user_id, at_iso FROM schedules WHERE state = 'pending'").all()) {
    const at = new Date(row.at_iso).getTime();
    if (at <= now - LATE_FIRE_GRACE_MS) {
      db.prepare("UPDATE schedules SET state = 'missed', updated_at = datetime('now'), last_error = 'El agente estaba detenido fuera de la tolerancia' WHERE user_id = ?").run(row.user_id);
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

  const watcherCount = activeWatcherCount();
  if (watcherCount) armSharedWatcher();
  restored.watchers = watcherCount;
  return restored;
}

// Un timeout durante submit no autoriza otro submit. Al iniciar, si la
// autorización sigue disponible, refrescamos Mi Horario contra el portal y
// dejamos evidencia de la reconciliación; la UI puede mostrar el resultado y
// la persona decide cualquier acción posterior.
export async function reconcileUncertainSchedules() {
  const rows = db.prepare("SELECT user_id, at_iso FROM schedules WHERE state = 'uncertain'").all();
  for (const row of rows) {
    if (!hasUnattendedCredential(row.user_id)) {
      emit({ type: 'notice', userId: row.user_id, level: 'error', title: 'Inscripción incierta requiere revisión', body: 'El agente se detuvo durante el submit y no hay credencial vigente para reconciliar. Revisá Mi Horario antes de reintentar.', key: `schedule-uncertain:${row.at_iso}` });
      continue;
    }
    try {
      await withPage(row.user_id, (page) => syncSchedule(page, { userId: row.user_id }), { retry: true });
      db.prepare("UPDATE schedules SET state = 'reconciled', updated_at = datetime('now'), last_error = 'Mi Horario fue actualizado tras un submit incierto; verificá el resultado antes de volver a programar.' WHERE user_id = ?").run(row.user_id);
      emit({ type: 'notice', userId: row.user_id, level: 'info', title: 'Inscripción reconciliada', body: 'Actualizamos Mi Horario tras un submit incierto. No se envió ningún segundo submit.', key: `schedule-reconciled:${row.at_iso}` });
    } catch (error) {
      emit({ type: 'notice', userId: row.user_id, level: 'error', title: 'No se pudo reconciliar la inscripción incierta', body: error.message, key: `schedule-reconcile-error:${row.at_iso}` });
    }
  }
  return rows.length;
}
