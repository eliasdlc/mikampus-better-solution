// Verifica el viaje completo del carrito contra una DB desechable:
// parser → saveCart → readCart → la forma que sirve /api/cart.
//
// El carrito se cachea para que abrir el Dashboard no dispare Playwright, y ese
// cache solo sirve si sobrevive intacto: sin horario parseado no se proyecta en
// el WeeklyGrid, y sin código canónico pierde color y título. Un test del
// parser solo no ve nada de eso (ver test-grades-db.mjs, mismo motivo).
import { chromium } from 'playwright';
import { browserLaunchOptions } from '../src/browser.js';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-test-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');

const { db } = await import('../src/db.js');
const { extractCartRows, enrichCartRows, saveCart, readCart } = await import('../src/peoplesoft/cart.js');
const { cartResponseSchema } = await import('../src/shared/schemas.ts');

db.exec(`
  INSERT INTO subjects (code) VALUES ('FIS'), ('ICC');
  INSERT INTO courses (code, subject, catalog_nbr, title) VALUES
    ('FIS-139', 'FIS', '139', 'Física II'),
    ('ICC-321', 'ICC', '321', 'Análisis y Diseño de Algoritmos');
`);

const browser = await chromium.launch(await browserLaunchOptions());
const page = await browser.newPage();
await page.setContent(await readFile('fixtures/recon-cart.html', 'utf8'));
const raw = await page.evaluate(extractCartRows);
await browser.close();

try {
  const rows = enrichCartRows(raw);

  // Un carrito nunca sincronizado no es un carrito vacío: /inscripcion los
  // dibuja distinto y para eso necesita que syncedAt nazca null.
  const virgen = readCart(1);
  assert.deepEqual(virgen.rows, [], 'sin sync, el cache está vacío');
  assert.equal(virgen.syncedAt, null, 'sin sync, no hay fecha de sync');

  saveCart(1, rows);
  const cache = cartResponseSchema.parse(readCart(1));

  assert.equal(cache.rows.length, rows.length, 'vuelven de la base todas las filas, atadas incluidas');
  assert.ok(cache.syncedAt, 'saveCart registra la sync para el StalenessTag');
  assert.deepEqual(
    cache.rows.map((r) => r.index),
    rows.map((r) => r.index),
    'el orden del carrito del portal es el orden de la base'
  );

  // Ningún campo se pierde: leído de la base tiene que valer lo mismo que
  // recién parseado. meetings viaja como JSON, que es lo más fácil de romper.
  assert.deepEqual(cache.rows, rows, 'ida y vuelta por la base sin pérdidas');

  // El carrito es un estado completo, no un incremento: si sacás una materia en
  // micampus, el cache tiene que dejar de mostrarla.
  saveCart(1, rows.slice(0, 2));
  const podado = readCart(1);
  assert.equal(podado.rows.length, 2, 're-sincronizar reemplaza el carrito entero, no acumula');
  assert.deepEqual(podado.rows.map((r) => r.index), [0, 1]);

  saveCart(1, []);
  assert.deepEqual(readCart(1).rows, [], 'un carrito vaciado en el portal se vacía acá');

  console.log(`✓ capa de cache del carrito (${rows.length} filas, ida y vuelta sin pérdidas)`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
