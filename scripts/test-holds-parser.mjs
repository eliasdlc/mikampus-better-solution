import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { extractHolds, parseHolds, HOLDS_PANEL, TODO_PANEL } from '../src/peoplesoft/holds.js';

// Corre el parser de holds contra el Centro del Alumnado real, sin tocarlo.
// El estudiante no tiene holds: lo que este test fija es que el estado vacío
// se lea como vacío y que un selector roto no se disfrace de "todo bien".
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(await readFile('fixtures/recon-student-center.html', 'utf8'));

const raw = await page.evaluate(extractHolds);

// Los dos paneles existen y el portal escribe su centinela adentro.
assert.deepEqual(raw.holds, ['No Holds.'], 'el panel de holds trae solo el centinela');
assert.deepEqual(raw.todos, ["No To Do's."], 'el de pendientes también');

const parsed = parseHolds(raw);
assert.deepEqual(parsed.holds, [], 'sin holds');
assert.deepEqual(parsed.todos, [], 'sin pendientes');

// El centinela NO es un hold. Si se colara, el dashboard diría "1 hold activo"
// para siempre y la alerta dejaría de significar nada.
assert.ok(parsed.holds.every((h) => !/no holds/i.test(h.title)), 'el centinela no se cuela como hold');

// Y la distinción que de verdad importa: "no hay holds" y "no encontré el
// panel" no pueden verse igual. Un selector roto tiene que ser un error, no un
// alta médica.
assert.equal(parsed.holdsPanelFound, true, 'el panel se encontró');
const rotos = parseHolds({ holds: null, todos: null });
assert.equal(rotos.holdsPanelFound, false, 'sin panel se reporta como no encontrado');
assert.deepEqual(rotos.holds, [], 'y no inventa holds');

// Los paneles se acotan por contención DOM: el Student Center repite ids con
// $N$ por toda la página y el panel de al lado (pendientes) no puede filtrarse
// en la lista de holds.
assert.notEqual(HOLDS_PANEL, TODO_PANEL);
const holdsPanelExists = await page.locator(`[id="${HOLDS_PANEL}"]`).count();
const todoPanelExists = await page.locator(`[id="${TODO_PANEL}"]`).count();
assert.equal(holdsPanelExists, 1, 'el panel de holds está donde el recon lo dejó');
assert.equal(todoPanelExists, 1, 'y el de pendientes también');

// Un hold hipotético: cuando exista uno real hay que re-hacer el recon, pero
// mientras tanto la severidad no se inventa.
const conHold = parseHolds({ holds: ['Deuda pendiente con caja'], todos: [] });
assert.equal(conHold.holds.length, 1);
assert.equal(conHold.holds[0].severity, 'unknown', 'la severidad no se adivina: el portal no la dio');

await browser.close();
console.log('✓ holds: panel vacío leído como vacío, centinela no confundido, panel ausente = error');
