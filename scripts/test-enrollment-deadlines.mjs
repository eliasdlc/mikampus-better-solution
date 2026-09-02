// El scraper de plazos por clase, contra HTML armado a mano y una base
// desechable. Cero portal.
//
// Por qué el HTML es armado y no un fixture: la pantalla de Enrollment Deadlines
// todavía no se capturó (hace falta la cuenta de Elias y una materia inscrita).
// Lo que se prueba acá es todo lo que ocurre DESPUÉS de tener el HTML, que es
// donde vive la lógica: el extractor puro, el mapeo de etiqueta a etapa, la
// lectura de fechas y la escritura que no pisa una corrección a mano. El markup
// imita las dos gramáticas reales de PeopleSoft, copiadas de los fixtures que sí
// existen: la grilla clásica PSLEVEL1GRID de recon-enrollment-appointment.html y
// las cajas Fluid ps_box-edit de recon-my-classes-view.html.
//
// Lo que este test NO puede afirmar: que PUCMM publique estas etiquetas con este
// texto. Eso se confirma el día que se capture el fixture real.
import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { browserLaunchOptions } from '../src/browser.js';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-test-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');

const { db } = await import('../src/db.js');
const { readTermEvents } = await import('../src/termEvents.js');
const {
  extractEnrollmentDeadlines,
  mapDeadlineLabel,
  deadlineDateToISO,
  parseEnrollmentDeadlines,
  saveEnrollmentDeadlines,
} = await import('../src/peoplesoft/enrollmentDeadlines.js');

// El STRM viaja en el estado de la página, igual que en Enrollment Dates.
const pageState = '<script>var state = {STRM:"1930",PAGE:"SSR_ENRL_DL"};</script>';

// Forma 1: grilla clásica con una FILA por plazo (etiqueta y fecha en celdas).
const gridRowsPerDeadline = `<!doctype html><html><head><title>Enrollment Deadlines</title>${pageState}</head><body>
<table cellspacing="0" class="PSLEVEL1GRIDWBO" id="SSR_ENRL_DL_VW$scroll$0">
<tbody><tr><td class="PSLEVEL1GRIDLABEL"><div>Enrollment Deadlines</div></td></tr>
<tr><td>
<table class="PSLEVEL1GRID">
<tbody>
<tr>
  <th scope="col" class="PSLEVEL1GRIDCOLUMNHDR">Deadline</th>
  <th scope="col" class="PSLEVEL1GRIDCOLUMNHDR">Date</th>
</tr>
<tr id="trSSR_ENRL_DL$0_row1">
  <td class="PSLEVEL1GRIDODDROW"><div id="win0divDL_DESCR$0"><span class="PSEDITBOX_DISPONLY" id="DL_DESCR$0">Last Date to Enroll</span></div></td>
  <td class="PSLEVEL1GRIDODDROW"><div id="win0divDL_DATE$0"><span class="PSLONGEDITBOX" id="DL_DATE$0">September 3, 2026</span></div></td>
</tr>
<tr id="trSSR_ENRL_DL$0_row2">
  <td class="PSLEVEL1GRIDEVENROW"><div id="win0divDL_DESCR$1"><span class="PSEDITBOX_DISPONLY" id="DL_DESCR$1">Last Date to Drop with No Penalty</span></div></td>
  <td class="PSLEVEL1GRIDEVENROW"><div id="win0divDL_DATE$1"><span class="PSLONGEDITBOX" id="DL_DATE$1">September 18, 2026</span></div></td>
</tr>
<tr id="trSSR_ENRL_DL$0_row3">
  <td class="PSLEVEL1GRIDODDROW"><div id="win0divDL_DESCR$2"><span class="PSEDITBOX_DISPONLY" id="DL_DESCR$2">Last Date to Drop with Penalty</span></div></td>
  <td class="PSLEVEL1GRIDODDROW"><div id="win0divDL_DATE$2"><span class="PSLONGEDITBOX" id="DL_DATE$2">October 30, 2026</span></div></td>
</tr>
<tr id="trSSR_ENRL_DL$0_row4">
  <td class="PSLEVEL1GRIDEVENROW"><div id="win0divDL_DESCR$3"><span class="PSEDITBOX_DISPONLY" id="DL_DESCR$3">Session Begins On</span></div></td>
  <td class="PSLEVEL1GRIDEVENROW"><div id="win0divDL_DATE$3"><span class="PSLONGEDITBOX" id="DL_DATE$3">September 1, 2026</span></div></td>
</tr>
<tr id="trSSR_ENRL_DL$0_row5">
  <td class="PSLEVEL1GRIDODDROW"><div id="win0divDL_DESCR$4"><span class="PSEDITBOX_DISPONLY" id="DL_DESCR$4">Last Date to Withdraw</span></div></td>
  <td class="PSLEVEL1GRIDODDROW"><div id="win0divDL_DATE$4"><span class="PSLONGEDITBOX" id="DL_DATE$4">November 13, 2026</span></div></td>
</tr>
<tr id="trSSR_ENRL_DL$0_row6">
  <td class="PSLEVEL1GRIDEVENROW"><div id="win0divDL_DESCR$5"><span class="PSEDITBOX_DISPONLY" id="DL_DESCR$5">Last Date to Reticulate Splines</span></div></td>
  <td class="PSLEVEL1GRIDEVENROW"><div id="win0divDL_DATE$5"><span class="PSLONGEDITBOX" id="DL_DATE$5">12/11/2026</span></div></td>
</tr>
</tbody></table>
</td></tr></tbody></table>
</body></html>`;

