import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import {
  extractCourseHistory,
  parseCourseHistory,
  extractGradeStats,
  parseGradeStats,
  checkAgainstPortal,
  termSummaries,
} from '../src/peoplesoft/grades.js';
import { summarizeGrades, countsTowardGpa, formatGpa, sortTermLabels } from '../src/shared/gpa.ts';

// Corre el parser de notas contra HTML real volcado del portal, sin tocarlo.
const browser = await chromium.launch();
const page = await browser.newPage();

// ── Course History: el histórico completo ───────────────────────────────────
await page.setContent(await readFile('fixtures/recon-course-history.html', 'utf8'));

const raw = await page.evaluate(extractCourseHistory);
assert.equal(raw.rows.length, 52, '52 materias en el histórico');

// La trampa de los wrappers $span$: `[id^="CRSE_NAME$"]` también atraparía
// CRSE_NAME$span$N y duplicaría cada fila. Si alguien afloja el regex de id,
// esto salta a 104.
assert.ok(
  raw.rows.every((r) => r.rawName),
  'toda fila trae su código; ninguna es un wrapper $span$ colado'
);

const courses = parseCourseHistory(raw.rows, { knownSubjects: ['ICC', 'ESG', 'ART', 'DEP', 'ET', 'ILE', 'GFA', 'IIS', 'FIS', 'MAT'] });
assert.equal(courses.length, 52, 'las 52 filas parsean');

const estados = {};
for (const c of courses) estados[c.status] = (estados[c.status] ?? 0) + 1;
assert.equal(estados.in_progress, 5, '5 materias en curso (sin nota todavía)');
assert.equal(estados.transferred, 1, '1 materia convalidada');
assert.equal(estados.taken, 46, '46 materias cursadas');

// El estado sale del alt del icono, y una materia en curso no tiene nota.
const enCurso = courses.filter((c) => c.status === 'in_progress');
assert.ok(
  enCurso.every((c) => c.grade === null),
  'ninguna materia en curso trae nota'
);

// ── La escala, contrastada con los totales del propio portal ────────────────
// Esto es lo que sostiene el simulador what-if: si la escala o las reglas de
// qué cuenta estuvieran mal, estos números no darían.
const summary = summarizeGrades(courses);
assert.equal(summary.unitsTowardGpa, 143, 'los créditos para índice dan los 143 del portal');
assert.equal(summary.gradePoints, 402, 'los puntos dan los 402 del portal');
assert.equal(summary.unitsPassed, 131, 'los créditos aprobados dan los 131 del portal');
assert.ok(Math.abs(summary.gpa - 2.811) < 0.001, '402/143 = 2.811');
assert.equal(formatGpa(summary.gpa), '2.800', 'redondeado como lo publica el portal');

// S, R y EXO no entran al índice. Los 8 créditos en R son exactamente la
// diferencia entre los 151 créditos cursados y los 143 que cuentan: si alguien
// los mete, el índice se desploma y estos totales dejan de cuadrar.
assert.ok(!countsTowardGpa('R'), 'una retirada no cuenta');
assert.ok(!countsTowardGpa('S'), 'un satisfactorio no cuenta');
assert.ok(!countsTowardGpa('EXO'), 'una convalidada no cuenta');
assert.ok(countsTowardGpa('F'), 'una reprobada SÍ cuenta (con 0 puntos)');

const cursadas = courses.filter((c) => c.status === 'taken');
const todosLosCreditos = cursadas.reduce((s, c) => s + (c.units ?? 0), 0);
assert.equal(todosLosCreditos, 151, 'cursó 151 créditos');
assert.equal(todosLosCreditos - summary.unitsTowardGpa, 8, 'los 8 créditos que no cuentan son los retirados');

// Una F no es lo mismo que una materia sin nota: cuenta créditos y 0 puntos.
const reprobadas = cursadas.filter((c) => c.grade === 'F');
assert.equal(reprobadas.length, 3, '3 reprobadas');
assert.equal(
  summary.unitsTowardGpa - summary.unitsPassed,
  reprobadas.reduce((s, c) => s + c.units, 0),
  'la diferencia entre cursados y aprobados son exactamente las reprobadas'
);

// ── Agrupación por término ──────────────────────────────────────────────────
const terms = termSummaries(courses);
assert.equal(terms.length, 10, '10 términos');
assert.equal(terms[0].term, 'Septiembre de 2026', 'el más reciente primero, no el alfabético');
assert.equal(terms.at(-1).term, 'Septiembre de 2023', 'y el más viejo último');

// Ordenar por texto pondría "Abril de 2026" antes que "Enero de 2026" y
// "Septiembre de 2023" después de todo: el sparkline saldría al azar.
const ordenados = sortTermLabels(['Septiembre de 2026', 'Enero de 2024', 'Abril de 2025']);
assert.deepEqual(ordenados, ['Enero de 2024', 'Abril de 2025', 'Septiembre de 2026'], 'orden cronológico, no alfabético');

