// Recordatorio antes de clase: la feature que usa el agente durable para el
// momento más ordinario del día académico. No consulta PeopleSoft nunca — todo
// sale del horario ya guardado.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-remind-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.MIKAMPUS_SILENT = '1';
process.env.MIKAMPUS_DATA_DIR = dir;

const { logSync } = await import('../src/db.js');
const { upsertTerm, reconcileTerms } = await import('../src/terms.js');
const { saveSchedule } = await import('../src/peoplesoft/mySchedule.js');
const reminders = await import('../src/classReminders.js');

const USER = 1;
// Un lunes cualquiera del ciclo, a las 07:40 hora local.
const LUNES = new Date(2026, 4, 4, 7, 40, 0);

try {
  upsertTerm({ code: '2245', label: 'Abril de 2026', startDate: '2026-04-20', endDate: '2026-08-10' });
  reconcileTerms({ now: LUNES });

  saveSchedule(USER, {
    term: '2245',
    termLabel: 'Abril de 2026',
    courses: [
      {
        courseCode: 'ICC-321', subject: 'ICC', catalogNbr: '321', title: 'Estructuras de Datos',
        units: 4, status: 'enrolled', grading: null, grade: null,
        sections: [{
          classNbr: '4567', section: '01', component: 'LEC', instructor: 'Ana Pérez',
          meetings: [{ days: ['Mo'], start: '08:00', end: '09:30', room: 'A-201' }],
          startDate: '2026-04-20', endDate: '2026-08-10',
        }],
      },
      {
        // Dada de baja: no es una clase a la que haya que ir.
        courseCode: 'ICC-999', subject: 'ICC', catalogNbr: '999', title: 'Materia retirada',
        units: 3, status: 'dropped', grading: null, grade: null,
        sections: [{
          classNbr: '9999', section: '01', component: 'LEC', instructor: null,
          meetings: [{ days: ['Mo'], start: '08:00', end: '09:30', room: 'B-101' }],
          startDate: '2026-04-20', endDate: '2026-08-10',
        }],
      },
    ],
  });
  logSync({ userId: USER, kind: 'mySchedule', term: '2245', status: 'ok' });

  // ── Solo lo inscrito y solo lo de hoy ────────────────────────────────────
  const hoy = reminders.todaysClasses(USER, { now: LUNES });
  assert.equal(hoy.length, 1, 'una materia dada de baja no es una clase de hoy');
  assert.equal(hoy[0].room, 'A-201');
  assert.equal(hoy[0].startsAt, 480);

  const martes = new Date(2026, 4, 5, 7, 40, 0);
  assert.equal(reminders.todaysClasses(USER, { now: martes }).length, 0, 'el martes esa clase no toca');

  // ── Apagado por defecto: no molesta sin que se lo pidan ─────────────────
  assert.equal(reminders.reminderSettings().enabled, false, 'nace apagado');
  const emitidos = [];
  assert.equal(reminders.runReminderTick(USER, { now: LUNES, emit: (e) => emitidos.push(e) }), 0);
  assert.equal(emitidos.length, 0, 'apagado no emite nada');

  // ── Encendido: avisa dentro de la ventana ───────────────────────────────
  reminders.setReminderSettings({ enabled: true, leadMinutes: 20 });
  assert.equal(reminders.reminderSettings().leadMinutes, 20);

  // 07:40 → faltan 20 min: justo en la ventana.
  const enVentana = [];
  assert.equal(reminders.runReminderTick(USER, { now: LUNES, emit: (e) => enVentana.push(e) }), 1);
  assert.match(enVentana[0].title, /Estructuras de Datos en 20 min/);
  assert.match(enVentana[0].body, /A-201/, 'el aula va primero: es lo que se necesita caminando');
  assert.match(enVentana[0].body, /Ana Pérez/);
  assert.equal(enVentana[0].link, '/horario');
  assert.match(enVentana[0].key, /class-reminder:2026-05-04:4567/, 'la clave incluye el día para no repetir hoy');

  // ── Fuera de la ventana no se avisa ─────────────────────────────────────
  const temprano = new Date(2026, 4, 4, 6, 0, 0); // faltan 2 h
  assert.equal(reminders.runReminderTick(USER, { now: temprano, emit: () => {} }), 0, 'dos horas antes es muy temprano');

  // Un agente que despierta tarde NO avisa de una clase que ya empezó: un
  // recordatorio atrasado llega cuando ya no se puede hacer nada.
  const tarde = new Date(2026, 4, 4, 8, 10, 0);
  assert.equal(reminders.runReminderTick(USER, { now: tarde, emit: () => {} }), 0, 'no se avisa de una clase en curso');

  const justoAntes = new Date(2026, 4, 4, 7, 59, 0);
  assert.equal(reminders.runReminderTick(USER, { now: justoAntes, emit: () => {} }), 0, 'con un minuto ya pasó la ventana');

  // ── El adelanto es configurable y validado ──────────────────────────────
  reminders.setReminderSettings({ leadMinutes: 45 });
  const con45 = [];
  reminders.runReminderTick(USER, { now: new Date(2026, 4, 4, 7, 16, 0), emit: (e) => con45.push(e) });
  assert.equal(con45.length, 1, 'con 45 min de adelanto avisa a las 7:16');
  assert.match(con45[0].title, /en 44 min/);

  assert.throws(() => reminders.setReminderSettings({ leadMinutes: 1 }), /entre 5 y 120/);
  assert.throws(() => reminders.setReminderSettings({ leadMinutes: 500 }), /entre 5 y 120/);
  assert.throws(() => reminders.setReminderSettings({ leadMinutes: 'pronto' }), /entre 5 y 120/);

  // ── El estado que muestra la UI ─────────────────────────────────────────
  reminders.setReminderSettings({ enabled: true, leadMinutes: 20 });
  const estado = reminders.reminderStatus(USER, { now: new Date(2026, 4, 4, 6, 0, 0) });
  assert.equal(estado.enabled, true);
  assert.equal(estado.next.title, 'Estructuras de Datos');
  assert.equal(estado.next.minutesAway, 120);
  assert.equal(estado.next.willNotify, true, 'todavía falta más que el adelanto: va a avisar');

  const yaPaso = reminders.reminderStatus(USER, { now: new Date(2026, 4, 4, 10, 0, 0) });
  assert.equal(yaPaso.next, null, 'después de la última clase no hay próxima hoy');

  console.log('✓ recordatorios de clase: solo lo inscrito, solo en ventana, nunca atrasado y apagados por defecto');
} finally {
  reminders.stopClassReminders();
  await rm(dir, { recursive: true, force: true });
}
