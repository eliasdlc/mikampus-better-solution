import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { browserLaunchOptions } from '../src/browser.js';
import { recommendCourses } from '../src/shared/recommend.ts';

const counts = { required: null, taken: null, needed: null };
const group = (id, kind, label, position, extra = {}) => ({
  id, kind, label, year: null, period: null, satisfied: false, collapsed: false,
  position, units: counts, courses: counts, gpaActual: null, items: [], children: [], ...extra,
});
const item = (code, { candidate = false, units = 3 } = {}) => ({
  code, subject: code.split('-')[0], catalogNbr: code.split('-')[1] ?? code,
  title: code, units, status: 'pending', takenTerm: null, grade: null,
  courseId: null, offered: true, isCandidate: candidate,
});
let nextSectionId = 1;
const course = (id, code, start, end, credits = 3) => ({
  id, code, subject: code.split('-')[0], catalogNbr: code.split('-')[1] ?? code,
  title: `Materia ${code}`, career: 'GRDO', credits,
  sections: [{
    id: nextSectionId++, term: '2000', classNbr: String(8000 + id), section: '01-LEC',
    component: 'LEC', instructor: null,
    meetings: [{ days: ['Mo'], start, end, room: null }], seats: null, seatsUpdatedAt: null,
  }],
});

function curriculum(periods) {
  const root = group(0, 'root', 'Pénsum', 0);
  root.children = periods;
  return root;
}

function period(id, year, number, children, satisfied = false) {
  return group(id, 'periodo', `Año ${year} Período ${number}`, id, {
    year, period: number, satisfied, children,
  });
}

// Perfil al día: el período cerrado no compite; empieza por el siguiente.
{
  const done = group(2, 'obligatorios', 'Obligatorios', 2, { satisfied: true, items: [item('ICC-100')] });
  const pending = group(4, 'obligatorios', 'Obligatorios', 4, { items: [item('ICC-200')] });
  const result = recommendCourses({
    requirements: curriculum([period(1, 1, 1, [done], true), period(3, 1, 2, [pending])]),
    catalog: [course(1, 'ICC-100', '08:00', '09:00'), course(2, 'ICC-200', '09:00', '10:00')],
    maxCredits: 18,
  });
  assert.deepEqual(result.recommendations.map((r) => r.code), ['ICC-200']);
  assert.match(result.recommendations[0].reason, /Año 1 Período 2/);
  assert.ok(result.schedule.valid);
}

// Perfil atrasado: con carga limitada, las materias del bloque más viejo ganan.
{
  const old = group(2, 'obligatorios', 'Obligatorios', 2, { items: [item('ICC-101'), item('ICC-102')] });
  const next = group(4, 'obligatorios', 'Obligatorios', 4, { items: [item('ICC-201')] });
  const result = recommendCourses({
    requirements: curriculum([period(1, 1, 1, [old]), period(3, 1, 2, [next])]),
    catalog: [
      course(11, 'ICC-101', '08:00', '09:00'),
      course(12, 'ICC-102', '09:00', '10:00'),
      course(13, 'ICC-201', '10:00', '11:00'),
    ],
    maxCredits: 6,
  });
  assert.deepEqual(result.recommendations.map((r) => r.code), ['ICC-101', 'ICC-102']);
  assert.equal(result.totalCredits, 6);
}

// Solo electivas + doble conteo: ICC-E01 aparece en dos slots, pero la salida
// la asigna una sola vez y busca otra candidata para el segundo.
{
  const slotA = group(2, 'electiva', 'Electiva de Filosofía', 2, {
    items: [item('FIL-E01', { candidate: true }), item('FIL-E02', { candidate: true })],
  });
  const slotB = group(3, 'electiva', 'Electiva libre', 3, {
    items: [item('FIL-E01', { candidate: true }), item('FIL-E03', { candidate: true })],
  });
  const result = recommendCourses({
    requirements: curriculum([period(1, 2, 1, [slotA, slotB])]),
    catalog: [
      course(21, 'FIL-E01', '08:00', '09:00'),
      course(22, 'FIL-E02', '09:00', '10:00'),
      course(23, 'FIL-E03', '10:00', '11:00'),
    ],
    maxCredits: 6,
  });
  assert.equal(result.recommendations.length, 2, 'los dos slots reciben una candidata');
  assert.equal(new Set(result.recommendations.map((r) => r.code)).size, 2, 'ninguna candidata llena dos slots');
  assert.ok(result.recommendations.every((r) => r.kind === 'electiva'));
}

