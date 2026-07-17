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
const ROUTES = ['/', '/buscar', '/planner', '/builder', '/horario', '/inscripcion', '/academico', '/holds'];
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

// Notas: un término calificado y uno en curso, que son los dos casos que la
// pantalla dibuja distinto (índice vs "—" y el simulador).
const TERM_ENERO = {
  term: 'Enero de 2026',
  sortKey: '2026-01',
  unitsTowardGpa: 8,
  gradePoints: 24,
  unitsPassed: 8,
  unitsInProgress: 0,
  gpa: 3,
  courses: [
    { code: 'ICC-302', subject: 'ICC', catalogNbr: '302', title: 'Programación Funcional', term: 'Enero de 2026', grade: 'A', units: 4, status: 'taken' },
    { code: 'ICC-352', subject: 'ICC', catalogNbr: '352', title: 'Programación Web', term: 'Enero de 2026', grade: 'B', units: 4, status: 'taken' },
  ],
};

const TERM_EN_CURSO = {
  term: 'Abril de 2026',
  sortKey: '2026-04',
  unitsTowardGpa: 0,
  gradePoints: 0,
  unitsPassed: 0,
  unitsInProgress: 4,
  gpa: null,
  courses: [
    { code: 'ICC-303', subject: 'ICC', catalogNbr: '303', title: 'Estructuras de Datos', term: 'Abril de 2026', grade: null, units: 4, status: 'in_progress' },
  ],
};

// Los dos ciclos del contexto de tiempo (termInfoSchema completo). Abril corre
// hoy; Septiembre (1930) es el siguiente y el que se planifica.
const TERM_ACTUAL = {
  term: '1920',
  code: '1920',
  label: 'Abril de 2026',
  startDate: '2026-04-20',
  endDate: '2026-08-01',
  sortKey: '2026-04',
  isCurrent: true,
  isNext: false,
  hasSchedule: false,
  hasSections: false,
};
const TERM_PROXIMO = {
  term: '1930',
  code: '1930',
  label: 'Septiembre de 2026',
  startDate: '2026-08-24',
  endDate: '2026-12-05',
  sortKey: '2026-09',
  isCurrent: false,
  isNext: true,
  hasSchedule: false,
  hasSections: true,
};

