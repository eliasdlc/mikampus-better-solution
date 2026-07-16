import { getCartStatus } from './peoplesoft/cart.js';
import { enrollFromCart } from './peoplesoft/enroll.js';
import { withPage } from './session.js';
import { notify } from './notify.js';

const listeners = new Set();
export function onEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(event) {
  for (const fn of listeners) fn(event);
}

// El feed de actividad (SSE) es de toda la app, no solo del scheduler: otras
// operaciones en vivo (leer el horario, refrescar cupos) también publican acá.
export const emitEvent = emit;

const state = {
  schedule: null, // { atISO, timer }
  watcher: null, // { intervalMs, timer, lastStatus }
};

export function getState() {
  return {
    schedule: state.schedule ? { atISO: state.schedule.atISO } : null,
    watcher: state.watcher ? { intervalMs: state.watcher.intervalMs } : null,
  };
}

export async function runEnrollNow(reason) {
  emit({ type: 'log', message: `Ejecutando inscripción (${reason})...` });
  let result;
  try {
    result = await withPage((page) => enrollFromCart(page));
  } catch (err) {
    emit({ type: 'log', message: `Error ejecutando inscripción: ${err.message}` });
    notify('PUCMM Autoenroll — Error', err.message, { urgency: 'critical' });
    throw err;
  }

  if (!result.ok) {
    emit({ type: 'log', message: `No se pudo completar: ${result.reason}` });
    notify('PUCMM Autoenroll', `No se pudo procesar el carrito: ${result.reason}`, {
      urgency: 'critical',
    });
    return result;
  }

  const successes = result.results.filter((r) => r.success);
  const failures = result.results.filter((r) => !r.success);
  emit({ type: 'enroll-result', results: result.results, reason });

  if (successes.length > 0) {
    notify('PUCMM Autoenroll — ¡Inscrito!', successes.map((s) => s.classLabel).join(', '));
  }
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
      rows = await withPage((page) => getCartStatus(page));
    } catch (err) {
      emit({ type: 'log', message: `Error leyendo el carrito: ${err.message}` });
      return;
    }
    emit({ type: 'cart-status', rows });

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
  state.watcher = { intervalMs, timer };
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
