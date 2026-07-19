// Smoke visual de la Fase 7: siembra el árbol de requisitos desde el fixture,
// levanta el server contra una DB desechable y captura /academico (Avance) y
// /buscar en los tres anchos del gate (390 / 768 / 1440). No toca la DB real.
//
// Uso: node scripts/smoke-phase7.mjs
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-smoke-'));
process.env.MIKAMPUS_DB = path.join(dir, 'smoke.db');

// 1. Sembrar el árbol.
const { extractAdvisementTree, parseAdvisementTree, saveRequirementTree } = await import(
  '../src/peoplesoft/advisement.js'
);
{
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.setContent(await readFile('fixtures/recon-advisement.html', 'utf8'));
  const raw = await p.evaluate(extractAdvisementTree);
  await b.close();
  const tree = parseAdvisementTree(raw, { knownSubjects: ['ICC', 'FIS', 'MAT', 'ILE', 'ITT', 'GFA', 'FIL'] });
  const saved = saveRequirementTree(1, tree, { cohortStartTerm: 'Septiembre de 2023' });
  console.log('sembrado:', saved);
}

// 2. Levantar el server contra esa DB.
const PORT = 4188;
const server = spawn('node', ['src/server.js'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 2500));

// 3. Capturar cada ruta en cada ancho.
await mkdir('screenshots', { recursive: true });
const widths = [390, 768, 1440];
const rutas = [
  { path: '/academico', name: 'academico', after: async (page) => {
      await page.getByRole('button', { name: 'Avance' }).click().catch(() => {});
      await page.waitForTimeout(600);
    } },
  { path: '/buscar', name: 'buscar', after: async () => {} },
];

const browser = await chromium.launch();
try {
  for (const ruta of rutas) {
    for (const w of widths) {
      const page = await browser.newPage({ viewport: { width: w, height: 900 } });
      // 'domcontentloaded', no 'networkidle': el feed SSE deja una conexión
      // abierta y networkidle nunca dispararía.
      await page.goto(`http://localhost:${PORT}${ruta.path}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      await ruta.after(page);
      const file = `screenshots/phase7-${ruta.name}-${w}.png`;
      await page.screenshot({ path: file, fullPage: true });
      console.log('  →', file);
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.kill();
}
console.log('listo');