const FIXTURES = {
  '/api/grades': {
    generatedAt: new Date().toISOString(),
    syncedAt: '2026-07-16 12:00:00',
    terms: [TERM_EN_CURSO, TERM_ENERO],
    summary: { unitsTowardGpa: 8, gradePoints: 24, unitsPassed: 8, unitsInProgress: 4, gpa: 3 },
  },
  '/api/pensum': {
    term: '1930',
    generatedAt: new Date().toISOString(),
    syncedAt: '2026-07-16 12:00:00',
    courses: [
      { code: 'ICC-302', subject: 'ICC', catalogNbr: '302', title: 'Programación Funcional', units: 4, status: 'taken', takenTerm: 'Enero de 2026', grade: 'A', offered: false },
      { code: 'ICC-303', subject: 'ICC', catalogNbr: '303', title: 'Estructuras de Datos', units: 4, status: 'in_progress', takenTerm: null, grade: null, offered: false },
      { code: 'ICC-321', subject: 'ICC', catalogNbr: '321', title: 'Bases de Datos', units: 4, status: 'pending', takenTerm: null, grade: null, offered: true },
      { code: 'MAT-241', subject: 'MAT', catalogNbr: '241', title: 'Cálculo Vectorial', units: 4, status: 'pending', takenTerm: null, grade: null, offered: false },
    ],
  },
  // El caso real hoy: sin holds, ya consultado. La pantalla afirma el vacío en
  // vez de invitar a consultar.
  '/api/holds': { generatedAt: new Date().toISOString(), syncedAt: '2026-07-16 12:00:00', holds: [] },
  '/api/state': {
    schedule: { atISO: new Date(Date.now() + 3 * 864e5).toISOString() },
    watcher: { intervalMs: 45000, lastCheckAt: new Date(Date.now() - 40e3).toISOString() },
  },
  '/api/plans': { plans: [{ id: 1, term: '1930', name: 'Ago–Dic 2026', itemCount: 3, credits: 12, updatedAt: '2026-07-16 12:00:00' }] },
  '/api/plans/1': PLAN_DETAIL,
  '/api/terms': {
    // El modelo de tiempo de la Fase 6: hoy (jul 2026) corre Abril y viene
    // Septiembre (1930). El Dashboard parte el hero del ciclo actual del card
    // "Próximo ciclo", y /horario ofrece el switcher entre los dos.
    terms: [TERM_ACTUAL, TERM_PROXIMO],
    current: TERM_ACTUAL,
    next: TERM_PROXIMO,
  },
  '/api/cart': {
    generatedAt: new Date().toISOString(),
    syncedAt: '2026-07-16 12:00:00',
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
    proc.stdout.on('data', (d) => String(d).includes('mikampus en') && resolve(proc));
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
    // El ⌘K tiene que ser operable sin mouse (gate del plan §6.5), así que se
    // verifica sin mouse: abrir, escribir, entrar a una materia con Enter y
    // salir con Esc. El catálogo sale de la DB real (ICC del término 1930).
    await page.goto(BASE + '/horario', { waitUntil: 'networkidle' });
    await page.keyboard.press('Control+k');
    await page.waitForSelector('[cmdk-input]', { timeout: 3000 });
    await page.keyboard.type('icc3');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/palette-${width}.png`, fullPage: true });

    const materias = await page.locator('[cmdk-item][data-value^="course-"]').count();
    if (materias === 0) {
      failures.push(`palette-${width}: ⌘K no encontró materias para "icc3"`);
      console.log(`  ✗ palette-${width}.png — sin resultados`);
    } else {
      // Enter sobre el item seleccionado entra a las secciones de la materia.
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      const secciones = await page.locator('[cmdk-item][data-value^="section-"]').count();
      await page.screenshot({ path: `${OUT}/palette-secciones-${width}.png`, fullPage: true });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      const cerrado = (await page.locator('[cmdk-input]').count()) === 0;

      if (!secciones) failures.push(`palette-${width}: Enter no abrió las secciones de la materia`);
      if (!cerrado) failures.push(`palette-${width}: Esc no cerró el overlay`);
      console.log(secciones && cerrado ? `  ✓ palette-${width}.png (${materias} materias, ${secciones} secciones, Esc cierra)` : `  ✗ palette-${width}`);
    }

    // La PWA se verifica donde importa: en el ancho del teléfono. Que el
    // manifest y los iconos estén servidos y el service worker tome control —
    // sin eso el navegador no ofrece instalarla y "es una PWA" es una promesa.
    if (width === 390) {
      const manifest = await page.request.get(`${BASE}/manifest.webmanifest`);
      const icono = await page.request.get(`${BASE}/icon-512.png`);
      const listo = await page
        .waitForFunction(() => navigator.serviceWorker?.controller != null || navigator.serviceWorker?.ready, { timeout: 5000 })
        .then(() => true)
        .catch(() => false);

      if (!manifest.ok()) failures.push(`pwa: /manifest.webmanifest devolvió ${manifest.status()}`);
      if (!icono.ok()) failures.push(`pwa: /icon-512.png devolvió ${icono.status()}`);
      if (!listo) failures.push('pwa: el service worker no quedó activo');
      console.log(manifest.ok() && icono.ok() && listo ? '  ✓ pwa (manifest, iconos, service worker)' : '  ✗ pwa');
    }

    // La vista de impresión (plan §5.5) es una pantalla más y se verifica igual:
    // emulando el medio print. Sin esto, "sale bien en papel" es una suposición.
    if (width === 1440) {
      await page.emulateMedia({ media: 'print' });
      await page.goto(BASE + '/horario', { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${OUT}/horario-impresion.png`, fullPage: true });

      const navVisible = await page.locator('aside nav').isVisible();
      if (navVisible) failures.push('horario-impresion: la navegación se imprime');
      console.log(navVisible ? '  ✗ horario-impresion.png — imprime el nav' : '  ✓ horario-impresion.png');
      await page.emulateMedia({ media: 'screen' });
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
