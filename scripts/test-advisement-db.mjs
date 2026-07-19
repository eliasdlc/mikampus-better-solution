// El viaje completo del árbol de requisitos contra una DB desechable:
// parser v2 → saveRequirementTree → pénsum derivado → readRequirementTree.
//
// Lo que protege: la tabla `pensum` se DERIVA del árbol, y la regla de
// derivación (una candidata de electiva no cursada no es pendiente) solo se ve
// en la base, no en el parser. Un test del parser solo jamás la vería.
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-test-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');

const {
  extractAdvisementTree,
  parseAdvisementTree,
  saveRequirementTree,
  readRequirementTree,
  readProfile,
  readPensum,
  pendingCourses,
} = await import('../src/peoplesoft/advisement.js');
const { db } = await import('../src/db.js');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(await readFile('fixtures/recon-advisement.html', 'utf8'));
const raw = await page.evaluate(extractAdvisementTree);
await browser.close();

const tree = parseAdvisementTree(raw, {
  knownSubjects: ['ICC', 'FIS', 'MAT', 'ILE', 'ITT', 'GFA', 'FIL'],
});

const saved = saveRequirementTree(1, tree, { cohortStartTerm: 'Septiembre de 2023' });
assert.equal(saved.groups, tree.groups.length, 'se guardan todos los grupos');
assert.equal(saved.courses, tree.courses.length, 'se guardan todos los cursos del árbol');

// ── El árbol se relee anidado, con la raíz arriba y los períodos como hijos. ──
const root = readRequirementTree();
assert.ok(root, 'el árbol se relee de la base');
assert.equal(root.kind, 'root', 'la raíz es del kind root');
assert.equal(root.units.needed, 81, 'los 81 créditos faltantes sobreviven el viaje a la base');
const periodos = root.children.filter((g) => g.kind === 'periodo');
assert.equal(periodos.length, 12, 'los 12 períodos cuelgan de la raíz');
const anio1p1 = periodos.find((p) => p.year === 1 && p.period === 1);
assert.ok(anio1p1.satisfied, 'Año 1 Período 1 está satisfecho');

// ── Una electiva satisfecha se relee sin candidatas. ──
const conElectivaSat = periodos
  .flatMap((p) => p.children)
  .find((g) => g.kind === 'electiva' && g.satisfied);
assert.ok(conElectivaSat, 'hay al menos una electiva satisfecha en el árbol releído');
assert.equal(conElectivaSat.items.length, 0, 'la electiva satisfecha no trae candidatas');

// ── La regla de derivación: la candidata pura no contamina el pénsum. ──
const pensum = readPensum();
const pensumCodes = new Set(pensum.map((r) => r.code));

// Toda materia del pénsum, o es obligatoria en algún grupo, o ya se cursó.
const rows = db
  .prepare('SELECT code, is_candidate, status FROM requirement_courses')
  .all();
const obligatoriaCodes = new Set(rows.filter((r) => r.is_candidate === 0).map((r) => r.code));
const cursadaCodes = new Set(
  rows.filter((r) => r.status === 'taken' || r.status === 'in_progress').map((r) => r.code)
);
for (const code of pensumCodes) {
  assert.ok(
    obligatoriaCodes.has(code) || cursadaCodes.has(code),
    `${code} en el pénsum es obligatoria o cursada, no candidata pura`
  );
}

// Hay candidatas puras (candidata en su único grupo, nunca cursada) y NINGUNA
// llegó al pénsum: esa es la inflación que el parser v1 producía.
const allCodes = new Set(rows.map((r) => r.code));
const candidatasPuras = [...allCodes].filter(
  (c) => !obligatoriaCodes.has(c) && !cursadaCodes.has(c)
);
assert.ok(candidatasPuras.length > 0, 'el informe trae candidatas puras de electiva');
assert.ok(
  candidatasPuras.every((c) => !pensumCodes.has(c)),
  'ninguna candidata pura entró al pénsum derivado'
);

// ── Las pendientes del pénsum son must-takes reales (obligatorias). ──
const pend = pendingCourses();
assert.ok(pend.length > 0, 'hay pendientes reales');
assert.ok(
  pend.every((c) => obligatoriaCodes.has(c)),
  'toda pendiente del pénsum es obligatoria de algún grupo, no una candidata'
);

// ── El perfil se guarda; la cohorte que aporta grades se conserva. ──
const profile = readProfile(1);
assert.equal(profile.pensum_no, '2020', 'el número de pénsum se guarda');
assert.match(profile.career, /COMPUTACIÓN/, 'la carrera se guarda');
assert.equal(profile.cohort_start_term, 'Septiembre de 2023', 'la cohorte se guarda');

// Un re-sync SIN cohorte no la borra (viene de grades, no del informe).
saveRequirementTree(1, tree, {});
assert.equal(
  readProfile(1).cohort_start_term,
  'Septiembre de 2023',
  'un re-sync sin cohorte conserva la anterior'
);

await rm(dir, { recursive: true, force: true });
console.log(
  `✓ árbol en DB: ${saved.groups} grupos, ${saved.courses} cursos → pénsum derivado de ${pensum.length} materias (${pend.length} pendientes reales)`
);
console.log(
  `✓ derivación: ${candidatasPuras.length} candidatas puras excluidas del pénsum, ${obligatoriaCodes.size} códigos obligatorios`
);