// Forma 2: grilla clásica con una COLUMNA por plazo, como la de Enrollment
// Dates, más las cajas Fluid de View My Classes alrededor (aula, profesor y
// horario: ruido que el extractor tiene que dejar afuera sin saber sus nombres).
const gridColumnsPlusFluid = `<!doctype html><html><head><title>Enrollment Deadlines</title>${pageState}</head><body>
<div class="ps_box-group">
  <div class="ps_box-edit" id="win0divDERIVED_SSR_FL_SSR_DRV_ROOM1$0">
    <div class="ps_box-label"><span class="ps-label">Room</span></div>
    <span class="ps_box-value" id="DERIVED_SSR_FL_SSR_DRV_ROOM1$0">TE Lab. Inform&aacute;tica II</span>
  </div>
  <div class="ps_box-edit" id="win0divDERIVED_SSR_FL_INSTR$0">
    <div class="ps_box-label"><span class="ps-label">Instructor</span></div>
    <span class="ps_box-value" id="DERIVED_SSR_FL_INSTR$0">Lisibonny Eustina Beato</span>
  </div>
  <div class="ps_box-edit" id="win0divDERIVED_SSR_FL_DAYS$0">
    <div class="ps_box-label"><span class="ps-label">Days and Times</span></div>
    <span class="ps_box-value" id="DERIVED_SSR_FL_DAYS$0">Mo 10:00AM - 1:00PM</span>
  </div>
  <div class="ps_box-edit" id="win0divDERIVED_SSR_FL_DL_LATE$0">
    <div class="ps_box-label"><span class="ps-label">Inscripci&oacute;n tard&iacute;a hasta</span></div>
    <span class="ps_box-value" id="DERIVED_SSR_FL_DL_LATE$0">10 de septiembre de 2026</span>
  </div>
</div>
<table class="PSLEVEL1GRID">
<tbody>
<tr>
  <th scope="col" class="PSLEVEL1GRIDCOLUMNHDR">Session</th>
  <th scope="col" class="PSLEVEL1GRIDCOLUMNHDR">Session Begins On</th>
  <th scope="col" class="PSLEVEL1GRIDCOLUMNHDR">Last Date to Enroll</th>
  <th scope="col" class="PSLEVEL1GRIDCOLUMNHDR">Modificaci&oacute;n de inscripci&oacute;n</th>
</tr>
<tr id="trSSR_SESSDT_VW$0_row1">
  <td class="PSLEVEL1GRIDODDROW"><span class="PSEDITBOX_DISPONLY" id="OPEN_NAME$0">Sesi&oacute;n de ocho semanas</span></td>
  <td class="PSLEVEL1GRIDODDROW"><span class="PSLONGEDITBOX" id="OPEN_START$0">September 1, 2026</span></td>
  <td class="PSLEVEL1GRIDODDROW"><span class="PSLONGEDITBOX" id="OPEN_END$0">2026-09-03</span></td>
  <td class="PSLEVEL1GRIDODDROW"><span class="PSLONGEDITBOX" id="OPEN_SWAP$0">September 8, 2026</span></td>
</tr>
</tbody></table>
</body></html>`;

const browser = await chromium.launch(await browserLaunchOptions());
const page = await browser.newPage();

