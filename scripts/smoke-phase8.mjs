// Smoke visual de la Fase 8: siembra el árbol de requisitos, el histórico de
// notas y un ciclo futuro contra una DB desechable, levanta el server real y
// captura /trayectoria en los tres anchos del gate (390 / 768 / 1440). La línea
// de tiempo es propensa a desbordar en 390px (por eso el ancho chico importa).
//
// Además del screenshot, verifica el punto crítico del plan §11: el encabezado
// NO mezcla ciclos — el término "en curso" (presente) y el "Próximo ciclo" son
// distintos, y la posición sale del pénsum, no de un término futuro.
//
// Uso: node scripts/smoke-phase8.mjs
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-smoke8-'));
process.env.MIKAMPUS_DB = path.join(dir, 'smoke.db');

// 1. Sembrar el árbol de requisitos (con la cohorte real).
const { extractAdvisementTree, parseAdvisementTree, saveRequirementTree } = await import(
  '../src/peoplesoft/advisement.js'
);
const { extractCourseHistory, parseCourseHistory, saveGrades } = await import('../src/peoplesoft/grades.js');
const { upsertTerm, reconcileTerms, readTerms } = await import('../src/terms.js');

{
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.setContent(await readFile('fixtures/recon-advisement.html', 'utf8'));
  const raw = await p.evaluate(extractAdvisementTree);
  const tree = parseAdvisementTree(raw, { knownSubjects: ['ICC', 'FIS', 'MAT', 'ILE', 'ITT', 'GFA', 'FIL'] });
  const saved = saveRequirementTree(tree, { cohortStartTerm: 'Septiembre de 2023' });

  // 2. El histórico de notas: da los términos del pasado y el presente (en curso).
  await p.setContent(await readFile('fixtures/recon-course-history.html', 'utf8'));
  const rawGrades = await p.evaluate(extractCourseHistory);
  await b.close();
  const courses = parseCourseHistory(rawGrades.rows, {
    knownSubjects: ['ICC', 'ESG', 'ART', 'DEP', 'ET', 'ILE', 'GFA', 'IIS'],
  });
  saveGrades(courses);
  console.log('sembrado:', saved, '·', courses.length, 'notas');
}

// 3. Un ciclo futuro con fechas reales (Septiembre de 2026 = STRM 1930), para
//    que exista un "próximo ciclo" distinto del presente. reconcileTerms cruza
//    las etiquetas de grades para que el ciclo actual resuelva.
upsertTerm({ code: '1930', startDate: '2026-09-01', endDate: '2026-12-07' });
reconcileTerms();

const ctx = readTerms();
console.log('ciclo actual:', ctx.current?.label, '· próximo:', ctx.next?.label);

// 4. Levantar el server contra esa DB.
const PORT = 4189;
const server = spawn('node', ['src/server.js'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 2500));

// 5. Capturar en cada ancho y verificar que no se mezclen ciclos.
await mkdir('screenshots', { recursive: true });
const widths = [390, 768, 1440];
const browser = await chromium.launch();
try {
  for (const w of widths) {
    const page = await browser.newPage({ viewport: { width: w, height: 900 } });
    await page.goto(`http://localhost:${PORT}/trayectoria`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1600);

    // El encabezado de posición está, y sale del pénsum (12 períodos), no de un término.
    await page.getByText('Estás en').first().waitFor({ timeout: 5000 });
    const posicion = await page.getByText(/de 12/).first().textContent();

    // La página no desborda a lo ancho (el riesgo del §12.3 en 390px).
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `la trayectoria no desborda a ${w}px (overflow=${overflow})`);

    const file = `screenshots/phase8-trayectoria-${w}.png`;
    await page.screenshot({ path: file, fullPage: true });
    console.log('  →', file, '·', posicion?.trim());
    await page.close();
  }

  // 6. El encabezado no mezcla ciclos: presente y próximo son términos distintos.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://localhost:${PORT}/trayectoria`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  if (ctx.next?.label) {
    const proximo = page.locator('li', { hasText: 'Próximo ciclo' });
    await proximo.first().waitFor({ timeout: 5000 });
    assert.ok(
      await proximo.getByText(ctx.next.label).count(),
      `el nodo "Próximo ciclo" muestra ${ctx.next.label}, el ciclo que viene`
    );
    if (ctx.current?.label) {
      assert.notEqual(ctx.current.label, ctx.next.label, 'el presente y el próximo no son el mismo ciclo');
    }
  }
  await page.close();
  console.log('✓ el encabezado no mezcla ciclos: presente y próximo separados');
} finally {
  await browser.close();
  server.kill();
}
console.log('listo');
