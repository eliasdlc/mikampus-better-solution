// El gate de la Fase 8: la trayectoria de carrera se calcula del árbol real
// (fixtures/recon-advisement.html) y sus cifras de encabezado cuadran EXACTO con
// los totales del advisement. Si no cuadran, el encabezado miente sobre dónde
// está parado el estudiante. Reusa el viaje completo a la DB (como
// test-advisement-db) para operar sobre el árbol anidado que la app realmente
// sirve, no sobre los grupos planos del parser.
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
  cycleOrdinal,
  cyclesBetween,
  careerSummary,
  futureBlocks,
  curriculumPeriodsPerYear,
} from '../src/shared/trajectory.ts';

// ── Aritmética de ciclos, pura (sin DB) ─────────────────────────────────────
assert.equal(cycleOrdinal('2023-09'), 2023 * 3 + 2, 'Septiembre es el tercer ciclo del año (índice 2)');
assert.equal(cycleOrdinal('2026-01') - cycleOrdinal('2025-09'), 1, 'de Septiembre a Enero es un ciclo');
assert.equal(cycleOrdinal('2026-04') - cycleOrdinal('2026-01'), 1, 'de Enero a Abril es un ciclo');
assert.equal(cycleOrdinal('2026-07'), null, 'un mes que no nombra un ciclo no ordena');

// De la cohorte real (Sep 2023) al ciclo actual real (Abr 2026): 9 ciclos,
// contando ambos extremos. Sep23, Ene24, Abr24, Sep24, Ene25, Abr25, Sep25,
// Ene26, Abr26.
assert.equal(cyclesBetween('Septiembre de 2023', 'Abril de 2026'), 9, 'nueve ciclos cursando, inclusive');
assert.equal(cyclesBetween('Abril de 2026', 'Abril de 2026'), 1, 'el mismo ciclo cuenta como uno');
assert.equal(cyclesBetween(null, 'Abril de 2026'), null, 'sin cohorte no hay cuenta');
assert.equal(cyclesBetween('mañana', 'Abril de 2026'), null, 'una etiqueta no ubicable no rompe: devuelve null');

// ── El árbol real, vía DB ───────────────────────────────────────────────────
const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-traj-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');

const { extractAdvisementTree, parseAdvisementTree, saveRequirementTree, readRequirementTree } = await import(
  '../src/peoplesoft/advisement.js'
);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(await readFile('fixtures/recon-advisement.html', 'utf8'));
const raw = await page.evaluate(extractAdvisementTree);
await browser.close();

const tree = parseAdvisementTree(raw, { knownSubjects: ['ICC', 'FIS', 'MAT', 'ILE', 'ITT', 'GFA', 'FIL'] });
saveRequirementTree(1, tree, { cohortStartTerm: 'Septiembre de 2023' });
const root = readRequirementTree();

assert.equal(curriculumPeriodsPerYear(root), 3, 'el fixture ICC-2020 declara tres períodos por año');

const summary = careerSummary(root, { cohortStartTerm: 'Septiembre de 2023', currentTermLabel: 'Abril de 2026' });

// ── El encabezado cuadra con los totales del advisement (el corazón del gate) ─
assert.equal(summary.credits.required, 212, 'los 212 créditos que exige la carrera');
assert.equal(summary.credits.taken, 131, 'los 131 créditos ya cursados');
assert.equal(summary.credits.needed, 81, 'los 81 créditos faltantes');
assert.equal(summary.coursesNeeded, 24, 'las 24 materias faltantes');
assert.equal(summary.position.total, 12, 'doce períodos en el pénsum');

// ── La posición: el bloque sin cerrar más viejo, dentro del rango real ───────
assert.ok(!summary.position.done, 'la carrera no está completa: quedan bloques');
assert.ok(
  summary.position.index >= 1 && summary.position.index <= 12,
  'la posición apunta a un período que existe'
);
assert.ok(
  Number.isInteger(summary.position.year) && Number.isInteger(summary.position.period),
  'el bloque donde estás parado tiene año y período'
);

// ── El atraso: su base de cálculo es real y consistente ──────────────────────
const d = summary.delay;
assert.equal(d.elapsedCycles, 9, 'nueve ciclos cursando desde la cohorte');
assert.equal(d.totalPeriods, 12);
assert.equal(d.curriculumPeriodsPerYear, 3, 'la cadencia sale del documento, no del calendario hardcodeado');
assert.ok(d.satisfiedPeriods >= 1 && d.satisfiedPeriods < 12, 'algunos bloques cerrados, no todos');
assert.ok(d.oldest, 'hay un bloque sin cerrar más viejo');
assert.equal(d.oldest.index, summary.position.index, 'el bloque del atraso es donde estás parado');
assert.ok(d.behindCycles !== null && d.behindCycles >= 0, 'el atraso es un número no negativo');
// El atraso es consistente con la aritmética: ciclos cursados menos el nominal.
assert.equal(d.behindCycles, Math.max(0, d.elapsedCycles - d.oldest.index), 'el atraso sale de su base visible');

// ── Los bloques futuros: los períodos sin cerrar, en orden, con lo que falta ─
const future = futureBlocks(root);
assert.equal(future.length, summary.cyclesLeft, 'un bloque futuro por cada período sin cerrar');
assert.ok(future.length > 0, 'quedan bloques por cursar');
// En orden de secuencia de carrera.
for (let i = 1; i < future.length; i++) {
  assert.ok(future[i].index > future[i - 1].index, 'los bloques futuros salen en orden de carrera');
}
// El primer bloque futuro es el más viejo sin cerrar: el mismo del atraso.
assert.equal(future[0].index, d.oldest.index, 'el primer futuro es el bloque más viejo pendiente');
// Toda pendiente listada es obligatoria (status pending), nunca una candidata.
assert.ok(
  future.every((b) => b.pending.every((it) => it.status === 'pending' && !it.isCandidate)),
  'los pendientes de un bloque son obligatorias, no candidatas de electiva'
);

// ── Carrera completa: la posición apunta al final, sin atraso ni futuro ──────
{
  const doneRoot = structuredClone(root);
  for (const g of doneRoot.children) if (g.kind === 'periodo') g.satisfied = true;
  const s = careerSummary(doneRoot, { cohortStartTerm: 'Septiembre de 2023', currentTermLabel: 'Abril de 2026' });
  assert.ok(s.position.done, 'sin bloques pendientes, la carrera está completa');
  assert.equal(s.cyclesLeft, 0, 'no quedan ciclos');
  assert.equal(s.delay.oldest, null, 'no hay bloque de atraso');
  assert.equal(s.delay.behindCycles, null, 'sin bloque pendiente, no hay atraso que medir');
  assert.equal(futureBlocks(doneRoot).length, 0, 'no hay bloques futuros');
}

await rm(dir, { recursive: true, force: true });
console.log(
  `✓ trayectoria: posición Año ${summary.position.year} Período ${summary.position.period} de ${summary.position.total}, ` +
    `${summary.credits.taken}/${summary.credits.required} créditos, ${summary.coursesNeeded} materias faltantes`
);
console.log(
  `✓ atraso: ${d.elapsedCycles} ciclos cursando · ${d.satisfiedPeriods}/${d.totalPeriods} bloques cerrados · ` +
    `bloque más viejo pendiente Año ${d.oldest.year} Período ${d.oldest.period} (${d.oldest.pendingCount} materia(s), ${d.behindCycles} ciclos de atraso)`
);
console.log(`✓ ${future.length} bloques futuros en orden de carrera`);
