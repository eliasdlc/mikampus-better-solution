// Smoke visual de la Fase 10 (§12.7): siembra el árbol de requisitos y el
// histórico de notas desde los fixtures, levanta el server contra una DB
// desechable, fija dos metas por API (una alcanzable, una fuera de alcance) y
// captura /academico (tab Notas: Simulador + Metas + Señales) en los tres anchos
// del gate (390 / 768 / 1440), fallando si alguna vista desborda a lo ancho.
//
// Uso: node scripts/smoke-phase10.mjs
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-smoke-'));
process.env.MIKAMPUS_DB = path.join(dir, 'smoke.db');

// 1. Sembrar árbol de requisitos (créditos faltantes → proyección) y notas
//    (índice + señales). Ambos se extraen en un browser, como en los tests.
const { extractAdvisementTree, parseAdvisementTree, saveRequirementTree } = await import(
  '../src/peoplesoft/advisement.js'
);
const { extractCourseHistory, parseCourseHistory, saveGrades } = await import('../src/peoplesoft/grades.js');
const { knownSubjects } = await import('../src/peoplesoft/browseCatalog.js');
{
  const b = await chromium.launch();
  const p = await b.newPage();

  await p.setContent(await readFile('fixtures/recon-advisement.html', 'utf8'));
  const rawTree = await p.evaluate(extractAdvisementTree);
  const tree = parseAdvisementTree(rawTree, { knownSubjects: ['ICC', 'FIS', 'MAT', 'ILE', 'ITT', 'GFA', 'FIL'] });
  console.log('árbol:', saveRequirementTree(tree, { cohortStartTerm: 'Septiembre de 2023' }));

  await p.setContent(await readFile('fixtures/recon-course-history.html', 'utf8'));
  const rawGrades = await p.evaluate(extractCourseHistory);
  const courses = parseCourseHistory(rawGrades.rows, { knownSubjects: knownSubjects() });
  saveGrades(courses);
  console.log('notas:', courses.length);

  await b.close();
}

// 2. Levantar el server contra esa DB.
const PORT = 4186;
const server = spawn('node', ['src/server.js'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 2500));

// 3. Fijar dos metas por API: una alcanzable (3.0) y una fuera de alcance (3.5).
for (const target of [3.0, 3.5]) {
  const res = await fetch(`http://localhost:${PORT}/api/goals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target }),
  });
  assert.ok(res.ok, `fijar meta ${target}`);
}
const goals = await (await fetch(`http://localhost:${PORT}/api/goals`)).json();
console.log(
  'metas:',
  goals.goals.map((g) => `${g.target}→${g.verdict}`).join(', '),
  '| proyección:',
  `${goals.projection.floor}/${goals.projection.maintain}/${goals.projection.best}`
);
assert.deepEqual(
  goals.goals.map((g) => g.verdict).sort(),
  ['reachable', 'unreachable'],
  'una meta alcanzable y una fuera de alcance'
);

// 4. Capturar /academico (Notas) en cada ancho y verificar que no desborda.
await mkdir('screenshots', { recursive: true });
const widths = [390, 768, 1440];
const browser = await chromium.launch();
try {
  for (const w of widths) {
    const page = await browser.newPage({ viewport: { width: w, height: 900 } });
    await page.goto(`http://localhost:${PORT}/academico`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);
    // Que las señales y metas ya hayan cargado antes del screenshot.
    await page.getByText('Señales').first().waitFor({ timeout: 5000 }).catch(() => {});
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const file = `screenshots/phase10-academico-${w}.png`;
    await page.screenshot({ path: file, fullPage: true });
    console.log('  →', file, `(overflow horizontal: ${overflow}px)`);
    assert.ok(overflow <= 1, `/academico desborda ${overflow}px a ${w}px de ancho`);
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}
console.log('✓ smoke Fase 10: metas + señales + proyección, sin overflow en 390/768/1440');