// El término de Enero de 2026, que el portal publica con sus propios números.
const enero2026 = terms.find((t) => t.term === 'Enero de 2026');
assert.equal(enero2026.unitsTowardGpa, 20, 'los 20 créditos que dice el portal');
assert.equal(enero2026.gradePoints, 56, 'los 56 puntos que dice el portal');
assert.ok(Math.abs(enero2026.gpa - 2.8) < 0.001, 'índice del término 2.800');

// Un término donde todo está en curso no tiene índice — no tiene índice 0.
const enCursoTerm = terms.find((t) => t.term === 'Septiembre de 2026');
assert.equal(enCursoTerm.gpa, null, 'un término sin notas no tiene índice');
assert.equal(enCursoTerm.unitsInProgress, 4, 'pero sí créditos en curso');
assert.equal(formatGpa(null), '—', 'y se muestra como "sin dato", no como 0.000');

// ── Los totales del portal: leídos por etiqueta, no por índice ──────────────
await page.setContent(await readFile('fixtures/recon-grades-past.html', 'utf8'));
const statsPast = parseGradeStats(await page.evaluate(extractGradeStats));
assert.equal(statsPast.termLabel, 'Enero de 2026');
assert.equal(statsPast.cumulative.unitsTowardGpa, 143);
assert.equal(statsPast.cumulative.gradePoints, 402);
assert.equal(statsPast.cumulative.unitsPassed, 131);
assert.equal(statsPast.cumulative.gpa, 2.8);
assert.equal(statsPast.term.unitsTowardGpa, 20, 'la columna del término es otra que la acumulada');
assert.equal(statsPast.term.gpa, 2.8);

// La misma tabla en el término en curso: acá SÍ existe la fila "In Progress",
// así que todas las de abajo se corren un lugar. Leer por índice fijo daría
// el número de la fila vecina — este es el caso que lo demuestra.
await page.setContent(await readFile('fixtures/recon-grades-landing.html', 'utf8'));
const statsNow = parseGradeStats(await page.evaluate(extractGradeStats));
assert.equal(statsNow.termLabel, 'Septiembre de 2026');
assert.equal(statsNow.cumulative.unitsInProgress, 19, 'la fila que corre a las demás');
assert.equal(statsNow.cumulative.gpa, 2.8, 'y aun así el índice se lee bien');
assert.equal(statsNow.cumulative.gradePoints, 402);

// El acumulado que publica el portal es el de HOY, el mismo en la página de
// cualquier término: el índice histórico no se puede scrapear término a
// término, se calcula. Por eso existe termSummaries.
assert.equal(
  statsPast.cumulative.gpa,
  statsNow.cumulative.gpa,
  'el acumulado del portal no cambia según el término que mires'
);

// ── Redondea, no trunca (y esto es evidencia, no supuesto) ──────────────────
// El acumulado no alcanza para distinguirlo: 402/143 = 2.8112 cae en 2.8 tanto
// redondeando como truncando. Enero de 2025 sí lo distingue.
await page.setContent(await readFile('fixtures/recon-grades-enero2025.html', 'utf8'));
const enero2025Portal = parseGradeStats(await page.evaluate(extractGradeStats));
assert.equal(enero2025Portal.termLabel, 'Enero de 2025');
assert.equal(enero2025Portal.term.gradePoints, 40);
assert.equal(enero2025Portal.term.unitsTowardGpa, 15);
assert.equal(enero2025Portal.term.gpa, 2.7, 'el portal publica 2.700 para 40/15 = 2.6667');
assert.equal(formatGpa(40 / 15), '2.700', 'redondea: truncar daría 2.600 y contradiría al portal');

// Y nuestro cálculo del término da lo mismo que el portal, hasta el redondeo.
const enero2025 = terms.find((t) => t.term === 'Enero de 2025');
assert.equal(enero2025.gradePoints, 40, 'los 40 puntos que dice el portal');
assert.equal(enero2025.unitsTowardGpa, 15, 'los 15 créditos que dice el portal');
assert.equal(enero2025.unitsPassed, 11, 'y los 11 aprobados');
assert.equal(formatGpa(enero2025.gpa), '2.700', 'y el mismo índice publicado');

// ── El contraste que protege al what-if ─────────────────────────────────────
assert.deepEqual(checkAgainstPortal(summary, statsPast.cumulative), [], 'lo calculado cuadra con lo que publica el portal');

// Si la universidad cambiara una regla, el contraste tiene que gritar.
const conEscalaRota = { ...summary, gradePoints: 500, gpa: 3.5 };
const gritos = checkAgainstPortal(conEscalaRota, statsPast.cumulative);
assert.ok(gritos.length >= 2, 'un índice que no cuadra se reporta, no se muestra');
assert.ok(gritos.some((m) => m.includes('gradePoints')), 'y dice qué no cuadra');

await browser.close();
console.log(`✓ notas: ${courses.length} materias, ${terms.length} términos (${JSON.stringify(estados)})`);
console.log(
  `✓ el índice calculado reproduce al portal: ${summary.gradePoints}/${summary.unitsTowardGpa} = ${formatGpa(summary.gpa)}`
);
