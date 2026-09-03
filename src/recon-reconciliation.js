import { loginForRecon } from './reconLogin.js';
import { CART_URL } from './peoplesoft/constants.js';
import { STUDENT_CENTER_URL } from './peoplesoft/grades.js';
import fs from 'node:fs/promises';

// Recon seguro de Fase 8.5. Solo navega pantallas de lectura y llega al paso
// de revisión del carrito; nunca pulsa "Finish Enrolling" ni otro botón con
// efecto sobre la matrícula.

async function findFrame(page, selector, timeout = 12_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    for (const frame of page.frames()) {
      try {
        if ((await frame.locator(selector).count()) > 0) return frame;
      } catch {
        // PeopleSoft reemplaza frames durante cada submitAction.
      }
    }
    await page.waitForTimeout(300);
  }
  return null;
}

async function dump(page, name) {
  const frame = (await findFrame(page, '#ICStateNum', 4_000)) ?? page.mainFrame();
  await fs.mkdir('screenshots', { recursive: true });
  await fs.writeFile(`screenshots/recon-${name}.html`, await frame.content());
  await page.screenshot({ path: `screenshots/recon-${name}.png`, fullPage: true }).catch(() => {});
  console.log(`  volcado -> screenshots/recon-${name}.html`);
  return frame;
}

async function inventory(frame) {
  return frame.evaluate(() => {
    const strip = (el) => (el ? el.textContent.replace(/\s+/g, ' ').replace(/ /g, ' ').trim() : '');
    return {
      title: document.title,
      text: strip(document.body).slice(0, 700),
      buttons: [...document.querySelectorAll('input[type="button"], input[type="submit"], button')]
        .map((el) => el.value || strip(el))
        .filter(Boolean),
      checkboxes: [...document.querySelectorAll('input[type="checkbox"]')].map((el) => ({
        id: el.id,
        name: el.name,
        checked: el.checked,
        label: strip(document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || strip(el.closest('tr')).slice(0, 140),
      })),
      dates: [...document.querySelectorAll('[id]')]
        .map((el) => ({ id: el.id, text: strip(el) }))
        .filter(({ id, text }) => text && text.length < 180 && /(ENRL|APPT|DATE|OPEN|START|END)/i.test(id))
        .slice(0, 80),
    };
  });
}

async function reconAppointment(page) {
  console.log('\nEnrollment appointment...');
  await page.goto(STUDENT_CENTER_URL, { waitUntil: 'commit' });
  await page.waitForTimeout(7_000);
  await dump(page, 'enrollment-appointment-landing');
  let frame = await findFrame(
    page,
    'a[id^="DERIVED_SSS_SCL_SSS_LINK_OPENENRL"], a:has-text("Open Enrollment Dates")'
  );
  if (!frame) throw new Error('No apareció Open Enrollment Dates');
  await frame
    .locator('a[id^="DERIVED_SSS_SCL_SSS_LINK_OPENENRL"], a:has-text("Open Enrollment Dates")')
    .first()
    .click();
  await page.waitForTimeout(6_000);
  frame = await dump(page, 'enrollment-appointment');
  console.log(JSON.stringify(await inventory(frame), null, 2));
}

async function reconCartReview(page) {
  console.log('\nCarrito, revisión/Validate/waitlist...');
  await page.goto(CART_URL, { waitUntil: 'commit' });
  await page.waitForTimeout(6_000);
  let frame = await dump(page, 'cart-phase85-step1');
  console.log('Paso 1:', JSON.stringify(await inventory(frame), null, 2));

  const proceed = frame.locator('input[value="Proceed to Step 2 of 3"]');
  if ((await proceed.count()) === 0) {
    console.log('Carrito sin botón de revisión; no hay paso 2 que inspeccionar.');
    return;
  }
  await proceed.click();
  await page.waitForTimeout(7_000);
  frame = await dump(page, 'cart-phase85-step2');
  const report = await inventory(frame);
  console.log('Paso 2:', JSON.stringify(report, null, 2));
  if (report.buttons.some((button) => /Finish Enrolling/i.test(button))) {
    console.log('  GUARD: Finish Enrolling está visible y NO se tocó.');
  }
}

const { browser, page } = await loginForRecon();
try {
  await reconAppointment(page);
  await reconCartReview(page);
} finally {
  await browser.close();
}
