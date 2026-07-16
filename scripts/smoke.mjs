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
const ROUTES = ['/', '/buscar', '/planner', '/builder', '/horario', '/inscripcion'];
const WIDTHS = [390, 768, 1440];

// Un plan de mentira con items en los tres estados (grupo elegido con y sin
// choque, deseada con nota) para que el screenshot del planner muestre la
// pantalla de verdad y no un estado vacío.
const PLAN_DETAIL = {
  id: 1,
  term: '1930',
  name: 'Ago–Dic 2026',
  updatedAt: '2026-07-16 12:00:00',
  items: [
    {
      id: 1,
      courseId: 9001,
      code: 'ICC-303',
      subject: 'ICC',
      title: 'Estructuras de Datos',
      credits: 4,
      career: 'GRDO',
      catalogNbr: '303',
      status: 'planned',
      note: null,
      locked: true,
      section: {
        id: 91,
        term: '1930',
        classNbr: '4567',
        section: '101',
        component: 'LEC',
        instructor: 'M. Pérez',
        meetings: [{ days: ['Mo', 'We'], start: '10:00', end: '13:00', room: 'A-201' }],
        seats: { status: 'open', open: 5, capacity: 40, waitTotal: 0 },
        seatsUpdatedAt: '2026-07-16 10:00:00',
      },
    },
    {
      id: 2,
      courseId: 9002,
      code: 'MAT-241',
      subject: 'MAT',
      title: 'Cálculo Vectorial',
      credits: 4,
      career: 'GRDO',
      catalogNbr: '241',
      status: 'planned',
      note: null,
      locked: false,
      section: {
        id: 92,
        term: '1930',
        classNbr: '6100',
        section: '102',
        component: 'LEC',
        instructor: 'J. Núñez',
        meetings: [{ days: ['We'], start: '12:00', end: '14:00', room: null }],
        seats: { status: 'waitlist', open: 0, capacity: 35, waitTotal: 3 },
        seatsUpdatedAt: '2026-07-16 10:00:00',
      },
    },
    {
      id: 3,
      courseId: 9003,
      code: 'FIS-211',
      subject: 'FIS',
      title: 'Física Eléctrica',
      credits: 4,
      career: 'GRDO',
      catalogNbr: '211',
      status: 'desired',
      note: 'con Rivero si abre',
      locked: false,
      section: null,
    },
  ],
};

const FIXTURES = {
  '/api/state': { schedule: { atISO: new Date(Date.now() + 3 * 864e5).toISOString() }, watcher: { intervalMs: 45000 } },
  '/api/plans': { plans: [{ id: 1, term: '1930', name: 'Ago–Dic 2026', itemCount: 3, credits: 12, updatedAt: '2026-07-16 12:00:00' }] },
  '/api/plans/1': PLAN_DETAIL,
  '/api/terms': { terms: [{ term: '1930', startDate: '2026-08-24', endDate: '2026-12-05' }] },
  '/api/cart': {
    rows: [
      {
        index: 0,
        classLabel: 'ICC ICC303-101 (4567)',
        courseCode: 'ICC-303',
        title: 'Estructuras de Datos',
        section: '101',
        classNbr: '4567',
        instructor: 'M. Pérez',
        credits: 4,
        campus: 'Campus Santiago',
        meetings: [{ days: ['Mo', 'We'], start: '10:00', end: '13:00', room: 'A-201' }],
        status: 'open',
      },
      {
        index: 1,
        classLabel: 'MAT MAT241-102 (6100)',
        courseCode: 'MAT-241',
        title: 'Cálculo Vectorial',
        section: '102',
        classNbr: '6100',
        instructor: 'J. Núñez',
        credits: 4,
        campus: 'Campus Santiago',
        meetings: [{ days: ['Tu', 'Th'], start: '08:00', end: '10:00', room: null }],
        status: 'waitlist',
      },
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