// El conjunto ideal choca: se conserva lo más viejo y se ofrece un subconjunto
// armable. Toda salida pasa por el solver y trae una sección concreta.
{
  const req = group(2, 'obligatorios', 'Obligatorios', 2, {
    items: [item('ICC-301'), item('ICC-302'), item('ICC-303')],
  });
  const result = recommendCourses({
    requirements: curriculum([period(1, 3, 1, [req])]),
    catalog: [
      course(31, 'ICC-301', '08:00', '09:30'),
      course(32, 'ICC-302', '09:00', '10:00'), // choca con 301
      course(33, 'ICC-303', '10:00', '11:00'),
    ],
    maxCredits: 9,
  });
  assert.deepEqual(result.recommendations.map((r) => r.code), ['ICC-301', 'ICC-303']);
  assert.ok(result.schedule.valid);
  assert.ok(result.schedule.adjusted);
  assert.equal(result.schedule.omitted[0].code, 'ICC-302');
  assert.ok(result.recommendations.every((r) => Number.isInteger(r.section.id)));
}

// ── Con el plan académico oficial cargado ───────────────────────────────────
// Todo lo de arriba corre SIN plan, y sigue pasando: sin reglas conocidas el
// motor no bloquea nada. Lo que sigue prueba lo que el plan aporta.

const planRule = (code, extra = {}) => ({
  code, portalId: '000000', title: `Materia ${code}`, theory: 3, practice: 0, units: 4,
  year: 1, period: 1, electiveOf: null, prereqs: [], coreqs: [], ...extra,
});
const testPlan = (courses, extra = {}) => ({
  plan: 'ICC-2020', career: 'ICC', issuedAt: '2024-12-03', totalUnits: 200,
  periods: [], gates: [], notes: [], aliases: {}, courses, ...extra,
});

// El laboratorio entra CON su teoría, aunque valga 0 créditos.
//
// Éste era el bug: los labs de física valen 0 unidades de verdad, y el filtro
// de créditos descartaba en silencio todo lo que no valiera más de cero. El
// resultado era un plan recomendado con Física y sin su laboratorio — que
// PeopleSoft rechaza, porque el pénsum los exige juntos.
{
  const plan = testPlan({
    'FIS-139': planRule('FIS-139', { coreqs: ['FIS-1FIS139'] }),
    'FIS-1FIS139': planRule('FIS-1FIS139', { coreqs: ['FIS-139'], units: 0 }),
  });
  const req = group(2, 'obligatorios', 'Obligatorios', 2, {
    items: [item('FIS-139', { units: 4 }), item('FIS-1FIS139', { units: 0 })],
  });
  const result = recommendCourses({
    requirements: curriculum([period(1, 1, 3, [req])]),
    plan,
    catalog: [
      course(41, 'FIS-139', '08:00', '10:00', 4),
      { ...course(42, 'FIS-1FIS139', '14:00', '16:00', 0), credits: null },
    ],
    maxCredits: 18,
  });
  const codes = result.recommendations.map((r) => r.code).sort();
  assert.deepEqual(codes, ['FIS-139', 'FIS-1FIS139'], 'la teoría nunca va sin su laboratorio');
  assert.equal(result.totalCredits, 4, 'el laboratorio suma 0 créditos, no se descarta por eso');
  const lab = result.recommendations.find((r) => r.code === 'FIS-1FIS139');
  assert.equal(lab.requiredBy, 'FIS-139');
  assert.match(lab.reason, /junto a FIS-139/);
  assert.ok(result.schedule.valid);
}

// La teoría sin laboratorio ofertado no se propone a medias: se explica.
{
  const plan = testPlan({
    'FIS-139': planRule('FIS-139', { coreqs: ['FIS-1FIS139'] }),
    'FIS-1FIS139': planRule('FIS-1FIS139', { coreqs: ['FIS-139'], units: 0, title: 'Lab. FIS-139' }),
  });
  const req = group(2, 'obligatorios', 'Obligatorios', 2, { items: [item('FIS-139', { units: 4 })] });
  const result = recommendCourses({
    requirements: curriculum([period(1, 1, 3, [req])]),
    plan,
    catalog: [course(43, 'FIS-139', '08:00', '10:00', 4)], // el lab no se oferta
    maxCredits: 18,
  });
  assert.deepEqual(result.recommendations, []);
  assert.equal(result.blocked.length, 1);
  assert.match(result.blocked[0].reason, /junto con FIS-1FIS139 \(Lab\. FIS-139\)/);
}

