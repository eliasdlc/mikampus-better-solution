import { syncCart, readCart } from './peoplesoft/cart.js';
import { enrollFromCart } from './peoplesoft/enroll.js';
import { withPage } from './session.js';
import { notifyFromEvent } from './notify.js';
import { LOCAL_USER_ID } from './users.js';

const listeners = new Set();
export function onEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Todo evento pasa por la política de notificaciones antes de llegar al SSE:
// nadie decide por su cuenta si molestar al usuario (ver notify.js). Un fallo
// notificando no puede tumbar la operación que lo emitió — la notificación es
// el accesorio, la inscripción es el trabajo.
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

const state = {
  schedule: null, // { atISO, timer }
  watcher: null, // { intervalMs, timer, lastCheckAt }
};

export function getState() {
  return {
    schedule: state.schedule ? { atISO: state.schedule.atISO } : null,
    // lastCheckAt nace null y no en el arranque: "activo, sin chequear todavía"
    // y "activo, chequeado hace un minuto" son estados distintos y el Dashboard
    // los muestra distinto.
    watcher: state.watcher
      ? { intervalMs: state.watcher.intervalMs, lastCheckAt: state.watcher.lastCheckAt ?? null }
      : null,
  };
}

export async function runEnrollNow(reason) {
  emit({ type: 'log', message: `Ejecutando inscripción (${reason})...` });
  let result;
  try {
    result = await withPage(LOCAL_USER_ID, (page) => enrollFromCart(page), { retry: false });
  } catch (err) {
    emit({
      type: 'notice',
      level: 'error',
      title: 'La inscripción falló',
      body: err.message,
      key: 'enroll-error',
    });
    throw err;
  }

  if (!result.ok) {
    emit({
      type: 'notice',
      level: 'error',
      title: 'No se pudo procesar el carrito',
      body: result.reason,
      key: `enroll-not-ok:${result.reason}`,
    });
    return result;
  }

  const failures = result.results.filter((r) => !r.success);
  emit({ type: 'enroll-result', results: result.results, reason });

  if (failures.length > 0) {
    emit({
      type: 'log',
      message: `Sin cupo todavía: ${failures.map((f) => f.classLabel).join(', ')}`,
    });
  }
  return result;
}

export function scheduleFixedTime(atISO) {
  cancelSchedule();
  const at = new Date(atISO).getTime();
  if (Number.isNaN(at)) throw new Error('Fecha/hora inválida');
  const ms = at - Date.now();
  if (ms <= 0) throw new Error('La hora debe ser en el futuro');

  const timer = setTimeout(() => {
    state.schedule = null;
    runEnrollNow('hora programada').catch(() => {});
  }, ms);
  state.schedule = { atISO, timer };
  emit({ type: 'schedule-set', atISO });
  emit({ type: 'log', message: `Inscripción programada para ${new Date(at).toLocaleString('es-DO')}` });
}

export function cancelSchedule() {
  if (state.schedule) {
    clearTimeout(state.schedule.timer);
    state.schedule = null;
    emit({ type: 'schedule-set', atISO: null });
    emit({ type: 'log', message: 'Programación cancelada' });
  }
}

export function startWatcher(intervalMs = 45000) {
  stopWatcher();
  const lastStatus = new Map();

  const tick = async () => {
    let rows;
    try {
      // El watcher ya está leyendo el carrito cada 45s: que su tick alimente el
      // cache deja el resto de la app fresca sin pedirle nada extra al portal.
      // Un solo watcher por ahora (el del usuario local); se vuelve por-usuario
      // con los timers persistidos de la Fase 2.
      rows = await withPage(LOCAL_USER_ID, (page) => syncCart(page, { userId: LOCAL_USER_ID }));
    } catch (err) {
      // Un watcher que no puede leer el carrito no está vigilando nada, y creer
      // que sí es peor que saber que está roto. El dedupe evita los 80 popups
      // por hora que serían si no.
      emit({
        type: 'notice',
        level: 'error',
        title: 'El watcher no pudo leer el carrito',
        body: err.message,
        key: 'watcher-cart-error',
      });
      return;
    }
    // El watcher puede haberse apagado mientras este tick esperaba al portal.
    if (state.watcher) state.watcher.lastCheckAt = new Date().toISOString();
    emit({ type: 'cart-status', rows, syncedAt: readCart(LOCAL_USER_ID).syncedAt });

    let openedSomething = false;
    for (const row of rows) {
      const prev = lastStatus.get(row.index);
      if (prev && prev !== 'open' && row.status === 'open') {
        openedSomething = true;
      }
      lastStatus.set(row.index, row.status);
    }

    if (openedSomething) {
      emit({ type: 'log', message: 'Se detectó cupo nuevo — inscribiendo...' });
      await runEnrollNow('cupo detectado').catch(() => {});
    }
  };

  tick().catch(() => {});
  const timer = setInterval(() => tick().catch(() => {}), intervalMs);
  state.watcher = { intervalMs, timer, lastCheckAt: null };
  emit({ type: 'watcher-set', enabled: true, intervalMs });
  emit({ type: 'log', message: `Watcher activado (cada ${Math.round(intervalMs / 1000)}s)` });
}

export function stopWatcher() {
  if (state.watcher) {
    clearInterval(state.watcher.timer);
    state.watcher = null;
    emit({ type: 'watcher-set', enabled: false });
    emit({ type: 'log', message: 'Watcher desactivado' });
  }
}
