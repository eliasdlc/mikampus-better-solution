import { syncCart, readCart } from './peoplesoft/cart.js';
import { enrollFromCart } from './peoplesoft/enroll.js';
import { withPage } from './session.js';
import { notifyFromEvent } from './notify.js';
import { db, logAction } from './db.js';

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

// userId → { schedule: { atISO, timer } | null, watcher: { intervalMs, timer, lastCheckAt, lastStatus } | null }
const perUser = new Map();

function stateFor(userId) {
  let s = perUser.get(userId);
  if (!s) {
    s = { schedule: null, watcher: null };
    perUser.set(userId, s);
  }
  return s;
}

export function getState(userId) {
  const s = stateFor(userId);
  return {
    schedule: s.schedule ? { atISO: s.schedule.atISO } : null,
    // lastCheckAt nace null y no en el arranque: "activo, sin chequear todavía"
    // y "activo, chequeado hace un minuto" son estados distintos y el Dashboard
    // los muestra distinto.
    watcher: s.watcher
      ? { intervalMs: s.watcher.intervalMs, lastCheckAt: s.watcher.lastCheckAt ?? null }
      : null,
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

// ── Watcher (persistido) ───────────────────────────────────────────────────

function armWatcher(userId, intervalMs) {
  const s = stateFor(userId);
  if (s.watcher) clearInterval(s.watcher.timer);
  const lastStatus = new Map();

  const tick = async () => {
    let rows;
    try {
      // El watcher ya está leyendo el carrito de este usuario: que su tick
      // alimente el cache deja el resto de la app fresca sin pedirle nada
      // extra al portal. (El watcher sobre cupos compartidos es de la Fase 4.)
      rows = await withPage(userId, (page) => syncCart(page, { userId }));
    } catch (err) {
      // Un watcher que no puede leer el carrito no está vigilando nada, y creer
      // que sí es peor que saber que está roto. El dedupe evita los 80 popups
      // por hora que serían si no.
      emit({
        type: 'notice',
        userId,
        level: 'error',
        title: 'El watcher no pudo leer el carrito',
        body: err.message,
        key: 'watcher-cart-error',
      });
      return;
    }
    // El watcher puede haberse apagado mientras este tick esperaba al portal.
    if (s.watcher) {
      s.watcher.lastCheckAt = new Date().toISOString();
      db.prepare('UPDATE watchers SET last_check_at = ? WHERE user_id = ?').run(s.watcher.lastCheckAt, userId);
    }
    emit({ type: 'cart-status', userId, rows, syncedAt: readCart(userId).syncedAt });

    let openedSomething = false;
    for (const row of rows) {
      const prev = lastStatus.get(row.index);
      if (prev && prev !== 'open' && row.status === 'open') {
        openedSomething = true;
      }
      lastStatus.set(row.index, row.status);
    }

    if (openedSomething) {
      emit({ type: 'log', userId, message: 'Se detectó cupo nuevo — inscribiendo...' });
      await runEnrollNow(userId, 'cupo detectado').catch(() => {});
    }
  };

  tick().catch(() => {});
  const timer = setInterval(() => tick().catch(() => {}), intervalMs);
  s.watcher = { intervalMs, timer, lastCheckAt: null };
}

export function startWatcher(userId, intervalMs = 45000) {
  stopWatcher(userId);
  db.prepare(
    `INSERT INTO watchers (user_id, interval_ms) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET interval_ms = excluded.interval_ms, created_at = datetime('now')`
  ).run(userId, intervalMs);
  armWatcher(userId, intervalMs);
  emit({ type: 'watcher-set', userId, enabled: true, intervalMs });
  emit({ type: 'log', userId, message: `Watcher activado (cada ${Math.round(intervalMs / 1000)}s)` });
}

export function stopWatcher(userId) {
  const s = stateFor(userId);
  db.prepare('DELETE FROM watchers WHERE user_id = ?').run(userId);
  if (s.watcher) {
    clearInterval(s.watcher.timer);
    s.watcher = null;
    emit({ type: 'watcher-set', userId, enabled: false });
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

  for (const row of db.prepare('SELECT user_id, interval_ms FROM watchers').all()) {
    armWatcher(row.user_id, row.interval_ms);
    restored.watchers++;
  }
  return restored;
}
