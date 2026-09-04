import { db, schemaState } from './db.js';
import { readAgentLock, processIsAlive } from './runtime.js';
import { credentialInfo } from './credentialStore.js';
import { backupState } from './backups.js';
import { runtimeMode } from './onboarding.js';
import { currentVersion, lastUpdateCheck, updatePolicy, updateState } from './updates.js';
import { SCHEMA_VERSION } from './migrations.js';

// El estado que la UI muestra SIEMPRE (Fase 4 §3). La pregunta que responde no
// es "¿la app está abierta?" sino "¿mikampus está trabajando para mí ahora
// mismo, y hasta cuándo?". Un watcher que se ve "activo" mientras el agente
// está muerto es peor que no mostrar nada: promete una vigilancia que no
// existe, y el cupo se pierde igual.

function agentInfo() {
  const lock = readAgentLock();
  const running = Boolean(lock && processIsAlive(lock.pid));
  const event = db
    .prepare("SELECT started_at AS startedAt FROM runtime_events WHERE kind = 'agent' AND ended_at IS NULL ORDER BY id DESC LIMIT 1")
    .get();
  return {
    running,
    pid: lock?.pid ?? null,
    port: lock?.port ?? null,
    startedAt: event?.startedAt ?? lock?.startedAt ?? null,
    version: currentVersion(),
  };
}

// El intervalo que nadie vigiló: el agente se cayó, el equipo durmió o hubo un
// reboot. Es parte del producto, no un detalle técnico — si un cupo abrió y
// cerró acá adentro, mikampus no lo puede reconstruir después.
//
// Tres condiciones, y las tres existen porque sin ellas el aviso se volvió
// permanente y falso: un reinicio ordenado de minuto y medio quedaba fijo en la
// barra, en rojo, prometiendo un cupo perdido en una instalación que no estaba
// vigilando nada.

// Por debajo de esto no es un hueco de vigilancia, es un reinicio. El watcher
// consulta cada 45 s y ya se recupera solo de unos ticks perdidos.
const GAP_MIN_MS = 10 * 60_000;
// Un hueco de la semana pasada no informa ninguna decisión de hoy.
const GAP_MAX_AGE_MS = 24 * 60 * 60_000;

function monitoringGap(now = new Date()) {
  const row = db
    .prepare("SELECT started_at AS startedAt, ended_at AS endedAt, detail FROM runtime_events WHERE kind = 'agent' ORDER BY id DESC LIMIT 2")
    .all();
  const previous = row[1];
  const current = row[0];
  if (!previous?.endedAt || !current?.startedAt) return null;
  const ms = new Date(current.startedAt).getTime() - new Date(previous.endedAt).getTime();
  if (!Number.isFinite(ms) || ms < GAP_MIN_MS) return null;
  if (now.getTime() - new Date(current.startedAt).getTime() > GAP_MAX_AGE_MS) return null;
  // Y sobre todo: solo hay "intervalo no vigilado" si había algo vigilándose.
  // recordRuntimeStart marca 'monitoring-gap' exactamente a los watchers que el
  // corte interrumpió; sin ninguno, nadie perdió un cupo.
  const interrupted = db.prepare("SELECT COUNT(*) AS n FROM watchers WHERE status = 'monitoring-gap'").get();
  if (!interrupted?.n) return null;
  return { from: previous.endedAt, to: current.startedAt, ms, watchers: interrupted.n, detail: current.detail ?? null };
}

function watcherInfo(userId) {
  const row = db
    .prepare(
      `SELECT status, last_check_at AS lastCheckAt, next_check_at AS nextCheckAt, consecutive_failures AS consecutiveFailures,
              pause_reason AS pauseReason, auto_enroll AS autoEnroll, appointment_at AS appointmentAt, scope
       FROM watchers WHERE user_id = ?`
    )
    .get(userId);
  if (!row) return null;
  return { ...row, autoEnroll: row.autoEnroll === 1 };
}

function scheduleInfo(userId) {
  const row = db
    .prepare('SELECT at_iso AS atISO, state, last_error AS lastError FROM schedules WHERE user_id = ? ORDER BY at_iso LIMIT 1')
    .get(userId);
  return row ?? null;
}

/**
 * El estado completo de la instalación para una sesión autenticada.
 */
export function fullStatus(userId, { now = new Date() } = {}) {
  const agent = agentInfo();
  const watcher = watcherInfo(userId);
  const schedule = scheduleInfo(userId);
  const mode = runtimeMode() ?? 'desktop';
  const credential = credentialInfo();

  // Desktop solo vigila con el equipo despierto: si hay trabajo desatendido
  // pendiente, la UI tiene que decirlo antes de que alguien cierre la tapa.
  const unattendedWork = Boolean(
    (watcher && ['running', 'backing-off', 'monitoring-gap'].includes(watcher.status)) ||
      (schedule && ['pending', 'preparing'].includes(schedule.state))
  );

  return {
    now: now.toISOString(),
    agent,
    mode,
    schema: { version: SCHEMA_VERSION, applied: schemaState.applied, migratedFrom: schemaState.from, preUpgradeBackup: schemaState.backup },
    watcher,
    schedule,
    monitoringGap: monitoringGap(now),
    credential,
    backup: backupState(now),
    update: { policy: updatePolicy(), lastCheck: lastUpdateCheck(), inProgress: updateState() },
    power: {
      mustStayAwake: mode === 'desktop' && unattendedWork,
      note:
        mode === 'desktop'
          ? 'En Local Desktop, dormir, hibernar o apagar el equipo pausa el watcher y los disparos programados.'
          : 'En Home Server, la continuidad depende de que ese equipo, su red y su corriente sigan activos.',
    },
  };
}
