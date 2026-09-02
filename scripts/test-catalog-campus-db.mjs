// El campus en la capa de escritura y de lectura del catálogo, contra una DB
// desechable. Lo que protege:
//   1. lo que dijo el portal nunca lo pisa una inferencia, ni una escritura que
//      no sabe de campus (el scraper de Mi Horario);
//   2. el catálogo llega al frontend ya ordenado y agrupado, con el campo crudo
//      y su procedencia al lado, para que ninguna pantalla lea una inferencia
//      como si fuera dato del portal.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-test-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');

const { saveSection, readCatalog, readHomeCampus, setHomeCampus } = await import('../src/peoplesoft/catalog.js');
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
    ...over,
  });

const sectionsOf = (code = 'ICC-321') => readCatalog('1930').courses.find((c) => c.code === code)?.sections ?? [];
const find = (classNbr) => sectionsOf().find((s) => s.classNbr === classNbr);

try {
  // ── 1. Sin campus elegido, nada se reordena y el campo viaja igual ────────
  assert.equal(readHomeCampus(1), null, 'el campus del perfil se elige, no se adivina');

  // Una búsqueda filtrada por campus: el portal mismo dijo de dónde es.
  saveSection(section({ campus: 'CSTI', campusSource: 'portal' }));
  assert.deepEqual(
    { campus: find('5227').campus, source: find('5227').campusSource },
    { campus: 'CSTI', source: 'portal' }
  );

  // ── 2. Precedencia de escritura ──────────────────────────────────────────
  // Una inferencia por número de sección no pisa lo que dijo el portal.
  saveSection(section({ campus: 'CSTA', campusSource: 'seccion' }));
  assert.equal(find('5227').campus, 'CSTI', 'la inferencia no pisa el dato del portal');

  // Una escritura sin campus (Mi Horario, o una búsqueda sin filtrar) no borra
  // lo que ya se sabía.
  saveSection(section({ instructor: 'Beato, Lisibonny' }));
  assert.deepEqual(
    { campus: find('5227').campus, source: find('5227').campusSource, instructor: find('5227').instructor },
    { campus: 'CSTI', source: 'portal', instructor: 'Beato, Lisibonny' },
    'una escritura sin campus actualiza el resto de la fila sin tocar el campus'
  );

  // Y el portal sí pisa al portal: un barrido nuevo puede corregir el anterior.
  saveSection(section({ campus: 'CSTA', campusSource: 'portal' }));
  assert.equal(find('5227').campus, 'CSTA', 'un dato del portal corrige a otro dato del portal');
  saveSection(section({ campus: 'CSTI', campusSource: 'portal' }));

  // Una inferencia sí escribe cuando no había nada.
  saveSection(section({ classNbr: '5228', section: '171', component: 'PRA', campus: 'CSTI', campusSource: 'seccion' }));
  assert.deepEqual(
    { campus: find('5228').campus, source: find('5228').campusSource },
    { campus: 'CSTI', source: 'seccion' },
    'sin dato previo, la inferencia entra marcada como inferencia'
  );

  // ── 3. Orden y agrupación, resueltos por el backend ──────────────────────
  saveSection(section({ classNbr: '6001', section: '201', campus: 'CSTA', campusSource: 'portal' }));
  saveSection(section({ classNbr: '9001', section: '901', campus: 'CVIR', campusSource: 'portal' }));
  saveSection(section({ classNbr: '7001', section: '030' })); // sin campus atribuible

  const sinPerfil = readCatalog('1930');
  assert.equal(sinPerfil.homeCampus, null, 'la respuesta dice con qué campus se ordenó');
  assert.deepEqual(
    sinPerfil.courses[0].sections.map((s) => s.section),
    ['101', '171', '201', '030', '901'],
    'sin campus elegido: presenciales por número de sección, después lo desconocido, después Virtual'
  );

  setHomeCampus(1, 'CSTA');
  assert.equal(readHomeCampus(1), 'CSTA');
  const conPerfil = readCatalog('1930');
  assert.equal(conPerfil.homeCampus, 'CSTA');
  assert.deepEqual(
    conPerfil.courses[0].sections.map((s) => s.section),
    ['201', '101', '171', '030', '901'],
    'con Santo Domingo elegido, sus secciones van primero'
  );
  assert.deepEqual(
    conPerfil.courses[0].campusGroups.map((g) => [g.campus, g.isHome, g.sections.length]),
    [
      ['CSTA', true, 1],
      ['CSTI', false, 2],
      [null, false, 1],
      ['CVIR', false, 1],
    ],
    'los grupos llegan armados, con el propio marcado'
  );
  // La lista plana y los grupos describen exactamente las mismas secciones.
  assert.deepEqual(
    conPerfil.courses[0].campusGroups.flatMap((g) => g.sections.map((s) => s.id)),
    conPerfil.courses[0].sections.map((s) => s.id)
  );

  // ── 4. Un campus inventado no entra a la base ────────────────────────────
  assert.throws(() => setHomeCampus(1, 'CPUJ'), /invalid|expected|CSTI/i, 'el vocabulario se valida al escribir');
  setHomeCampus(1, null);
  assert.equal(readHomeCampus(1), null, 'volver a no tener campus elegido es válido');

  console.log('✓ campus en el catálogo: el portal manda al escribir, y la lectura llega ordenada y agrupada');
} finally {
  await rm(dir, { recursive: true, force: true });
}
