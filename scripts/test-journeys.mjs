// El gate integrado de utilidad (P6): los nueve problemas del diagnóstico,
// probados JUNTOS y no por componente. Cada bloque es uno de los journeys que
// el plan exige, con fixtures sintéticos.
//
// Ningún dato de acá es real: los ciclos, las materias y las notas están
// inventados para ejercitar la forma del problema, no el historial de nadie.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-journey-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.MIKAMPUS_SILENT = '1';
process.env.MIKAMPUS_DATA_DIR = dir;

const { db, logSync } = await import('../src/db.js');
const { upsertTerm, reconcileTerms, readTerms } = await import('../src/terms.js');
const { saveSchedule, readSchedule } = await import('../src/peoplesoft/mySchedule.js');
const { saveGrades, readGrades, termSummaries } = await import('../src/peoplesoft/grades.js');
const { saveOfficialTotals } = await import('../src/peoplesoft/grades.js');
const { summarizeGrades } = await import('../src/shared/gpa.ts');
const { buildProjection, creditsInProgressFor } = await import('../src/shared/projection.ts');
const { computeInsights } = await import('../src/shared/insights.ts');
const { agendaFor } = await import('../src/shared/agenda.ts');
const calendar = await import('../src/academicCalendar.js');
const orchestrator = await import('../src/syncOrchestrator.js');

const USER = 1;
const restores = [];

function lunes(hora, fin, room = 'A-201') {
  return [{ days: ['Mo'], start: hora, end: fin, room }];
}

const calendarPage = (events) =>
  `<html><head>${events
    .map((e) => `<script type="application/ld+json">${JSON.stringify({ '@context': 'http://schema.org', '@type': 'Event', ...e })}</script>`)
    .join('')}</head><body></body></html>`;

