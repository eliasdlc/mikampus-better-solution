// Gate visual/funcional de Fase 9: árbol real + catálogo local desechable,
// Dashboard proactivo y propuesta del Planner en 390/768/1440. Al final crea
// el plan en esa DB temporal y comprueba que todas las materias llevan sección.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-smoke9-'));
process.env.MIKAMPUS_DB = path.join(dir, 'smoke.db');
const { extractAdvisementTree, parseAdvisementTree, saveRequirementTree, readRequirementTree } = await import(
  '../src/peoplesoft/advisement.js'
);
const { saveSection } = await import('../src/peoplesoft/catalog.js');
const { upsertTerm, reconcileTerms } = await import('../src/terms.js');

const browser = await chromium.launch();
const fixturePage = await browser.newPage();
await fixturePage.setContent(await readFile('fixtures/recon-advisement.html', 'utf8'));
const raw = await fixturePage.evaluate(extractAdvisementTree);
await fixturePage.close();
saveRequirementTree(1, parseAdvisementTree(raw, {
  knownSubjects: ['ICC', 'FIS', 'MAT', 'ILE', 'ITT', 'GFA', 'FIL'],
}));

const pending = [];
const visit = (group) => {
  for (const item of group.items) if (item.status === 'pending') pending.push(item);
  group.children.forEach(visit);
};
visit(readRequirementTree());
const offerings = [...new Map(pending.map((item) => [item.code, item])).values()].slice(0, 24);
const days = [['Mo'], ['Tu'], ['We'], ['Th'], ['Fr'], ['Sa']];
offerings.forEach((item, index) => {
  const hour = 7 + (index % 12);
  saveSection({
    courseCode: item.code,
    subject: item.subject,
    catalogNbr: item.catalogNbr,
    title: item.title ?? `Materia ${item.code}`,
    career: 'GRDO',
    credits: item.units ?? 3,
    term: '1930',
    classNbr: String(9000 + index),
    section: `${String(index + 1).padStart(2, '0')}-LEC`,
    component: 'LEC',
    instructor: null,
    meetings: [{ days: days[index % days.length], start: `${String(hour).padStart(2, '0')}:00`, end: `${String(hour + 1).padStart(2, '0')}:00`, room: null }],
    seats: null,
  });
});
upsertTerm({ code: '1930', label: 'Septiembre de 2026', startDate: '2026-09-01', endDate: '2026-12-07' });
reconcileTerms();

const PORT = 4192;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = 'screenshots/phase9';
const server = spawn('node', ['src/server.js'], {
  env: { ...process.env, PORT: String(PORT), MIKAMPUS_BACKUP_AT: '23:59' },
  stdio: 'ignore',
});
await new Promise((resolve) => setTimeout(resolve, 2_000));
await mkdir(OUT, { recursive: true });

try {
  for (const width of [390, 768, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.route('**/api/events', (route) => route.abort());

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.getByText('Generar un plan desde tu trayectoria').waitFor();
    assert.ok(
      (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1,
      `Dashboard no desborda a ${width}px`
    );
    await page.screenshot({ path: `${OUT}/dashboard-${width}.png`, fullPage: true });

    await page.goto(`${BASE}/planner?recomendado=1`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Plan recomendado' }).waitFor();
    await page.getByRole('button', { name: 'Crear este plan' }).waitFor();
    assert.ok(
      (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1,
      `Planner no desborda a ${width}px`
    );
    await page.screenshot({ path: `${OUT}/planner-${width}.png`, fullPage: true });

    if (width === 1440) {
      await page.getByRole('button', { name: 'Crear este plan' }).click();
      await page.getByRole('button', { name: /Plan recomendado/ }).waitFor();
      const detail = await page.evaluate(async () => {
        const plans = await fetch('/api/plans').then((response) => response.json());
        return fetch(`/api/plans/${plans.plans[0].id}`).then((response) => response.json());
      });
      assert.ok(detail.items.length > 0, 'el plan recomendado persiste materias');
      assert.ok(detail.items.every((item) => item.status === 'planned' && item.section), 'toda materia persiste con sección');
    }
    await page.close();
  }
  console.log('✓ Fase 9 responsive 390/768/1440 + Dashboard proactivo + plan recomendado editable');
} finally {
  await browser.close();
  server.kill();
  await rm(dir, { recursive: true, force: true });
}
