// Corre el parser de Mi Horario contra el HTML real volcado por el recon
// (fixtures/, sin datos personales) y luego la capa de escritura contra una DB
// desechable. Nada de esto toca el portal.
import { chromium } from 'playwright';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-test-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');

const { extractSchedule, saveSchedule, readSchedule, pickTermRadio } = await import('../src/peoplesoft/mySchedule.js');
const { scrapedScheduleSchema, normalizeEnrollStatus } = await import('../src/shared/schemas.ts');
const { parseMeetings, normalizeComponent, parseDateRange } = await import('../src/shared/meetings.ts');

const browser = await chromium.launch();
const page = await browser.newPage();

try {
  await page.setContent(await readFile('fixtures/recon-schedule-list.html', 'utf8'));
  const raw = await page.evaluate(extractSchedule);

  // ── Parser ───────────────────────────────────────────────────────────────
  // El código de término no está en pantalla: sale del objeto JS del portal.
  assert.equal(raw.term, '1930', 'el término se lee de PIA_KEYSTRUCT');
  // La etiqueta en español sí está en pantalla: es la que cruza el STRM con el
  // vocabulario de grades (el modelo de tiempo de la Fase 6 depende de esto).
  assert.equal(raw.termLabel, 'Septiembre de 2026', 'la etiqueta sale de la cabecera del estudiante');
  assert.equal(raw.courses.length, 1, 'una materia inscrita en el fixture');

  const c = raw.courses[0];
  assert.equal(c.subject, 'ICC');
  assert.equal(c.catalogNbr, '233', 'el subject se quita del catalog_nbr ("ICC233" → 233)');
  // Lo que el class search NO da y esta pantalla sí — por eso es la fuente del
  // diccionario de títulos y créditos.
  assert.equal(c.title, 'Seg. en Tecnología Información');
  assert.equal(c.units, '4.00');
  assert.equal(c.status, 'Enrolled');
  assert.equal(c.grading, 'Calificación Ordinaria');

  // Dos componentes (LEC + PRA) bajo una sola materia, con índice global.
  assert.equal(c.sections.length, 2, 'la LEC y su PRA van juntas bajo la materia');
  assert.deepEqual(c.sections.map((s) => s.classNbr), ['5225', '5226']);
  assert.deepEqual(c.sections.map((s) => s.section), ['101', '171']);
  assert.deepEqual(c.sections.map((s) => s.component), ['Lecture', 'Practicum']);
  assert.equal(c.sections[0].dayTime, 'Sa 10:00AM - 1:00PM');
  assert.equal(c.sections[1].dayTime, 'Th 6:00PM - 9:00PM');
  assert.equal(c.sections[0].instructor, 'Rafael Miguel Dorville Collado');

  // El componente se normaliza al mismo código que usa el catálogo, si no las
  // dos fuentes se pisarían al escribir la misma sección.
  assert.equal(normalizeComponent(c.sections[0].component), 'LEC');
  assert.equal(normalizeComponent(c.sections[1].component), 'PRA');
  assert.deepEqual(parseMeetings(c.sections[0].dayTime, c.sections[0].room), [
    { days: ['Sa'], start: '10:00', end: '13:00', room: null },
  ]);
  assert.deepEqual(parseDateRange(c.sections[0].dates), { start: '2026-09-01', end: '2026-12-07' });

  console.log('✓ fixtures/recon-schedule-list.html (parser)');

  // ── Capa de escritura ────────────────────────────────────────────────────
  const schedule = scrapedScheduleSchema.parse({
    term: raw.term,
    termLabel: raw.termLabel,
    courses: raw.courses.map((x) => ({
      courseCode: `${x.subject}-${x.catalogNbr}`,
      subject: x.subject,
      catalogNbr: x.catalogNbr,
      title: x.title,
      status: normalizeEnrollStatus(x.status),
      units: Number(x.units),
      grading: x.grading,
      grade: x.grade || null,
      sections: x.sections.map((s) => {
        const { start, end } = parseDateRange(s.dates);
        return {
          classNbr: s.classNbr,
          section: s.section,
          component: normalizeComponent(s.component),
          instructor: s.instructor,
          meetings: parseMeetings(s.dayTime, s.room),
          startDate: start,
          endDate: end,
        };
      }),
    })),
  });

  assert.equal(saveSchedule(1, schedule), 2, 'guarda las dos secciones');

  // saveSchedule cruza el término: el STRM, su etiqueta y su ventana quedan en
  // una sola fila de `terms` — el cimiento del modelo de tiempo.
  const { readTerms } = await import('../src/terms.js');
  const term1930 = readTerms(new Date(2026, 6, 17)).terms.find((t) => t.code === '1930');
  assert.equal(term1930.label, 'Septiembre de 2026', 'la etiqueta se persistió junto al STRM');
  assert.equal(term1930.startDate, '2026-09-01', 'la ventana sale de MTG_DATES');
  assert.equal(term1930.isNext, true, 'en julio de 2026, 1930 es el ciclo siguiente');

  const read = readSchedule(1, '1930');
  assert.equal(read.courses.length, 1);
  assert.equal(read.courses[0].code, 'ICC-233');
  assert.equal(read.courses[0].title, 'Seg. en Tecnología Información');
  assert.equal(read.courses[0].units, 4);
  assert.equal(read.courses[0].status, 'enrolled');
  assert.equal(read.courses[0].sections.length, 2);
  assert.deepEqual(read.courses[0].sections[0].meetings, [
    { days: ['Sa'], start: '10:00', end: '13:00', room: null },
  ]);
  assert.equal(read.courses[0].sections[0].endDate, '2026-12-07', 'las fechas sobreviven para el ICS');

  // Resincronizar no duplica.
  saveSchedule(1, schedule);
  assert.equal(readSchedule(1, '1930').courses[0].sections.length, 2, 're-sync no duplica');

  // Lo que un upsert solo se comería: al dar de baja una materia, tiene que
  // desaparecer del horario, no quedarse ahí para siempre.
  saveSchedule(1, { term: '1930', courses: [] });
  assert.equal(readSchedule(1, '1930').courses.length, 0, 'una baja desaparece del horario');

  // Y la materia sigue en el catálogo con su título: perder la inscripción no
  // puede perder el nombre que aprendimos.
  const { readCatalog } = await import('../src/peoplesoft/catalog.js');
  const still = readCatalog('1930').courses.find((x) => x.code === 'ICC-233');
  assert.equal(still.title, 'Seg. en Tecnología Información', 'el título sobrevive a la baja');

  console.log('✓ capa de escritura del horario (baja, re-sync, títulos)');

  // ── Selección de término (change term) ─────────────────────────────────────
  // El selector aparece cuando hay más de un ciclo activo. pickTermRadio elige
  // el pedido; es la pieza que evita sincronizar el ciclo equivocado.
  const radios = [
    { value: '1920', id: 'r0', label: 'Abril de 2026 | Grado | PUCMM' },
    { value: '1930', id: 'r1', label: 'Septiembre de 2026 | Grado | PUCMM' },
  ];
  assert.equal(pickTermRadio(radios, '1930').id, 'r1', 'matchea el ciclo pedido por STRM');
  assert.equal(pickTermRadio(radios, 'Abril de 2026').id, 'r0', 'y por etiqueta como respaldo');
  assert.equal(pickTermRadio(radios, null).id, 'r0', 'sin ciclo pedido, el primero (default del portal)');
  assert.equal(pickTermRadio([], null), null, 'lista vacía sin pedido: no hay nada que elegir');
  assert.throws(
    () => pickTermRadio(radios, '1940'),
    /no está disponible/,
    'un ciclo que no está en la lista es error, no un silencioso ciclo ajeno'
  );
  console.log('✓ selección de término (pickTermRadio: STRM, etiqueta, default, ausente)');

  console.log('\nMi Horario OK contra HTML real.');
} finally {
  await browser.close();
  await rm(dir, { recursive: true, force: true });
}
