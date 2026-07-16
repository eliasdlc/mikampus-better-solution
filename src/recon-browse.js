import { loginToPeopleSoft } from './login.js';
import { BROWSE_CATALOG_URL } from './peoplesoft/constants.js';
import fs from 'node:fs/promises';

// Recon del Browse Course Catalog: la pantalla hermana del Class Search dentro
// de la misma carpeta del portal (HCCC_SS_CATALOG). Busca contestar dos cosas
// que el Class Search no contesta:
//
//   1. ¿Cuáles son los subjects que existen? (hoy están hardcodeados)
//   2. ¿De dónde sale el título de cada materia? (el Class Search lo da vacío,
//      ver el comentario en peoplesoft/catalog.js sobre resolveTitle)
//
// Solo navega y vuelca HTML. No escribe en la DB ni toca el carrito.
async function findFrame(page, selector, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const frame of page.frames()) {
      try {
        if ((await frame.locator(selector).count()) > 0) return frame;
      } catch {
        // frame desprendido a mitad de un AJAX; reintentar
      }
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`No se encontró: ${selector}`);
}

// El volcado va a screenshots/ (gitignored) porque sale de una sesión logueada:
// lleva tokens y el nombre del estudiante. Para versionarlo como fixture hay
// que pasarlo por scripts/make-fixture.mjs, que los saca.
const SUBJECT = (process.env.RECON_SUBJECT || 'ICC').toUpperCase();

async function main() {
  const { browser, page } = await loginToPeopleSoft({ headless: true });
  try {
    await page.goto(BROWSE_CATALOG_URL, { waitUntil: 'commit' });
    await page.waitForTimeout(6000);

    const frame = await findFrame(page, '[id="ICStateNum"]');
    await fs.writeFile('screenshots/recon-browse-landing.html', await frame.content());
    console.log('Landing volcado → screenshots/recon-browse-landing.html');

    // Qué hay en la pantalla: los tabs de letra y los grupos de subject.
    const shape = await frame.evaluate(() => {
      const ids = (sel) => [...document.querySelectorAll(sel)].map((el) => el.id).slice(0, 12);
      const text = (sel) =>
        [...document.querySelectorAll(sel)].map((el) => el.textContent.replace(/\s+/g, ' ').trim()).slice(0, 12);
      return {
        letterTabs: text('a[id^="DERIVED_SSS_BCC_SSR_ALPHANUM"]'),
        letterTabIds: ids('a[id^="DERIVED_SSS_BCC_SSR_ALPHANUM"]'),
        subjectAnchors: text('a[id^="DERIVED_SSS_BCC_GROUP_BOX"]'),
        subjectAnchorIds: ids('a[id^="DERIVED_SSS_BCC_GROUP_BOX"]'),
        expandAll: ids('a[id*="EXPAND"], a[id*="SHOW_ALL"]'),
        bodySample: document.body.textContent.replace(/\s+/g, ' ').trim().slice(0, 600),
      };
    });
    console.log(JSON.stringify(shape, null, 2));

    // Un subject vive bajo la pestaña de su letra inicial, y sus materias solo
    // existen en el DOM tras expandirlo por AJAX: ahí aparecen los títulos.
    let f = await findFrame(page, 'a[id^="DERIVED_SSS_BCC_SSR_ALPHANUM"]');
    const tab = f.locator('a[id^="DERIVED_SSS_BCC_SSR_ALPHANUM"]').filter({ hasText: new RegExp(`^${SUBJECT[0]}$`) });
    if (await tab.count()) {
      await tab.first().click();
      await page.waitForTimeout(6000);
      f = await findFrame(page, '[id="ICStateNum"]');
    }

    const link = f.locator('a[id^="DERIVED_SSS_BCC_GROUP_BOX"]').filter({ hasText: new RegExp(`^${SUBJECT} - `) });
    if ((await link.count()) === 0) throw new Error(`No apareció el subject ${SUBJECT} bajo la letra ${SUBJECT[0]}`);
    await link.first().click();
    await page.waitForTimeout(7000);

    f = await findFrame(page, '[id="ICStateNum"]');
    await fs.writeFile(`screenshots/recon-browse-${SUBJECT}-expanded.html`, await f.content());
    console.log(`${SUBJECT} expandido → screenshots/recon-browse-${SUBJECT}-expanded.html`);

    const rows = await f.evaluate(() =>
      [...document.querySelectorAll('[id^="CRSE_NBR$"]')]
        .filter((el) => /^CRSE_NBR\$\d+$/.test(el.id))
        .map((el) => {
          const i = el.id.split('$')[1];
          const title = document.getElementById(`CRSE_TITLE$${i}`);
          return `${el.textContent.trim()} — ${title ? title.textContent.trim() : '(sin título)'}`;
        })
    );
    console.log(rows.join('\n'));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
