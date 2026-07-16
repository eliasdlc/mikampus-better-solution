// Verifica la capa de escritura del catálogo contra una DB desechable.
// Lo que protege: el class search NO devuelve títulos, así que un barrido
// entrega title=null. Si esa escritura pisara el título real que ya teníamos,
// la app entera pasaría a mostrar códigos en vez de nombres (principio #3).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-test-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');

const { saveSection, coursesMissingTitle, readCatalog } = await import('../src/peoplesoft/catalog.js');
const { scrapedSectionSchema } = await import('../src/shared/schemas.ts');

const section = (over = {}) =>
  scrapedSectionSchema.parse({
    courseCode: 'ICC-321',
    subject: 'ICC',
    catalogNbr: '321',
    term: '1930',
    classNbr: '5227',
    section: '101',
    component: 'LEC',
    meetings: [{ days: ['Mo'], start: '10:00', end: '13:00', room: null }],
    ...over,
  });

const titleOf = (code) =>
  readCatalog('1930').courses.find((c) => c.code === code)?.title ?? null;

try {
  // Un barrido sobre una materia desconocida deja el código como título…
  saveSection(section({ title: null }));
  assert.equal(titleOf('ICC-321'), 'ICC-321', 'sin título conocido, el código hace de placeholder');
  assert.deepEqual(coursesMissingTitle(), ['ICC-321'], 'queda marcada para backfill');

  // …y cuando otra fuente (mySchedule, notas, seed) aporta el nombre real, gana.
  saveSection(section({ title: 'Estructuras de Datos' }));
  assert.equal(titleOf('ICC-321'), 'Estructuras de Datos');
  assert.deepEqual(coursesMissingTitle(), [], 'ya no necesita backfill');

  // El caso que importa: un barrido posterior NO puede pisar el título real.
  saveSection(section({ title: null, classNbr: '5228', section: '171', component: 'PRA' }));
  assert.equal(titleOf('ICC-321'), 'Estructuras de Datos', 'un barrido no pisa el título real');

  // Y sigue agregando secciones a la misma materia, sin duplicarla.
  const course = readCatalog('1930').courses.find((c) => c.code === 'ICC-321');
  assert.equal(course.sections.length, 2, 'dos secciones bajo una sola materia');
  assert.deepEqual(course.sections.map((s) => s.classNbr).sort(), ['5227', '5228']);

  // Reprocesar la misma sección la actualiza, no la duplica (UNIQUE term+class_nbr).
  saveSection(section({ title: null, instructor: 'Beato, Lisibonny' }));
  const again = readCatalog('1930').courses.find((c) => c.code === 'ICC-321');
  assert.equal(again.sections.length, 2, 'el upsert no duplica secciones');
  assert.equal(again.sections.find((s) => s.classNbr === '5227').instructor, 'Beato, Lisibonny');

  console.log('✓ Capa de escritura del catálogo OK (títulos preservados, upsert idempotente).');
} finally {
  await rm(dir, { recursive: true, force: true });
}
