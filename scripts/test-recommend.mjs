import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
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

// Caso real: árbol reconstruido desde el fixture del advisement. Se crea un
// catálogo ofertado para sus pendientes reales y el motor debe producir una
// combinación válida sin sacar nada de un grupo inexistente.
const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-recommend-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
const { extractAdvisementTree, parseAdvisementTree, saveRequirementTree, readRequirementTree } = await import(
  '../src/peoplesoft/advisement.js'
);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(await readFile('fixtures/recon-advisement.html', 'utf8'));
const raw = await page.evaluate(extractAdvisementTree);
await browser.close();
const parsed = parseAdvisementTree(raw, { knownSubjects: ['ICC', 'FIS', 'MAT', 'ILE', 'ITT', 'GFA', 'FIL'] });
saveRequirementTree(parsed);
const realTree = readRequirementTree();

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