try {
  // ── 1. El extractor lee las dos gramáticas ───────────────────────────────
  await page.setContent(gridRowsPerDeadline);
  const porFilas = await page.evaluate(extractEnrollmentDeadlines);
  assert.equal(porFilas.termCode, '1930', 'el STRM sale del estado de la página');
  assert.deepEqual(
    porFilas.rows.map((row) => [row.label, row.value]),
    [
      ['Last Date to Enroll', 'September 3, 2026'],
      ['Last Date to Drop with No Penalty', 'September 18, 2026'],
      ['Last Date to Drop with Penalty', 'October 30, 2026'],
      ['Session Begins On', 'September 1, 2026'],
      ['Last Date to Withdraw', 'November 13, 2026'],
      ['Last Date to Reticulate Splines', '12/11/2026'],
    ],
    'una fila por plazo: la etiqueta es la celda, no la cabecera genérica "Date"'
  );

  await page.setContent(gridColumnsPlusFluid);
  const porColumnas = await page.evaluate(extractEnrollmentDeadlines);
  assert.deepEqual(
    porColumnas.rows.map((row) => [row.label, row.value]),
    [
      ['Session Begins On', 'September 1, 2026'],
      ['Last Date to Enroll', '2026-09-03'],
      ['Modificación de inscripción', 'September 8, 2026'],
      ['Inscripción tardía hasta', '10 de septiembre de 2026'],
    ],
    'una columna por plazo: la etiqueta es la cabecera, y las cajas Fluid entran igual'
  );
  assert.equal(porColumnas.session, 'Sesión de ocho semanas', 'la sesión sale de la etiqueta que la nombra');
  assert.ok(
    !porColumnas.rows.some((row) => /Room|Instructor|Days/.test(row.label)),
    'aula, profesor y horario no tienen forma de fecha: quedan afuera sin conocer sus nombres'
  );

  // ── 2. Etiqueta a etapa: lo que se reconoce y lo que no ──────────────────
  assert.deepEqual(mapDeadlineLabel('Last Date to Enroll'), { status: 'mapeada', event: 'inscripcion-regular', edge: 'end' });
  assert.deepEqual(mapDeadlineLabel('Inscripción tardía hasta'), { status: 'mapeada', event: 'inscripcion-tardia', edge: 'end' });
  assert.deepEqual(mapDeadlineLabel('Modificación de inscripción'), { status: 'mapeada', event: 'modificacion-inscripcion', edge: 'end' });
  assert.deepEqual(mapDeadlineLabel('Last Date to Drop with Penalty'), { status: 'mapeada', event: 'retiro-parcial', edge: 'end' });
  assert.deepEqual(mapDeadlineLabel('Withdraw from all classes'), { status: 'mapeada', event: 'retiro-total', edge: 'end' });
  assert.equal(mapDeadlineLabel('Session Begins On').status, 'ignorada', 'la fecha del ciclo ya vive en terms');
  // El caso que define el módulo: un texto que admite dos lecturas no se
  // resuelve a la más parecida.
  assert.equal(mapDeadlineLabel('Last Date to Withdraw').status, 'ambigua', 'un retiro sin decir de qué no se adivina');
  assert.equal(mapDeadlineLabel('Last Date to Reticulate Splines'), null, 'lo desconocido se reporta, no se acomoda');

  // ── 3. Fechas que se pueden leer sin adivinar ────────────────────────────
  assert.equal(deadlineDateToISO('September 3, 2026'), '2026-09-03');
  assert.equal(deadlineDateToISO('10 de septiembre de 2026'), '2026-09-10');
  assert.equal(deadlineDateToISO('2026-09-03'), '2026-09-03');
  assert.throws(() => deadlineDateToISO('12/11/2026'), /ambigua/i, '12/11 es noviembre o diciembre según la región');
  assert.throws(() => deadlineDateToISO('mañana'), /no reconocida/i);

  // ── 4. El parseo completo, con su reporte ────────────────────────────────
  const parsed = parseEnrollmentDeadlines(porFilas, { term: '1930', aliases: ['1930', 'Septiembre de 2026'] });
  assert.equal(parsed.termCode, '1930');
  const porEvento = new Map(parsed.events.map((event) => [event.event, event]));
  assert.deepEqual([...porEvento.keys()].sort(), ['inscripcion-regular', 'retiro-parcial']);
  assert.deepEqual(
    [porEvento.get('inscripcion-regular').startsOn, porEvento.get('inscripcion-regular').endsOn],
    [null, '2026-09-03'],
    'un plazo es un "hasta cuándo": media ventana es el dato honesto'
  );
  // Dos etiquetas de retiro caen en la misma etapa: gana la ventana más ancha,
  // que es hasta cuándo el portal de verdad deja dar de baja.
  assert.equal(porEvento.get('retiro-parcial').endsOn, '2026-10-30');
  assert.equal(
    porEvento.get('retiro-parcial').sourceNote,
    'enrollment-deadlines: Last Date to Drop with No Penalty; Last Date to Drop with Penalty',
    'el source_note dice de qué pantalla salió y con qué etiquetas literales'
  );
  assert.ok(parsed.events.every((event) => event.source === 'portal' && event.precision === 'date'));
  assert.deepEqual(
    parsed.unmapped.map((row) => row.label),
    ['Last Date to Withdraw', 'Last Date to Reticulate Splines'],
    'lo ambiguo y lo desconocido viajan juntos en el reporte'
  );
  assert.ok(parsed.unmapped[0].reason, 'lo ambiguo dice por qué no se resolvió');
  assert.deepEqual(parsed.ignored.map((row) => row.label), ['Session Begins On']);
  assert.deepEqual(parsed.unreadable, [], 'una fecha ambigua sin etapa conocida se reporta como desconocida, no como ilegible');

  // Una fecha ilegible de una etiqueta que SÍ se reconoce no rompe la corrida:
  // se reporta con su texto literal y las demás se guardan igual.
  const conIlegible = parseEnrollmentDeadlines({
    termCode: '1930',
    session: null,
    rows: [
      { label: 'Last Date to Enroll', value: '03/09/2026' },
      { label: 'Last Date to Drop', value: 'October 30, 2026' },
    ],
  });
  assert.deepEqual(conIlegible.events.map((event) => event.event), ['retiro-parcial']);
  assert.equal(conIlegible.unreadable[0].label, 'Last Date to Enroll');
  assert.equal(conIlegible.events[0].session, 'Regular Academic Session', 'sin sesión declarada, la regular');
  // "Session Begins On" nombra un plazo, no una sesión: si se colara ahí, los
  // plazos quedarían guardados bajo una sesión inventada.
  assert.equal(porFilas.session, null, 'una etiqueta de plazo no se confunde con el nombre de la sesión');

  // Escribir los plazos de un ciclo bajo el código de otro sería inventar.
  assert.throws(
    () => parseEnrollmentDeadlines(porFilas, { term: '1940', aliases: ['1940'] }),
    /es del ciclo 1930/,
    'la pantalla manda sobre el ciclo, y si no coincide con el pedido se falla'
  );

  // ── 5. La escritura no pisa una corrección a mano ────────────────────────
  const USER = 1;
  db.prepare('INSERT OR IGNORE INTO users (id) VALUES (?)').run(USER);
  db.prepare("INSERT INTO terms (code, label, start_date, end_date) VALUES ('1930', 'Septiembre de 2026', '2026-09-01', '2026-12-07')").run();
  db.prepare(
    `INSERT INTO term_events (user_id, term_code, session, event, starts_on, ends_on, precision, source, source_note)
     VALUES (?, '1930', 'Regular Academic Session', 'retiro-parcial', NULL, '2026-11-06', 'date', 'usuario', 'me lo dijeron en secretaría')`
  ).run(USER);

  assert.equal(
    saveEnrollmentDeadlines(USER, '1930', parsed.events),
    1,
    'de los dos plazos solo se escribe uno: el otro ya lo había corregido el estudiante'
  );
  const guardado = new Map(readTermEvents(USER, '1930').map((event) => [event.event, event]));
  assert.deepEqual(
    [guardado.get('inscripcion-regular').endsOn, guardado.get('inscripcion-regular').source],
    ['2026-09-03', 'portal'],
    'lo que dijo el portal se guarda como del portal'
  );
  assert.deepEqual(
    [guardado.get('retiro-parcial').endsOn, guardado.get('retiro-parcial').source],
    ['2026-11-06', 'usuario'],
    'el scrape no borra la fecha que el estudiante corrigió'
  );

  // Segunda corrida: idempotente sobre lo suyo.
  saveEnrollmentDeadlines(USER, '1930', parsed.events);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM term_events WHERE user_id = ? AND term_code = '1930'").get(USER).n,
    2,
    'un plazo escrito dos veces sigue siendo una fila'
  );

  console.log('Scraper de plazos por clase OK: extractor, mapeo, fechas y escritura.');
} finally {
  await browser.close();
  await rm(dir, { recursive: true, force: true });
}
