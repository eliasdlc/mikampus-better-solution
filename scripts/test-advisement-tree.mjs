import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { extractAdvisementTree, parseAdvisementTree } from '../src/peoplesoft/advisement.js';

// El gate de la Fase 7: el parser v2 reconstruye el árbol de requisitos del
// informe real (fixtures/recon-advisement.html) sin recon nuevo. Si PeopleSoft
// cambia la estructura del informe, esto falla antes que un sync en vivo.
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(await readFile('fixtures/recon-advisement.html', 'utf8'));

const raw = await page.evaluate(extractAdvisementTree);
const { profile, groups, courses } = parseAdvisementTree(raw, {
  knownSubjects: ['ICC', 'FIS', 'MAT', 'ILE', 'ITT', 'GFA', 'FIL'],
});
await browser.close();

// ── Los grupos con header explícito (root + período + obligatorios + electiva
//    pendiente): el informe pinta 3 Satisfied y 24 Not Satisfied. ──
const headerGroups = groups.filter((g) => !g.collapsed);
assert.equal(headerGroups.length, 27, '27 grupos con header Satisfied/Not Satisfied');
assert.equal(headerGroups.filter((g) => g.satisfied).length, 3, 'exactamente 3 grupos satisfechos');
assert.equal(headerGroups.filter((g) => !g.satisfied).length, 24, 'exactamente 24 no satisfechos');

// ── La raíz trae los totales del pénsum: 81 créditos faltantes. ──
const root = groups.find((g) => g.kind === 'root');
assert.ok(root, 'hay una raíz');
assert.equal(root.unitsNeeded, 81, '81 créditos faltantes en total');
assert.equal(root.unitsRequired, 212, '212 créditos que exige la carrera');
assert.equal(root.unitsTaken, 131, '131 créditos ya cursados');
assert.equal(root.coursesRequired, 64, '64 materias requeridas');
assert.equal(root.coursesNeeded, 24, '24 materias faltantes');

// ── La forma del árbol: raíz → períodos → obligatorios/electivas. ──
const periodos = groups.filter((g) => g.kind === 'periodo');
assert.equal(periodos.length, 12, '12 períodos (4 años × 3)');
assert.ok(periodos.every((p) => p.parentId === root.id), 'todo período cuelga de la raíz');
assert.ok(
  periodos.every((p) => Number.isInteger(p.year) && Number.isInteger(p.period)),
  'cada período tiene año y período numéricos para ordenar'
);
const obligatorios = groups.filter((g) => g.kind === 'obligatorios');
assert.equal(obligatorios.length, 9, '9 bloques de Cursos Obligatorios (uno por período no satisfecho)');
const byId = new Map(groups.map((g) => [g.id, g]));
assert.ok(
  obligatorios.every((o) => byId.get(o.parentId)?.kind === 'periodo'),
  'los obligatorios cuelgan de un período'
);

// ── El corazón del punto 3: una electiva SATISFECHA oculta sus candidatas. ──
const lit = groups.find((g) => /Electiva de Literatura/i.test(g.label));
assert.ok(lit, 'el slot "Electiva de Literatura" existe');
assert.ok(lit.satisfied, 'la Electiva de Literatura está satisfecha');
assert.ok(lit.collapsed, 'y viene colapsada en el informe');
assert.equal(
  courses.filter((c) => c.groupId === lit.id).length,
  0,
  'una electiva satisfecha no arrastra candidatas al pénsum'
);

// ── Una electiva PENDIENTE sí trae sus candidatas, marcadas como tales. ──
const ia = groups.find((g) => /Electiva de Inteligencia Artificial/i.test(g.label));
assert.ok(ia && !ia.satisfied && !ia.collapsed, 'la Electiva de IA está pendiente y expandida');
const iaCandidatas = courses.filter((c) => c.groupId === ia.id);
assert.ok(iaCandidatas.length > 0, 'la electiva pendiente lista candidatas');
assert.ok(iaCandidatas.every((c) => c.isCandidate), 'sus cursos son candidatas, no obligatorias');

// ── Ninguna materia queda fuera de un grupo, ni cuelga de la raíz. ──
assert.ok(
  courses.every((c) => byId.has(c.groupId)),
  'toda materia pertenece a un grupo que existe'
);
assert.ok(
  courses.every((c) => byId.get(c.groupId).kind !== 'root'),
  'ninguna materia cuelga directo de la raíz (siempre de un obligatorios/electiva)'
);

// ── El perfil sale de la raíz. ──
assert.equal(profile.pensumNo, '2020', 'el número de pénsum sale del informe');
assert.match(profile.career, /COMPUTACIÓN/, 'la carrera sale del informe');

const collapsedElectivas = groups.filter((g) => g.collapsed).length;
const obligCourses = courses.filter((c) => !c.isCandidate).length;
console.log(
  `✓ árbol de requisitos: ${headerGroups.length} grupos (${headerGroups.filter((g) => g.satisfied).length} ✓ / ${headerGroups.filter((g) => !g.satisfied).length} ✗), ` +
    `${periodos.length} períodos, ${collapsedElectivas} electivas satisfechas ocultas`
);
console.log(
  `✓ ${courses.length} materias en grupos (${obligCourses} obligatorias/cursadas, ${courses.length - obligCourses} candidatas), ` +
    `raíz: ${root.unitsNeeded} créditos faltantes de ${root.unitsRequired}`
);
console.log(`✓ perfil: pénsum ${profile.pensumNo} — ${profile.career}`);