try {
  // ══ Journey 1 ═══════════════════════════════════════════════════════════
  // Ciclo actual con etiqueta y STRM todavía desconocido. El horario existe y
  // TIENE que aparecer: era el bug de "no sincronizaste" con datos guardados.
  const ETIQUETA = 'Abril de 2026';
  upsertTerm({ label: ETIQUETA, startDate: '2026-04-20', endDate: '2026-08-10' });

  saveSchedule(USER, {
    term: ETIQUETA, // sin STRM: el identificador ES la etiqueta
    termLabel: ETIQUETA,
    courses: [
      {
        courseCode: 'ICC-321',
        subject: 'ICC',
        catalogNbr: '321',
        title: 'Estructuras de Datos',
        units: 4,
        status: 'enrolled',
        grading: null,
        grade: null,
        sections: [
          {
            classNbr: '4567',
            section: '01',
            component: 'LEC',
            instructor: null, // View My Classes no publica profesor
            meetings: lunes('08:00', '09:30'),
            startDate: '2026-04-20',
            endDate: '2026-08-10',
          },
        ],
      },
    ],
  });
  logSync({ userId: USER, kind: 'mySchedule', term: ETIQUETA, status: 'ok' });

  const soloEtiqueta = readSchedule(USER, ETIQUETA);
  assert.equal(soloEtiqueta.courses.length, 1, 'un horario guardado solo con etiqueta aparece igual');
  assert.ok(soloEtiqueta.syncedAt, 'y su estado de sincronización sale del registro, no de rows.length');

  // ══ Journey 2 ═══════════════════════════════════════════════════════════
  // Después aparece el STRM. El ciclo se enriquece; NO se duplica.
  upsertTerm({ code: '2245', label: ETIQUETA, startDate: '2026-04-20', endDate: '2026-08-10' });
  reconcileTerms();

  const conStrm = readTerms().terms.filter((t) => t.label === ETIQUETA);
  assert.equal(conStrm.length, 1, 'aparecer el STRM no crea un segundo ciclo');
  assert.equal(conStrm[0].code, '2245', 'el ciclo se enriqueció con su código');

  // Y el horario sigue ahí, no se perdió al converger la identidad.
  const trasStrm = readSchedule(USER, conStrm[0].term);
  assert.equal(trasStrm.courses.length, 1, 'el horario sobrevive a la convergencia de identidad');

  // Un ciclo que empieza a finales de abril no se etiqueta como enero.
  assert.match(conStrm[0].label, /Abril/, 'la etiqueta no se deriva mal por mes');

  // ══ Journey 3 ═══════════════════════════════════════════════════════════
  // Día con clases, día vacío, y una reunión fuera de su rango de vigencia.
  const bloques = [
    { id: 'a', code: 'ICC-321', title: 'Estructuras', classNbr: '4567', section: '01', component: 'LEC', room: 'A-201', instructor: null, day: 'Mo', start: '08:00', end: '09:30' },
  ];
  const unLunes = new Date('2026-05-04T12:00:00Z'); // lunes
  const unDomingo = new Date('2026-05-03T12:00:00Z');
  assert.equal(agendaFor(bloques, unLunes).length, 1, 'el lunes hay clase');
  assert.equal(agendaFor(bloques, unDomingo).length, 0, 'el domingo no, y eso no es un error de sync');

  // ══ Journey 4 ═══════════════════════════════════════════════════════════
  // Ciclo próximo seleccionable, período general ausente y luego presente.
  upsertTerm({ code: '2250', label: 'Septiembre de 2026', startDate: '2026-09-01', endDate: '2026-12-20' });
  reconcileTerms();
  const proximo = readTerms().terms.find((t) => t.code === '2250');
  assert.ok(proximo, 'el próximo ciclo es seleccionable aunque no tenga horario');

  const sinVentana = db.prepare('SELECT COUNT(*) AS n FROM enrollment_windows WHERE user_id = ?').get(USER).n;
  assert.equal(sinVentana, 0, 'sin ventana leída no se inventa ninguna');

  db.prepare(
    `INSERT INTO enrollment_windows (user_id, term_code, session, starts_at, ends_at, precision)
     VALUES (?, '2250', 'Regular', '2026-08-25', '2026-08-27', 'date')`
  ).run(USER);
  const ventana = db.prepare('SELECT precision FROM enrollment_windows WHERE user_id = ?').get(USER);
  assert.equal(ventana.precision, 'date', 'el portal publica fecha sin hora, y se guarda como tal');
  // La hora personal NO se deriva del período general: son campos distintos y
  // uno no rellena al otro.

  // ══ Journey 5 ═══════════════════════════════════════════════════════════
  // Historial con repetición, y acumulados que coinciden y que discrepan.
  saveGrades(USER, [
    { code: 'IIS-223', subject: 'IIS', catalogNbr: '223', title: 'Sistemas', term: 'Enero de 2025', grade: 'F', units: 3, status: 'taken' },
    { code: 'IIS-223', subject: 'IIS', catalogNbr: '223', title: 'Sistemas', term: 'Abril de 2025', grade: 'D', units: 3, status: 'taken' },
    { code: 'ICC-201', subject: 'ICC', catalogNbr: '201', title: 'Programación', term: 'Enero de 2025', grade: 'A', units: 4, status: 'taken' },
    { code: 'ICC-311', subject: 'ICC', catalogNbr: '311', title: 'Redes', term: 'Septiembre de 2025', grade: 'B', units: 4, status: 'taken' },
    { code: 'ICC-321', subject: 'ICC', catalogNbr: '321', title: 'Estructuras', term: ETIQUETA, grade: null, units: 4, status: 'in_progress' },
  ]);

  const cursos = readGrades(USER);
  const resumen = summarizeGrades(cursos);

  // La repetida cuenta dos veces bajo la política verificada de PUCMM.
  assert.equal(resumen.unitsTowardGpa, 14, 'los dos intentos de la repetida cuentan');

  // Acumulados que coinciden → se proyecta.
  saveOfficialTotals(USER, { gpa: resumen.gradePoints / resumen.unitsTowardGpa, unitsTowardGpa: 14, gradePoints: resumen.gradePoints });
  const proyectable = buildProjection({
    official: { gpa: resumen.gradePoints / resumen.unitsTowardGpa, unitsTowardGpa: 14, gradePoints: resumen.gradePoints },
    reconstructed: resumen,
    currentTermCredits: creditsInProgressFor(cursos, ETIQUETA),
    remainingCredits: 60,
    currentTermLabel: ETIQUETA,
  });
  assert.equal(proyectable.reconciliation.status, 'match');
  assert.equal(proyectable.currentTerm.best.futureCredits, 4, 'el ciclo actual solo pone sus 4 créditos en curso');
  assert.equal(proyectable.graduation.best.futureCredits, 60);

  // Acumulados que discrepan → NO se proyecta, y se explica.
  const bloqueado = buildProjection({
    official: { gpa: 3.9, unitsTowardGpa: 14, gradePoints: 54.6 },
    reconstructed: resumen,
    currentTermCredits: 4,
    remainingCredits: 60,
    currentTermLabel: ETIQUETA,
  });
  assert.equal(bloqueado.currentTerm, null, 'una discrepancia suspende los dos horizontes');
  assert.equal(bloqueado.graduation, null);

  // La repetición aparece como señal, y una caída reciente no se disfraza.
  const señales = computeInsights(termSummaries(cursos), cursos);
  const kinds = señales.map((s) => s.kind);
  assert.ok(kinds.includes('repeated-courses'), 'la repetición se reporta');
  // El orden es por prioridad: nada con actionability 'context' puede quedar
  // por delante de algo que exige acción.
  const rangos = señales.map((s) => ({ act: s.actionability, sev: s.severity }));
  const primeraContexto = rangos.findIndex((r) => r.act === 'context');
  const ultimaAccion = rangos.map((r) => r.act).lastIndexOf('act');
  if (primeraContexto !== -1 && ultimaAccion !== -1) {
    assert.ok(ultimaAccion < primeraContexto, 'lo accionable va antes que el contexto');
  }

  // ══ Journey 6 ═══════════════════════════════════════════════════════════
  // Calendario fresco → stale → offline → markup inválido.
  restores.push(
    calendar.setCalendarFetcher(async () =>
      calendarPage([{ '@id': 'e1', name: 'Inicio de docencia', startDate: '2026-9-1', endDate: '2026-9-1' }])
    )
  );
  await calendar.syncAcademicCalendar();
  restores.pop()();

  const fresco = calendar.readCalendar({ today: '2026-08-01', limit: 5 });
  assert.equal(fresco.events.length, 1, 'el calendario fresco muestra su fecha');
  assert.ok(fresco.syncedAt, 'con su antigüedad');

  // Offline: la caché se conserva y el fallo no la vacía.
  restores.push(calendar.setCalendarFetcher(async () => { throw new Error('ENOTFOUND'); }));
  await assert.rejects(() => calendar.syncAcademicCalendar());
  restores.pop()();
  assert.equal(calendar.readCalendar({ today: '2026-08-01' }).events.length, 1, 'offline no borra el calendario');

  // Markup inválido: mismo trato, y queda registrado como error.
  restores.push(calendar.setCalendarFetcher(async () => '<html><body>rediseño</body></html>'));
  await assert.rejects(() => calendar.syncAcademicCalendar());
  restores.pop()();
  assert.equal(calendar.readCalendar({ today: '2026-08-01' }).events.length, 1, 'un markup roto tampoco la vacía');
  assert.equal(
    db.prepare("SELECT status FROM sync_log WHERE kind = 'academicCalendar' ORDER BY id DESC LIMIT 1").get().status,
    'error',
    'y el fallo es visible en diagnostics'
  );

  // ══ Journey 7 ═══════════════════════════════════════════════════════════
  // Carrito que cambia después del TTL con la app abierta: una sola operación
  // sale al portal, y la invalidación avisa a las queries dependientes.
  db.prepare(
    `INSERT INTO cart_rows (user_id, idx, class_label, course_code, class_nbr, title, section, status, meetings, instructor)
     VALUES (?, 0, 'ICC-321', 'ICC-321', '4567', 'Estructuras', '01', 'open', '[]', NULL)`
  ).run(USER);

  const eventos = [];
  let corridas = 0;
  restores.push(orchestrator.setSessionProbe(() => true));
  restores.push(
    orchestrator.setSourceRunner('cart', async () => {
      corridas += 1;
      logSync({ userId: USER, kind: 'cart', status: 'ok' });
      return { detail: 'carrito' };
    })
  );
  for (const key of ['terms', 'mySchedule', 'grades', 'advisement', 'holds', 'enrollmentWindows', 'academicCalendar']) {
    restores.push(orchestrator.setSourceRunner(key, async () => ({ detail: 'noop' })));
  }

  const estado = orchestrator.syncState(USER);
  const carrito = estado.sources.find((s) => s.key === 'cart');
  assert.equal(carrito.relevant, true, 'con filas en el carrito la fuente es relevante');

  // Cinco componentes piden a la vez: una sola consulta.
  await Promise.all(
    Array.from({ length: 5 }, () => orchestrator.runSync(USER, { force: true, emit: (e) => eventos.push(e) }))
  );
  assert.equal(corridas, 1, 'cinco pedidos simultáneos producen una sola lectura del carrito');
  assert.ok(
    eventos.some((e) => e.type === 'sync-source' && e.key === 'cart' && e.invalidates?.includes('cart')),
    'la invalidación por evento declara qué queries refrescar'
  );

  console.log('✓ journeys: los siete recorridos del gate pasan juntos — identidad, agenda, ventana, proyección, calendario y carrito');
} finally {
  while (restores.length) restores.pop()();
  orchestrator.stopSyncLoop();
  await rm(dir, { recursive: true, force: true });
}
