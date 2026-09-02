import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataPaths } from '../paths.js';
import { DAY_CODES } from '../shared/meetings.ts';
import { resolveTerms } from '../shared/terms.ts';
import * as read from './read.js';

// ── El gancho de Kino ──────────────────────────────────────────────────────
//
// Kino es el gestor de tareas de Elias. De mikampus necesita exactamente dos
// respuestas y ninguna más: "qué viene" (get_upcoming) y "qué me está frenando"
// (get_blockers). Todo lo demás, el pénsum, el índice, el catálogo, no es asunto
// suyo.
//
// Por eso get_upcoming devuelve una lista PLANA de fechas y no el modelo
// académico: Kino no debería tener que aprender qué es un STRM, una PRA ni un
// hold para poner un recordatorio. Las tres columnas que existen solo para él
// están explicadas en src/shared/mcp.ts (id, allDay, certainty).
//
// El contrato, en una línea: si allDay es true, NO hay hora publicada y Kino no
// puede poner un recordatorio a hora fija encima sin inventarla. Hoy eso aplica
// al cierre de la ventana de inscripción, que el portal publica como fecha
// pelada. Del lado de Kino no se implementa nada acá.

const DAY_MS = 86_400_000;

// La fecha de calendario LOCAL. toISOString daría la fecha UTC, y en República
// Dominicana (UTC-4) eso adelanta un día cada noche: a las 21:00 del lunes las
// clases del lunes ya no aparecerían.
export function localDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// El cursor de días se ancla en medianoche UTC de una fecha de calendario ya
// resuelta, así que su día de la semana se lee en UTC y no arrastra zona.
function dayCodeOfDate(date) {
  const index = (date.getUTCDay() + 6) % 7;
  return DAY_CODES[index];
}

