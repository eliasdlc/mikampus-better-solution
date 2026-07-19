import { chromium } from 'playwright';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-reconciliation-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');

const {
  extractEnrollmentWindows,
  parseEnrollmentWindows,
  saveEnrollmentWindows,
  readEnrollmentWindows,
} = await import('../src/peoplesoft/enrollmentWindows.js');
const { extractCartCapabilities } = await import('../src/peoplesoft/cart.js');
const { extractDropOptions, parseDropOptions, extractDropConfirmation, extractDropResult } = await import(
  '../src/peoplesoft/dropClass.js'
);

const browser = await chromium.launch();
const page = await browser.newPage();
try {
  await page.setContent(await readFile('fixtures/recon-enrollment-appointment.html', 'utf8'));
  const windows = parseEnrollmentWindows(await page.evaluate(extractEnrollmentWindows));
  assert.deepEqual(windows, [
    {
      termCode: '1930',
      session: 'Regular Academic Session',
      startsAt: '2026-07-16',
      endsAt: '2026-09-03',
      precision: 'date',
    },
  ]);
  saveEnrollmentWindows(1, windows);
  const stored = readEnrollmentWindows(1, '1930');
  assert.equal(stored.windows.length, 1);
  assert.equal(stored.windows[0].precision, 'date', 'la hora ausente no se inventa como medianoche');

  for (const fixture of ['fixtures/recon-cart-phase85-step1.html', 'fixtures/recon-cart-phase85-step2.html']) {
    await page.setContent(await readFile(fixture, 'utf8'));
    const capabilities = await page.evaluate(extractCartCapabilities);
    assert.equal(capabilities.validate, false, `${fixture}: PUCMM no expone Validate`);
    assert.equal(capabilities.waitlistChoice, false, `${fixture}: sin toggle de waitlist`);
    assert.equal(capabilities.waitlistPosition, false, `${fixture}: sin posición de waitlist`);
  }

  await page.setContent(await readFile('fixtures/recon-drop-landing.html', 'utf8'));
  const rawDrop = await page.evaluate(extractDropOptions);
  const options = parseDropOptions(rawDrop, { subjects: ['ICC'] });
  assert.equal(rawDrop.termCode, '1930');
  assert.equal(options.length, 1, 'solo la sección principal tiene checkbox; el práctico viaja atado');
  assert.equal(options[0].courseCode, 'ICC-233');
  assert.equal(options[0].classNbr, '5225');
  assert.equal(options[0].checkboxId, 'DERIVED_REGFRM1_SSR_SELECT$0');

  await page.setContent(await readFile('fixtures/recon-drop-paso2-confirmacion.html', 'utf8'));
  const confirmation = await page.evaluate(extractDropConfirmation);
  assert.equal(confirmation.title, '2. Confirm your selection');
  assert.equal(confirmation.hasFinish, true);
  assert.ok(confirmation.classes.some((label) => label.includes('5225')));
  const beforeSubmit = await page.evaluate(extractDropResult);
  assert.equal(beforeSubmit.dropped, false, 'el icono Dropped de la leyenda no se confunde con resultado exitoso');

  console.log('✓ reconciliación: appointment real, Validate/waitlist ausentes y drop hasta confirmación');
} finally {
  await browser.close();
  await rm(dir, { recursive: true, force: true });
}
