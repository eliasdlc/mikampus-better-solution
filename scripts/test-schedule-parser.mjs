// Corre el parser de Mi Horario (View My Classes, Fluid) contra el HTML real
// volcado por el recon (fixtures/, sin datos personales) y luego la capa de
// escritura contra una DB desechable. Nada de esto toca el portal.
import { chromium } from 'playwright';
import { browserLaunchOptions } from '../src/browser.js';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-test-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');

const { extractSchedule, toSchedule, saveSchedule, readSchedule, pickTermRow, codeForLabel } = await import(
  '../src/peoplesoft/mySchedule.js'
);

const browser = await chromium.launch(await browserLaunchOptions());
const page = await browser.newPage();

try {
  await page.setContent(await readFile('fixtures/recon-my-classes-view.html', 'utf8'));
  const raw = await page.evaluate(extractSchedule);

  // ── Parser (extracción cruda) ──────────────────────────────────────────────
  // View My Classes no expone el STRM: la identidad del ciclo es su etiqueta.
  assert.equal(raw.termLabel, 'Abril de 2026', 'la etiqueta sale de TERM_VAL_TBL_DESCR');
  // Seis contenedores de materia en el fixture: 4 inscritas + 2 dadas de baja.
  assert.equal(raw.courses.length, 6, 'la pantalla trae inscritas y dadas de baja mezcladas');
  assert.deepEqual(
    raw.courses.map((c) => c.status),
    ['Enrolled', 'Enrolled', 'Enrolled', 'Enrolled', 'Dropped', 'Dropped'],
    'el estado viene por materia (DRV_STAT)'
  );
  const ile = raw.courses[3];
  assert.equal(ile.subject, 'ILE');
  assert.equal(ile.catalogNbr, '498', 'el subject se quita del catalog_nbr ("ILE498" → 498)');
  assert.equal(ile.units, '4.00');
  assert.equal(ile.sections[0].componentClass, 'Lecture - 3307', 'componente + class number juntos');
  assert.equal(ile.sections[0].days, 'Days: Tuesday Thursday');
  assert.equal(ile.sections[0].times, 'Times: 10:00AM to 12:00PM');

  console.log('✓ fixtures/recon-my-classes-view.html (extracción)');

  // ── toSchedule: descarta bajas, agrupa, normaliza ──────────────────────────
  const schedule = toSchedule(raw, { term: 'Abril de 2026' });
  assert.equal(schedule.term, 'Abril de 2026', 'sin STRM conocido, el término se keyea por etiqueta');
  assert.equal(schedule.courses.length, 4, 'las 2 materias dadas de baja no entran al horario');
  assert.ok(
    !schedule.courses.some((c) => c.status === 'dropped'),
    'ninguna materia dada de baja sobrevive'
  );

  const icc303 = schedule.courses.find((c) => c.courseCode === 'ICC-303');
  assert.equal(icc303.status, 'enrolled', 'la ICC-303 inscrita (no la dada de baja) es la que queda');
  assert.equal(icc303.units, 4);
  // Dos class numbers → dos secciones (LEC + PRA), cada una con su reunión.
  assert.deepEqual(
    icc303.sections.map((s) => s.classNbr),
    ['5822', '5823']
  );
  assert.deepEqual(
    icc303.sections.map((s) => s.component),
    ['LEC', 'PRA'],
    'el componente se normaliza al código del catálogo'
  );
  assert.deepEqual(icc303.sections[0].meetings, [
    { days: ['Mo'], start: '10:00', end: '13:00', room: 'TE Lab. Informática II' },
  ]);
  assert.equal(icc303.sections[0].startDate, '2026-04-29');
  assert.equal(icc303.sections[0].endDate, '2026-08-04', 'las fechas sobreviven para el ICS');

  // "To be Announced" → aula null (una materia sin aula asignada).
  const icc371 = schedule.courses.find((c) => c.courseCode === 'ICC-371');
  assert.equal(icc371.sections[0].meetings[0].room, null, 'aula "To be Announced" se guarda como null');

  console.log('✓ toSchedule (descarta bajas, agrupa por class number, normaliza)');

  // ── Capa de escritura ──────────────────────────────────────────────────────
  assert.equal(saveSchedule(1, schedule), 7, 'guarda las 7 secciones de las 4 materias inscritas');

  // Keyeado por etiqueta: la tabla `terms` conoce el ciclo por su etiqueta y su
  // ventana, con STRM null (View My Classes no lo da).
  const { readTerms } = await import('../src/terms.js');
  const abril = readTerms(new Date(2026, 6, 17)).terms.find((t) => t.label === 'Abril de 2026');
  assert.ok(abril, 'el ciclo quedó en la tabla terms por su etiqueta');
  assert.equal(abril.code, null, 'sin STRM conocido, code queda null (no se inventa)');
  assert.equal(abril.startDate, '2026-04-29', 'la ventana sale de las fechas de las secciones');
  assert.equal(abril.hasSchedule, true, 'hasSchedule reconoce inscripciones keyeadas por etiqueta');
  assert.equal(abril.isCurrent, true, 'el 17 de julio de 2026, Abril es el ciclo en curso');

  const read = readSchedule(1, 'Abril de 2026');
  assert.equal(read.courses.length, 4);
  const rIcc303 = read.courses.find((c) => c.code === 'ICC-303');
  assert.equal(rIcc303.units, 4);
  assert.equal(rIcc303.status, 'enrolled');
  assert.equal(rIcc303.sections.length, 2);
  assert.deepEqual(rIcc303.sections[0].meetings, [
    { days: ['Mo'], start: '10:00', end: '13:00', room: 'TE Lab. Informática II' },
  ]);

  // codeForLabel: ahora que existe un STRM para otra etiqueta, se resuelve.
  saveSchedule(2, {
    term: '1930',
    termLabel: 'Septiembre de 2026',
    courses: [
      {
        courseCode: 'ICC-233',
        subject: 'ICC',
        catalogNbr: '233',
        title: 'Seguridad',
        status: 'enrolled',
        units: 4,
        grading: null,
        grade: null,
        sections: [{ classNbr: '9001', section: null, component: 'LEC', instructor: null, meetings: [], startDate: '2026-09-01', endDate: '2026-12-07' }],
      },
    ],
  });
  assert.equal(codeForLabel('Septiembre de 2026'), '1930', 'codeForLabel resuelve el STRM que otra fuente aportó');
  assert.equal(codeForLabel('Abril de 2026'), null, 'sin STRM conocido, codeForLabel devuelve null');

  // Re-sync no duplica.
  saveSchedule(1, schedule);
  assert.equal(readSchedule(1, 'Abril de 2026').courses.length, 4, 're-sync no duplica');

  // Una baja (materia que desaparece del portal) desaparece del horario.
  saveSchedule(1, { term: 'Abril de 2026', termLabel: 'Abril de 2026', courses: [] });
  assert.equal(readSchedule(1, 'Abril de 2026').courses.length, 0, 'una baja desaparece del horario');

  console.log('✓ capa de escritura del horario (etiqueta, STRM opcional, baja, re-sync)');

  // ── Selección de término (grilla de ciclos) ────────────────────────────────
  const rows = [
    { id: 'SSR_ENTRMCUR_VW_TERM_DESCR30$0', label: 'Abril de 2026' },
    { id: 'SSR_ENTRMCUR_VW_TERM_DESCR30$1', label: 'Septiembre de 2026' },
  ];
  assert.equal(pickTermRow(rows, 'Septiembre de 2026').id, 'SSR_ENTRMCUR_VW_TERM_DESCR30$1', 'matchea por etiqueta');
  assert.equal(pickTermRow(rows, null).id, 'SSR_ENTRMCUR_VW_TERM_DESCR30$0', 'sin pedido, el primero (el actual)');
  assert.equal(pickTermRow([], null), null, 'lista vacía sin pedido: nada que elegir');
  assert.throws(
    () => pickTermRow(rows, 'Enero de 2025'),
    /no está disponible/,
    'un ciclo ausente (pasado) es error, no un silencioso ciclo ajeno'
  );
  console.log('✓ selección de término (pickTermRow: etiqueta, default, ausente)');

  console.log('\nMi Horario OK contra HTML real (View My Classes).');
} finally {
  await browser.close();
  await rm(dir, { recursive: true, force: true });
}