// Expande las reuniones de un conjunto de materias inscritas a bloques con fecha
// concreta dentro de un rango, recortando contra las fechas reales de cada
// inscripción: una PRA de ocho semanas no se dibuja hasta diciembre.
export function expandBlocks(courses, fromIso, toIso) {
  const blocks = [];
  for (const course of courses) {
    for (const section of course.sections) {
      for (const meeting of section.meetings) {
        if (!meeting.start || !meeting.end || meeting.days.length === 0) continue;
        for (
          let cursor = new Date(`${fromIso}T00:00:00Z`);
          cursor.toISOString().slice(0, 10) <= toIso;
          cursor = new Date(cursor.getTime() + DAY_MS)
        ) {
          const date = cursor.toISOString().slice(0, 10);
          if (!meeting.days.includes(dayCodeOfDate(cursor))) continue;
          if (course.startDate && date < course.startDate) continue;
          if (course.endDate && date > course.endDate) continue;
          blocks.push({
            date,
            day: dayCodeOfDate(cursor),
            start: meeting.start,
            end: meeting.end,
            room: meeting.room,
            courseCode: course.code,
            title: course.title,
            component: section.component,
            section: section.section,
            instructor: section.instructor,
            term: course.term,
          });
        }
      }
    }
  }
  return blocks.sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`));
}

function atTime(dateIso, hhmm) {
  return `${dateIso}T${hhmm}:00`;
}

// El agente vivo se detecta por su lock, no por la base: un proceso muerto deja
// su fila de runtime abierta igual. src/runtime.js no se puede importar acá
// porque arrastra la conexión de escritura, así que se lee el mismo archivo.
export function agentState() {
  const lockFile = path.join(dataPaths().runtime, 'agent.lock.json');
  let lock = null;
  try {
    lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  } catch {
    return { running: false, port: null, since: null };
  }
  let alive = false;
  try {
    process.kill(lock.pid, 0);
    alive = true;
  } catch (error) {
    alive = error.code === 'EPERM';
  }
  return { running: alive, port: alive ? lock.port ?? null : null, since: alive ? lock.startedAt ?? null : null };
}

// Los ciclos resueltos contra hoy, con el identificador que usa el resto de la
// app (STRM si existe, si no la etiqueta).
export function resolveCycle(now = new Date()) {
  const rows = read.readTermRows();
  const resolution = resolveTerms(rows, now);
  const withSchedule = read.termsWithSchedule();
  const withSections = read.termsWithSections();
  const terms = resolution.terms.map((term) => {
    const id = term.code ?? term.label;
    return {
      term: id,
      code: term.code,
      label: term.label,
      startDate: term.startDate,
      endDate: term.endDate,
      isCurrent: term.isCurrent,
      isNext: term.isNext,
      hasSchedule: withSchedule.has(id),
      hasSections: withSections.has(id),
    };
  });
  return {
    terms,
    current: terms.find((term) => term.isCurrent) ?? null,
    next: terms.find((term) => term.isNext) ?? null,
  };
}

function classItems(now, until) {
  const cycle = resolveCycle(now);
  const fromIso = localDate(now);
  const toIso = localDate(until);
  const items = [];

  for (const term of [cycle.current, cycle.next].filter(Boolean)) {
    const courses = read.readEnrollments(read.LOCAL_USER_ID, term.term).filter((course) => course.status === 'enrolled');
    for (const block of expandBlocks(courses, fromIso, toIso)) {
      items.push({
        id: `class:${term.term}:${block.courseCode}:${block.section ?? block.component ?? 'x'}:${block.date}`,
        kind: 'class',
        title: `${block.courseCode} ${block.title}`,
        startsAt: atTime(block.date, block.start),
        endsAt: atTime(block.date, block.end),
        allDay: false,
        precision: 'datetime',
        source: 'portal',
        certainty: 'published',
        detail: [block.component, block.section, block.room].filter(Boolean).join(' · ') || null,
        blocking: false,
      });
    }
  }
  return items;
}

function windowItems(now, until, closingIds) {
  const items = [];
  for (const window of read.readEnrollmentWindows()) {
    const allDay = window.precision !== 'datetime';
    for (const [suffix, kind, when, label] of [
      ['open', 'enrollment_window_open', window.startsAt, 'Abre la inscripción'],
      ['close', 'enrollment_window_close', window.endsAt, 'Cierra la inscripción'],
    ]) {
      if (!when) continue;
      const startsAt = allDay ? `${when.slice(0, 10)}T00:00:00` : when;
      if (new Date(startsAt) < now || new Date(startsAt) > until) continue;
      const id = `window:${window.termCode}:${suffix}`;
      items.push({
        id,
        kind,
        title: `${label} (${window.termCode})`,
        startsAt,
        endsAt: null,
        allDay,
        precision: allDay ? 'date' : 'datetime',
        source: 'portal',
        certainty: 'published',
        detail: window.session,
        blocking: closingIds.has(id),
      });
    }
  }
  return items;
}

function termBoundaryItems(now, until) {
  const items = [];
  for (const term of resolveCycle(now).terms) {
    for (const [suffix, kind, when, label] of [
      ['start', 'term_start', term.startDate, 'Empieza el ciclo'],
      ['end', 'term_end', term.endDate, 'Termina el ciclo'],
    ]) {
      if (!when) continue;
      const startsAt = `${when}T00:00:00`;
      if (new Date(startsAt) < now || new Date(startsAt) > until) continue;
      items.push({
        id: `term:${term.term}:${suffix}`,
        kind,
        title: `${label} ${term.label ?? term.term}`,
        startsAt,
        endsAt: null,
        allDay: true,
        precision: 'date',
        source: 'portal',
        certainty: 'published',
        detail: null,
        blocking: false,
      });
    }
  }
  return items;
}

function localItems(now, until) {
  const items = [];
  const scheduled = read.readScheduledEnroll();
  if (scheduled?.atIso && scheduled.state === 'pending') {
    const at = new Date(scheduled.atIso);
    if (at >= now && at <= until) {
      items.push({
        id: `scheduled-enroll:${scheduled.atIso}`,
        kind: 'scheduled_enroll',
        title: 'mikampus intentará inscribir automáticamente',
        startsAt: scheduled.atIso,
        endsAt: null,
        allDay: false,
        precision: 'datetime',
        source: 'local',
        certainty: 'published',
        detail: 'Disparo programado por vos en mikampus',
        blocking: false,
      });
    }
  }
  const watcher = read.readWatcher();
  if (watcher?.appointmentAt) {
    const at = new Date(watcher.appointmentAt);
    if (at >= now && at <= until) {
      items.push({
        id: `watcher-appointment:${watcher.appointmentAt}`,
        kind: 'watcher_appointment',
        title: 'Turno de inscripción vigilado',
        startsAt: watcher.appointmentAt,
        endsAt: null,
        allDay: false,
        precision: 'datetime',
        source: 'local',
        certainty: 'derived',
        detail: 'Hora cargada en el vigilante de cupos',
        blocking: false,
      });
    }
  }
  return items;
}

// Los cierres de ventana que además frenan. Se calcula acá y lo consumen las
// dos herramientas, para que `blocking` de get_upcoming y get_blockers no puedan
// discrepar.
function closingWindowIds(now) {
  const ids = new Set();
  for (const window of read.readEnrollmentWindows()) {
    if (!window.endsAt) continue;
    const endsAt = new Date(`${window.endsAt.slice(0, 10)}T23:59:59`).getTime();
    const daysLeft = Math.floor((endsAt - now.getTime()) / DAY_MS);
    if (daysLeft >= 0 && daysLeft <= 3) ids.add(`window:${window.termCode}:close`);
  }
  return ids;
}

export function getUpcoming({ horizonDays = 14, now = new Date() } = {}) {
  const until = new Date(now.getTime() + horizonDays * DAY_MS);
  const closingIds = closingWindowIds(now);

  const items = [
    ...classItems(now, until),
    ...windowItems(now, until, closingIds),
    ...termBoundaryItems(now, until),
    ...localItems(now, until),
  ].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));

  // La revisión es el hash del conjunto: un poll que devuelve la misma no tiene
  // nada que reescribir del lado de Kino.
  const revision = crypto
    .createHash('sha256')
    .update(items.map((item) => `${item.id}|${item.startsAt}|${item.endsAt ?? ''}`).join('\n'))
    .digest('hex')
    .slice(0, 12);

  return { revision, horizonDays, generatedAt: now.toISOString(), items };
}

// ── Qué está frenando a Elias ──────────────────────────────────────────────
// La única herramienta que cruza varias tablas para contestar algo que ninguna
// sabe sola. Es heterogénea a propósito: un hold del portal y un dataset viejo
// frenan igual, y quien pregunta no quiere dos listas.
export function getBlockers({ now = new Date() } = {}) {
  const blockers = [];

  for (const hold of read.readHolds()) {
    blockers.push({
      kind: 'hold',
      severity: hold.severity === 'blocking' ? 'alta' : 'media',
      title: hold.title,
      detail:
        hold.severity === 'unknown'
          ? `${hold.description ?? 'Sin descripción'}. El portal no dijo si este hold bloquea la inscripción.`
          : hold.description ?? 'Sin descripción',
      since: hold.capturedAt,
      actionHint: 'Resolvelo en la oficina que corresponda; mikampus no puede levantarlo.',
    });
  }

  for (const window of read.readEnrollmentWindows()) {
    const endsAt = window.endsAt ? `${window.endsAt.slice(0, 10)}T23:59:59` : null;
    if (!endsAt) continue;
    const daysLeft = Math.floor((new Date(endsAt).getTime() - now.getTime()) / DAY_MS);
    if (daysLeft < 0) {
      blockers.push({
        kind: 'enrollment_window_closed',
        severity: 'media',
        title: `La inscripción del ciclo ${window.termCode} ya cerró`,
        detail: `Cerró el ${window.endsAt.slice(0, 10)}. Cambiar tu carga pasa por secretaría.`,
        since: window.endsAt,
        actionHint: 'Llevá tu lista de materias a la oficina de la secretaría.',
      });
    } else if (daysLeft <= 3) {
      blockers.push({
        kind: 'enrollment_window_closing',
        severity: 'alta',
        title: `Quedan ${daysLeft} día(s) de inscripción para el ciclo ${window.termCode}`,
        detail: `La ventana cierra el ${window.endsAt.slice(0, 10)}. El portal publicó fecha sin hora.`,
        since: window.startsAt,
        actionHint: 'Cerrá tu selección de materias antes de esa fecha.',
      });
    }
  }

  const cart = read.readCart();
  const closed = cart.filter((row) => row.status === 'closed');
  if (closed.length > 0) {
    blockers.push({
      kind: 'cart_has_closed_sections',
      severity: 'alta',
      title: `${closed.length} de ${cart.length} secciones del carrito están cerradas`,
      detail: `Sin cupo: ${closed.map((row) => `${row.courseCode ?? row.title} ${row.section ?? ''}`.trim()).join(', ')}.`,
      since: closed[0].capturedAt,
      actionHint: 'Buscá otra sección o poné un vigilante de cupo.',
    });
  }

  const cycle = resolveCycle(now);
  const target = cycle.current ?? cycle.next;
  if (target) {
    const enrolled = read.readEnrollments(read.LOCAL_USER_ID, target.term).filter((c) => c.status === 'enrolled');
    if (enrolled.length === 0) {
      blockers.push({
        kind: 'nothing_enrolled',
        severity: 'alta',
        title: `No tenés materias inscritas en ${target.label ?? target.term}`,
        detail: 'El horario local de ese ciclo está vacío.',
        since: null,
        actionHint: 'Sincronizá tu horario; si de verdad está vacío, inscribí.',
      });
    } else if (enrolled.length === 1) {
      blockers.push({
        kind: 'nothing_enrolled',
        severity: 'media',
        title: `Solo tenés 1 materia inscrita en ${target.label ?? target.term}`,
        detail: `Inscrita: ${enrolled[0].code} ${enrolled[0].title}.`,
        since: null,
        actionHint: 'Revisá si falta completar tu carga académica.',
      });
    }
  }

  for (const item of read.freshnessFor(['mySchedule', 'cart', 'grades', 'advisement', 'holds'], { now: now.getTime() })) {
    if (item.neverSynced) {
      blockers.push({
        kind: 'never_synced',
        severity: 'media',
        title: `${item.kind} nunca se leyó del portal`,
        detail: 'No es que no haya datos: esa pantalla jamás se abrió, así que no se sabe.',
        since: null,
        actionHint: 'Sincronizá ese dataset antes de sacar conclusiones.',
      });
    } else if (item.stale) {
      blockers.push({
        kind: 'stale_data',
        severity: 'baja',
        title: `${item.kind} está viejo (${item.ageMinutes} minutos)`,
        detail: `Última lectura ok: ${item.syncedAt}.`,
        since: item.syncedAt,
        actionHint: 'Actualizalo si vas a decidir con eso.',
      });
    }
  }

  const watcher = read.readWatcher();
  if (watcher && watcher.status === 'monitoring-gap') {
    blockers.push({
      kind: 'monitoring_gap',
      severity: 'media',
      title: 'El vigilante de cupos tiene un hueco sin vigilar',
      detail: watcher.pauseReason ?? 'El agente estuvo apagado mientras había un vigilante activo.',
      since: watcher.lastCheckAt,
      actionHint: 'Revisá el cupo a mano y reactivá el vigilante.',
    });
  }

  if (!agentState().running) {
    blockers.push({
      kind: 'agent_down',
      severity: 'media',
      title: 'El agente de mikampus no está corriendo',
      detail: 'Lo local se puede leer igual, pero nada se sincroniza ni se inscribe mientras esté apagado.',
      since: read.lastRuntimeEvent()?.startedAt ?? null,
      actionHint: 'Arrancá mikampus.',
    });
  }

  for (const warning of read.termIntegrityWarnings()) {
    blockers.push({
      kind: 'data_integrity',
      severity: 'media',
      title: 'Los ciclos guardados tienen datos inconsistentes',
      detail: warning.detail,
      since: null,
      actionHint: 'Arrancá mikampus para que corra la reparación de identidad de ciclos.',
    });
  }

  const order = { alta: 0, media: 1, baja: 2 };
  return blockers.sort((a, b) => order[a.severity] - order[b.severity]);
}
