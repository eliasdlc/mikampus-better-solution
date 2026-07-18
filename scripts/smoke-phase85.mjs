import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const PORT = 4191;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = 'screenshots/phase85';
const widths = [390, 768, 1440];

const current = {
  term: '1920', code: '1920', label: 'Abril de 2026', startDate: '2026-05-01', endDate: '2026-08-31',
  sortKey: '2026-04', isCurrent: true, isNext: false, hasSchedule: true, hasSections: false,
};
const next = {
  term: '1930', code: '1930', label: 'Septiembre de 2026', startDate: '2026-09-01', endDate: '2026-12-07',
  sortKey: '2026-09', isCurrent: false, isNext: true, hasSchedule: false, hasSections: true,
};
const schedule = {
  term: '1920', generatedAt: new Date().toISOString(), syncedAt: '2026-07-18 12:00:00',
  courses: [{
    id: 1, code: 'ICC-303', subject: 'ICC', catalogNbr: '303', title: 'Estructuras de Datos', status: 'enrolled',
    units: 4, grading: 'Calificación Ordinaria', grade: null,
    sections: [{ id: 10, classNbr: '4567', section: '101', component: 'LEC', instructor: 'M. Pérez',
      meetings: [{ days: ['Mo', 'We'], start: '10:00', end: '13:00', room: 'A-201' }],
      startDate: '2026-05-01', endDate: '2026-08-31' }],
  }],
};
const emptySchedule = { term: '1930', generatedAt: new Date().toISOString(), syncedAt: null, courses: [] };
const windows = {
  syncedAt: '2026-07-18 12:00:00',
  windows: [{ termCode: '1930', session: 'Regular Academic Session', startsAt: '2026-07-16', endsAt: '2026-09-03', precision: 'date', userId: 1, syncedAt: '2026-07-18 12:00:00' }],
};
const cart = {
  generatedAt: new Date().toISOString(), syncedAt: '2026-07-18 12:00:00',
  rows: [{ index: 0, classLabel: 'ICC ICC321-101 (5227)', courseCode: 'ICC-321', title: 'Inteligencia de Negocios',
    section: '101', classNbr: '5227', instructor: 'L. Beato', credits: 4, campus: 'Campus Santiago',
    meetings: [{ days: ['Mo'], start: '10:00', end: '13:00', room: null }], status: 'waitlist' }],
};
const validation = {
  validatedAt: new Date().toISOString(),
  validate: { supported: false, reason: 'El portal de PUCMM no ofrece Validate en el carrito ni en el paso de revisión; solo valida al someter la inscripción.' },
  waitlistChoice: { supported: false, reason: 'El wizard no ofrece decidir waitlist por materia.' },
  waitlistPosition: { supported: false, reason: 'El carrito no publica una posición de lista de espera.' },
  results: [],
};

const server = spawn('node', ['src/server.js'], {
  env: { ...process.env, PORT: String(PORT), MIKAMPUS_BACKUP_AT: '23:59' },
  stdio: 'ignore',
});
await new Promise((resolve) => setTimeout(resolve, 2_000));
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
try {
  for (const width of widths) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.route('**/api/events', (route) => route.abort());
    await page.route('**/api/terms', (route) => route.fulfill({ json: { terms: [current, next], current, next } }));
    await page.route('**/api/enrollment-windows*', (route) => route.fulfill({ json: windows }));
    await page.route('**/api/cart', (route) => route.fulfill({ json: cart }));
    await page.route('**/api/cart/validate', (route) => route.fulfill({ json: validation }));
    await page.route('**/api/state', (route) => route.fulfill({ json: { schedule: null, watcher: null } }));
    await page.route('**/api/holds', (route) => route.fulfill({ json: { generatedAt: new Date().toISOString(), syncedAt: null, holds: [] } }));
    await page.route('**/api/plans', (route) => route.fulfill({ json: { plans: [] } }));
    await page.route('**/api/my-schedule?term=1920', (route) => route.fulfill({ json: schedule }));
    await page.route('**/api/my-schedule?term=1930', (route) => route.fulfill({ json: emptySchedule }));

    for (const route of ['/', '/inscripcion', '/horario']) {
      await page.goto(BASE + route, { waitUntil: 'networkidle' });
      await page.waitForTimeout(250);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 1, `${route} desborda ${overflow}px a ${width}px`);
      await page.screenshot({ path: `${OUT}/${route === '/' ? 'inicio' : route.slice(1)}-${width}.png`, fullPage: true });
    }

    await page.goto(BASE + '/inscripcion', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Validar carrito ahora' }).click();
    await page.getByText('Validate no está habilitado por PUCMM').waitFor();
    await page.screenshot({ path: `${OUT}/validate-${width}.png`, fullPage: true });

    await page.goto(BASE + '/horario', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Dar de baja' }).click();
    const finalButton = page.getByRole('button', { name: 'Dar de baja definitivamente' });
    assert.equal(await finalButton.isDisabled(), true, 'la baja exige escribir el código');
    await page.getByRole('textbox').fill('ICC-303');
    assert.equal(await finalButton.isEnabled(), true, 'el código exacto habilita el segundo confirm');
    await page.screenshot({ path: `${OUT}/drop-confirm-${width}.png`, fullPage: true });
    await page.close();
  }
  console.log(`✓ Fase 8.5 responsive: appointment, degradación Validate y doble confirmación drop (${widths.join('/')})`);
} finally {
  await browser.close();
  server.kill();
}
