import { readTerms } from './terms.js';
import { readSchedule } from './peoplesoft/mySchedule.js';
import { DAY_CODES, toMinutes } from './shared/meetings.ts';
import { readMeta, writeMeta } from './appMeta.js';
import * as scheduler from './scheduler.js';

// Recordatorio antes de clase.
//
// mikampus ya sabe tu horario, ya tiene un agente que sobrevive al navegador
// cerrado y ya sabe notificar. Lo único que faltaba era usar esas tres cosas
// juntas para el momento más ordinario del día académico: estar por llegar
// tarde. El portal no puede hacer esto —no corre en tu máquina— y es
// exactamente el tipo de cosa para la que sirve un agente local.
//
// Todo el dato ya está en disco: esto no consulta PeopleSoft nunca. Un
// recordatorio no vale una navegación al portal.

const KEY_ENABLED = 'classReminders.enabled';
const KEY_LEAD = 'classReminders.leadMinutes';

const DEFAULT_LEAD_MINUTES = 20;
// Menos de 5 min no da tiempo a nada y más de 2 h deja de ser un recordatorio.
const MIN_LEAD = 5;
const MAX_LEAD = 120;

export function reminderSettings() {
  const lead = Number(readMeta(KEY_LEAD));
  return {
    enabled: readMeta(KEY_ENABLED) === '1',
    leadMinutes: Number.isFinite(lead) && lead >= MIN_LEAD && lead <= MAX_LEAD ? lead : DEFAULT_LEAD_MINUTES,
  };
}

export function setReminderSettings({ enabled, leadMinutes } = {}) {
  if (enabled !== undefined) writeMeta(KEY_ENABLED, enabled ? '1' : '0');
  if (leadMinutes !== undefined) {
    const value = Number(leadMinutes);
    if (!Number.isFinite(value) || value < MIN_LEAD || value > MAX_LEAD) {
      throw new Error(`El aviso tiene que estar entre ${MIN_LEAD} y ${MAX_LEAD} minutos antes`);
    }
    writeMeta(KEY_LEAD, String(Math.round(value)));
  }
  return reminderSettings();
}

/**
 * Las clases de hoy del ciclo en curso, con su hora de inicio en minutos.
 * Solo lo inscrito: una materia dada de baja no es una clase a la que ir.
 */
export function todaysClasses(userId, { now = new Date() } = {}) {
  const current = readTerms(now).current;
  if (!current?.term) return [];

  const schedule = readSchedule(userId, current.term);
  const today = DAY_CODES[(now.getDay() + 6) % 7]; // getDay(): 0 = domingo

  // Los bloques se arman acá y no con el toBlocks del frontend: el agente no
  // importa código de la SPA. Solo lo inscrito y solo lo de hoy.
  const blocks = [];
  for (const course of schedule.courses ?? []) {
    if (course.status !== 'enrolled') continue;
    for (const section of course.sections ?? []) {
      for (const meeting of section.meetings ?? []) {
        if (!meeting.start || !(meeting.days ?? []).includes(today)) continue;
        blocks.push({
          title: course.title ?? course.code,
          code: course.code,
          classNbr: section.classNbr,
          room: meeting.room ?? null,
          instructor: section.instructor ?? null,
          start: meeting.start,
          end: meeting.end,
          startsAt: toMinutes(meeting.start),
        });
      }
    }
  }
  return blocks.sort((a, b) => a.startsAt - b.startsAt);
}

/**
 * Qué clase merece un aviso ahora mismo.
 *
 * La ventana es [lead, lead−tick]: si el agente estuvo dormido y despierta
 * tarde, NO se avisa de una clase que ya empezó — un recordatorio atrasado es
 * peor que ninguno, porque llega cuando ya no se puede hacer nada. El dedupe
 * durable de notify.js hace el resto: la misma clase no avisa dos veces.
 */
export function dueReminders(userId, { now = new Date(), leadMinutes = DEFAULT_LEAD_MINUTES, windowMinutes = 5 } = {}) {
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  return todaysClasses(userId, { now }).filter((block) => {
    const faltan = block.startsAt - minutesNow;
    return faltan <= leadMinutes && faltan > leadMinutes - windowMinutes && faltan > 0;
  });
}

function dayStamp(now) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * Emite los avisos que corresponden a este instante. Devuelve cuántos salieron.
 */
export function runReminderTick(userId, { now = new Date(), emit = scheduler.emitEvent } = {}) {
  const { enabled, leadMinutes } = reminderSettings();
  if (!enabled) return 0;

  const due = dueReminders(userId, { now, leadMinutes });
  for (const block of due) {
    const faltan = block.startsAt - (now.getHours() * 60 + now.getMinutes());
    emit({
      type: 'notice',
      userId,
      level: 'info',
      title: `${block.title} en ${faltan} min`,
      // El aula primero: es lo que se necesita saber caminando.
      body: `${block.room ?? 'Aula por definir'} · ${block.start}–${block.end}${
        block.instructor ? ` · ${block.instructor}` : ''
      }`,
      // La clave incluye el día: la misma clase avisa mañana otra vez, pero no
      // dos veces hoy aunque el tick corra cada minuto.
      key: `class-reminder:${dayStamp(now)}:${block.classNbr}:${block.start}`,
      link: '/horario',
    });
  }
  return due.length;
}

const TICK_MS = 60_000;
let timer = null;

export function startClassReminders(userId, { emit = scheduler.emitEvent } = {}) {
  if (timer) return timer;
  timer = setInterval(() => {
    try {
      runReminderTick(userId, { emit });
    } catch (err) {
      console.warn(`[reminders] no se pudo evaluar el aviso de clase: ${err.message}`);
    }
  }, TICK_MS);
  timer.unref?.();
  return timer;
}

export function stopClassReminders() {
  clearInterval(timer);
  timer = null;
}

// Para el estado permanente de la UI: la próxima clase y si se va a avisar.
export function reminderStatus(userId, { now = new Date() } = {}) {
  const { enabled, leadMinutes } = reminderSettings();
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const next = todaysClasses(userId, { now }).find((block) => block.startsAt > minutesNow) ?? null;
  return {
    enabled,
    leadMinutes,
    next: next
      ? {
          title: next.title,
          room: next.room,
          start: next.start,
          minutesAway: next.startsAt - minutesNow,
          willNotify: enabled && next.startsAt - minutesNow > leadMinutes,
        }
      : null,
  };
}
