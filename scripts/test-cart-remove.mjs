// Quitar una materia del carrito, contra el HTML real del portal
// (fixtures/recon-cart.html) y sin salir a PUCMM.
//
// Lo que protege, en orden de cuánto duele equivocarse:
//   1. Que se borre la fila del NRC pedido y no la del índice que mandó el
//      browser. Los índices del carrito se renumeran cuando sale una materia:
//      borrar por índice es la forma directa de sacar la materia equivocada.
//   2. Que una fila atada (un práctico sin botón propio) falle con una
//      explicación en vez de un error de selector.
//   3. Que la confirmación sea el carrito releído y no el click: si el portal
//      ignora la acción, esto tiene que gritarlo, no devolver ok.
import { chromium } from 'playwright';
// La app nunca lanza chromium a pelo: browserLaunchOptions prefiere el
// chromium del sistema sobre el que administra Playwright (src/browser.js).
// Un test que se salta esa lógica prueba un arranque que la app no usa, y
// falla en cualquier máquina donde el cache de Playwright no esté al día.
import { browserLaunchOptions } from '../src/browser.js';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-cart-remove-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');

const { db } = await import('../src/db.js');
const { removeFromCart } = await import('../src/peoplesoft/cart.js');

db.exec(`
  INSERT INTO subjects (code) VALUES ('FIS'), ('ICC');
  INSERT INTO courses (code, subject, catalog_nbr, title) VALUES
    ('FIS-139', 'FIS', '139', 'Física II'),
    ('ICC-321', 'ICC', '321', 'Análisis y Diseño de Algoritmos');
`);

const html = await readFile('fixtures/recon-cart.html', 'utf8');
const browser = await chromium.launch(await browserLaunchOptions());

// El fixture es una página suelta: no hay servidor que procese el submit de
// PeopleSoft. Se simula lo que el portal hace al borrar —sacar la fila del DOM—
// interceptando el click, que es exactamente el contrato que el scraper asume.
async function fakePortal({ deleteWorks = true } = {}) {
  const page = await browser.newPage();
  await page.setContent(html);
  await page.evaluate((works) => {
    for (const link of document.querySelectorAll('[id^="P_DELETE$"]')) {
      link.removeAttribute('href');
      link.addEventListener('click', (event) => {
        event.preventDefault();
        if (!works) return;
        const index = link.id.split('$').at(-1);
        // El portal saca la fila entera; acá alcanza con quitar el wrapper que
        // el parser usa para reconocerla.
        document.getElementById(`win0divP_CLASS_NAME$${index}`)?.remove();
        document.getElementById(`win0divP_DELETE$${index}`)?.remove();
      });
    }
  }, deleteWorks);
  // El scraper navega antes de leer; en el fixture eso borraría el contenido.
  page.goto = async () => {};
  page.waitForTimeout = async () => {};
  return page;
}

try {
  // ── 1. Se quita la fila del NRC pedido ────────────────────────────────────
  let page = await fakePortal();
  const steps = [];
  const result = await removeFromCart(page, { classNbr: '5227', onStep: (m) => steps.push(m) });

  assert.equal(result.removed.classNbr, '5227', 'quita la fila del NRC pedido');
  assert.equal(result.removed.courseCode, 'ICC-321', 'y la reporta con su código canónico');
  assert.ok(
    !result.rows.some((row) => row.classNbr === '5227'),
    'el carrito releído ya no la trae'
  );
  assert.ok(
    result.rows.some((row) => row.classNbr === '3656'),
    'y no se llevó por delante las demás filas'
  );
  assert.ok(steps.length > 0, 'publica su progreso: son segundos de Playwright, no una edición local');
  await page.close();

  // ── 2. Una fila atada se explica, no se rompe ─────────────────────────────
  // En el fixture, ICC321-171 (NRC 5228) es el práctico ligado a ICC321-101:
  // aparece en el carrito pero PeopleSoft no le da botón de borrar propio, solo
  // P_DELETE en los índices 0, 1, 3 y 5.
  page = await fakePortal();
  const buttons = await page.evaluate(() =>
    [...document.querySelectorAll('[id^="P_DELETE$"]')].map((el) => el.id)
  );
  assert.deepEqual(buttons, ['P_DELETE$0', 'P_DELETE$1', 'P_DELETE$3', 'P_DELETE$5'], 'las filas atadas no traen botón');
  await assert.rejects(
    () => removeFromCart(page, { classNbr: '5228' }),
    /ligada/,
    'una fila sin botón propio se explica en palabras, no en un error de selector'
  );
  await page.close();

  // ── 3. Un NRC que no está en el carrito no borra nada ─────────────────────
  page = await fakePortal();
  await assert.rejects(
    () => removeFromCart(page, { classNbr: '9999' }),
    /ya no está en el carrito/,
    'sin fila que coincida no se clickea ningún botón'
  );
  await page.close();

  // ── 4. Un portal que ignora el click no se reporta como éxito ─────────────
  page = await fakePortal({ deleteWorks: false });
  await assert.rejects(
    () => removeFromCart(page, { classNbr: '5227' }),
    /no quitó/,
    'la verdad es el carrito releído, no el click'
  );
  await page.close();

  // ── 5. Sin NRC ni código no se adivina ────────────────────────────────────
  page = await fakePortal();
  await assert.rejects(() => removeFromCart(page, {}), /Hace falta el NRC/, 'no se borra por posición');
  await page.close();

  console.log('✓ quitar del carrito: por NRC y no por índice, filas atadas explicadas, y verificación contra el portal releído');
} finally {
  await browser.close();
  await rm(dir, { recursive: true, force: true });
}