// Un prerrequisito sin aprobar bloquea, y el bloqueo dice QUÉ falta — que suele
// ser lo más útil de toda la pantalla.
{
  const plan = testPlan({
    'FIS-139': planRule('FIS-139', { title: 'Mecánica Newtoniana' }),
    'FIS-219': planRule('FIS-219', { prereqs: ['FIS-139'] }),
  });
  const req = group(2, 'obligatorios', 'Obligatorios', 2, { items: [item('FIS-219', { units: 4 })] });
  const result = recommendCourses({
    requirements: curriculum([period(1, 2, 1, [req])]),
    plan,
    history: [{ courseCode: 'FIS-139', status: 'failed', credits: 4 }],
    catalog: [course(44, 'FIS-219', '08:00', '10:00', 4)],
    maxCredits: 18,
  });
  assert.deepEqual(result.recommendations, []);
  assert.deepEqual(result.blocked[0].missing, ['FIS-139']);
  assert.match(result.blocked[0].reason, /Te falta aprobar FIS-139 \(Mecánica Newtoniana\)/);
}

// Lo que se cursa AHORA habilita el ciclo que viene, pero deja la propuesta
// condicionada — y el motor lo dice en voz alta en vez de esconderlo.
{
  const plan = testPlan({
    'ICC-211': planRule('ICC-211'),
    'ICC-212': planRule('ICC-212', { prereqs: ['ICC-211'] }),
  });
  const req = group(2, 'obligatorios', 'Obligatorios', 2, { items: [item('ICC-212', { units: 4 })] });
  const result = recommendCourses({
    requirements: curriculum([period(1, 2, 2, [req])]),
    plan,
    history: [{ courseCode: 'ICC-211', status: 'in_progress', credits: 4 }],
    catalog: [course(45, 'ICC-212', '08:00', '10:00', 4)],
    maxCredits: 18,
  });
  assert.deepEqual(result.recommendations.map((r) => r.code), ['ICC-212']);
  assert.deepEqual(result.recommendations[0].conditionalOn, ['ICC-211']);
  assert.ok(result.caveats.some((c) => /da por aprobado lo que cursás ahora/.test(c)));
}

// Las dos estrategias sobre los MISMOS datos dan órdenes distintos: ponerse al
// día drena lo más viejo; avanzar ataca primero el cuello de botella.
{
  const plan = testPlan({
    'LET-101': planRule('LET-101'), // vieja, no destraba nada
    'ICC-104': planRule('ICC-104'), // nueva, destraba tres
    'ICC-211': planRule('ICC-211', { prereqs: ['ICC-104'] }),
    'ICC-223': planRule('ICC-223', { prereqs: ['ICC-104'] }),
    'ICC-341': planRule('ICC-341', { prereqs: ['ICC-104'] }),
  });
  const vieja = group(2, 'obligatorios', 'Obligatorios', 2, { items: [item('LET-101', { units: 4 })] });
  const nueva = group(4, 'obligatorios', 'Obligatorios', 4, { items: [item('ICC-104', { units: 4 })] });
  const shared = {
    requirements: curriculum([period(1, 1, 1, [vieja]), period(3, 2, 1, [nueva])]),
    plan,
    catalog: [course(46, 'LET-101', '08:00', '10:00', 4), course(47, 'ICC-104', '10:00', '12:00', 4)],
    maxCredits: 4, // solo cabe UNA: la estrategia decide cuál
  };
  const alDia = recommendCourses({ ...shared, strategy: 'ponerse-al-dia' });
  const avanzar = recommendCourses({ ...shared, strategy: 'avanzar' });
  assert.deepEqual(alDia.recommendations.map((r) => r.code), ['LET-101']);
  assert.deepEqual(avanzar.recommendations.map((r) => r.code), ['ICC-104']);
  assert.equal(avanzar.recommendations[0].unlocks, 3);
  assert.match(avanzar.recommendations[0].reason, /destraba 3 materia/);
}

