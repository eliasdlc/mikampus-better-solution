// Gate visual del plan (sección 6): carga cada ruta y captura a 390px (iPhone),
// 768px (tablet) y 1440px (desktop) para revisión de los tres anchos antes de
// cerrar la fase. Levanta el server real (sirve el build + catálogo sembrado) y
// mockea solo los endpoints que dispararían un login en vivo contra el portal.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = 4188;
const BASE = `http://localhost:${PORT}`;
const OUT = 'screenshots/smoke';
const ROUTES = ['/', '/buscar', '/horario', '/inscripcion'];
const WIDTHS = [390, 768, 1440];

const FIXTURES = {
  '/api/state': { schedule: { atISO: new Date(Date.now() + 3 * 864e5).toISOString() }, watcher: { intervalMs: 45000 } },
  '/api/cart': {
    rows: [
      { index: 0, classLabel: 'ICC-303 - Estructuras de Datos (4567)', status: 'Open' },
      { index: 1, classLabel: 'MAT-241 - Cálculo Vectorial (6100)', status: 'Wait List' },
    ],
  },
};

function startServer() {
  const proc = spawn('node', ['src/server.js'], { env: { ...process.env, PORT: String(PORT) } });
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => String(d).includes('backend en') && resolve(proc));
    proc.stderr.on('data', (d) => process.stderr.write(d));
    proc.on('exit', (c) => reject(new Error(`server salió con código ${c}`)));
    setTimeout(() => reject(new Error('timeout esperando el server')), 15000);
  });
}

const server = await startServer();
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const failures = [];

try {
  for (const width of WIDTHS) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    // Endpoints en vivo (login Playwright) → fixtures; SSE → abortado.
    for (const [url, body] of Object.entries(FIXTURES)) {
      await page.route(`**${url}`, (r) => r.fulfill({ json: body }));
    }
    await page.route('**/api/events', (r) => r.abort());

    for (const route of ROUTES) {
      await page.goto(BASE + route, { waitUntil: 'networkidle' });
      if (route === '/buscar') await page.fill('input[placeholder*="Estructuras"]', 'calc');
      await page.waitForTimeout(400);
      const name = `${route === '/' ? 'inicio' : route.slice(1)}-${width}`;
      await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });

      // La página nunca debe scrollear a lo ancho: si el body desborda, es un
      // layout roto en ese ancho. Se revisaba a ojo y así se coló un nav que
      // no entraba en 390px — mejor que falle el gate.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) {
        failures.push(`${name}: la página desborda ${overflow}px a lo ancho`);
        console.log(`  ✗ ${name}.png — desborda ${overflow}px`);
      } else {
        console.log(`  ✓ ${name}.png`);
      }
    }
    await context.close();
  }

  if (failures.length) {
    console.error(`\n${failures.length} problema(s) de layout:\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log(`\nScreenshots en ${OUT}/ (${ROUTES.length} rutas × ${WIDTHS.length} anchos), sin desbordes.`);
  }
} finally {
  await browser.close();
  server.kill();
}