// Los controles del estudiante mandan sobre el orden del plan.
{
  const plan = testPlan({ 'LET-101': planRule('LET-101'), 'ICC-104': planRule('ICC-104') });
  const vieja = group(2, 'obligatorios', 'Obligatorios', 2, { items: [item('LET-101', { units: 4 })] });
  const nueva = group(4, 'obligatorios', 'Obligatorios', 4, { items: [item('ICC-104', { units: 4 })] });
  const shared = {
    requirements: curriculum([period(1, 1, 1, [vieja]), period(3, 2, 1, [nueva])]),
    plan,
    catalog: [course(48, 'LET-101', '08:00', '10:00', 4), course(49, 'ICC-104', '10:00', '12:00', 4)],
    maxCredits: 4,
  };
  assert.deepEqual(
    recommendCourses({ ...shared, include: ['ICC-104'] }).recommendations.map((r) => r.code),
    ['ICC-104'],
    'una materia forzada se salta el orden del pénsum'
  );
  assert.deepEqual(
    recommendCourses({ ...shared, exclude: ['LET-101'] }).recommendations.map((r) => r.code),
    ['ICC-104'],
    'una materia descartada no aparece ni siquiera como bloqueada'
  );
  assert.equal(recommendCourses({ ...shared, exclude: ['LET-101'] }).blocked.length, 0);
}

// La compuerta por porcentaje del plan ("FIL-363 exige el 70% de los créditos").
{
  const plan = testPlan(
    { 'FIL-363': planRule('FIL-363', { units: 3 }) },
    { gates: [{ code: 'FIL-363', minApprovedRatio: 0.7, text: '70%' }] }
  );
  const req = group(2, 'obligatorios', 'Obligatorios', 2, { items: [item('FIL-363', { units: 3 })] });
  const shared = {
    requirements: curriculum([period(1, 3, 3, [req])]),
    plan,
    catalog: [course(50, 'FIL-363', '08:00', '10:00', 3)],
    maxCredits: 18,
  };
  const temprano = recommendCourses({
    ...shared,
    history: [{ courseCode: 'ICC-100', status: 'taken', credits: 100 }],
  });
  assert.deepEqual(temprano.recommendations, []);
  assert.match(temprano.blocked[0].reason, /70% de los créditos/);

  const tarde = recommendCourses({
    ...shared,
    history: [{ courseCode: 'ICC-100', status: 'taken', credits: 140 }],
  });
  assert.deepEqual(tarde.recommendations.map((r) => r.code), ['FIL-363']);
}

// Caso real: árbol reconstruido desde el fixture del advisement. Se crea un
// catálogo ofertado para sus pendientes reales y el motor debe producir una
// combinación válida sin sacar nada de un grupo inexistente.
const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-recommend-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
const { extractAdvisementTree, parseAdvisementTree, saveRequirementTree, readRequirementTree } = await import(
  '../src/peoplesoft/advisement.js'
);
const browser = await chromium.launch(await browserLaunchOptions());
const page = await browser.newPage();
await page.setContent(await readFile('fixtures/recon-advisement.html', 'utf8'));
const raw = await page.evaluate(extractAdvisementTree);
await browser.close();
const parsed = parseAdvisementTree(raw, { knownSubjects: ['ICC', 'FIS', 'MAT', 'ILE', 'ITT', 'GFA', 'FIL'] });
saveRequirementTree(1, parsed);
const realTree = readRequirementTree(1);

const pendingReal = [];
const visit = (g) => {
  for (const it of g.items) if (it.status === 'pending') pendingReal.push(it);
  g.children.forEach(visit);
};
visit(realTree);
const realCatalog = [...new Map(pendingReal.map((it) => [it.code, it])).values()].slice(0, 18).map((it, i) =>
  course(100 + i, it.code, `${String(7 + (i % 10)).padStart(2, '0')}:00`, `${String(8 + (i % 10)).padStart(2, '0')}:00`, it.units ?? 3)
);
const realResult = recommendCourses({ requirements: realTree, catalog: realCatalog, maxCredits: 18 });
assert.ok(realResult.recommendations.length > 0, 'el fixture real produce recomendaciones');
assert.ok(realResult.schedule.valid, 'la recomendación real tiene combinación válida');
assert.ok(realResult.totalCredits <= 18, 'respeta la carga máxima');
assert.equal(new Set(realResult.recommendations.map((r) => r.code)).size, realResult.recommendations.length);

await rm(dir, { recursive: true, force: true });
console.log(
  `✓ recomendador: perfiles al día/atrasado/solo electivas, doble conteo y reducción por choques; fixture real: ` +
    `${realResult.recommendations.length} materias · ${realResult.totalCredits} créditos · horario válido`
);
