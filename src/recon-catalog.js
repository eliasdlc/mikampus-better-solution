import { loginToPeopleSoft } from './login.js';
import { CLASS_SEARCH_URL } from './peoplesoft/constants.js';
import fs from 'node:fs/promises';

// Recon dirigido (una sola búsqueda, bajo volumen) para descubrir cómo el
// Class Search de PUCMM agrupa VARIAS materias en una búsqueda por prefijo de
// catalog_nbr — en particular, de dónde sale el título y los créditos de cada
// materia, que la grilla de una sola materia no expone. No modifica nada.
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

const TERM = process.env.RECON_TERM || '1930'; // Septiembre de 2026
const CAREER = 'GRDO';
const PREFIX = process.env.RECON_PREFIX || 'ICC';

async function main() {
  const { browser, page } = await loginToPeopleSoft({ headless: true });
  try {
    console.log(`Recon: término ${TERM}, carrera ${CAREER}, catalog_nbr contains "${PREFIX}"`);
    await page.goto(CLASS_SEARCH_URL, { waitUntil: 'commit' });
    await page.waitForTimeout(5000);

    let f = await findFrame(page, 'select[name="CLASS_SRCH_WRK2_STRM$35$"]');
    await f.selectOption('select[name="CLASS_SRCH_WRK2_STRM$35$"]', TERM);
    await page.waitForTimeout(4000);

    f = await findFrame(page, 'select[name="SSR_CLSRCH_WRK_ACAD_CAREER$2"]');
    await f.selectOption('select[name="SSR_CLSRCH_WRK_ACAD_CAREER$2"]', CAREER);
    await page.waitForTimeout(4000);

    // catalog_nbr = prefijo con "contains" → trae todas las materias del subject.
    f = await findFrame(page, 'select[name="SSR_CLSRCH_WRK_SSR_EXACT_MATCH1$1"]');
    await f.selectOption('select[name="SSR_CLSRCH_WRK_SSR_EXACT_MATCH1$1"]', 'C');
    await page.waitForTimeout(1000);
    f = await findFrame(page, 'input[name="SSR_CLSRCH_WRK_CATALOG_NBR$1"]');
    await f.fill('input[name="SSR_CLSRCH_WRK_CATALOG_NBR$1"]', PREFIX);
    await page.waitForTimeout(1000);

    f = await findFrame(page, '[id="SSR_CLSRCH_WRK_SSR_OPEN_ONLY$3"]');
    const openOnly = f.locator('[id="SSR_CLSRCH_WRK_SSR_OPEN_ONLY$3"]');
    if (await openOnly.isChecked()) {
      await openOnly.uncheck();
      await page.waitForTimeout(3000);
    }

    f = await findFrame(page, 'input[value="Search"]');
    await f.click('input[value="Search"]');
    await page.waitForTimeout(8000);

    f = await findFrame(page, '[id="ICStateNum"]');
    const html = await f.content();
    await fs.writeFile(`screenshots/recon-catalog-${PREFIX}.html`, html);
    await page.screenshot({ path: `screenshots/recon-catalog-${PREFIX}.png`, fullPage: true }).catch(() => {});

    // Cada materia agrupa sus secciones en un div
    // "win0divSSR_CLSRSLT_WRK_GROUPBOX2$N" que envuelve tanto el header
    // (link "SSR_CLSRSLT_WRK_GROUPBOX2$N", texto "SUBJ   SUBJ+NBR - título")
    // como las filas de sección (MTG_CLASS_NBR$i) de esa materia. El título
    // que trae el portal viene vacío en este listado, así que solo extraemos
    // subject/catalogNbr — el título real sale de la tabla local `courses`.
    const report = await f.evaluate(() => {
      const strip = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);

      const courses = [];
      for (const anchor of document.querySelectorAll('a[id^="SSR_CLSRSLT_WRK_GROUPBOX2$"]')) {
        const label = strip(anchor.parentElement);
        const match = label && label.match(/^([A-Z]{2,4})\s+\1?(\d{2,4}[A-Z]?)\s*-\s*(.*)$/);
        const container = anchor.closest('div[id^="win0divSSR_CLSRSLT_WRK_GROUPBOX2$"]');

        const sections = [];
        if (container) {
          // ojo: el selector por prefijo también atraparía el <span
          // id="MTG_CLASS_NBR$span$N"> que envuelve el link; se filtra con
          // el regex exacto para no duplicar cada sección.
          const nbrEls = [...container.querySelectorAll('[id^="MTG_CLASS_NBR$"]')].filter((el) =>
            /^MTG_CLASS_NBR\$\d+$/.test(el.id)
          );
          for (const nbrEl of nbrEls) {
            const i = nbrEl.id.split('$')[1];
            sections.push({
              classNbr: strip(nbrEl),
              section: strip(document.getElementById(`MTG_CLASSNAME$${i}`)),
              dayTime: strip(document.getElementById(`MTG_DAYTIME$${i}`)),
              instr: strip(document.getElementById(`MTG_INSTR$${i}`)),
              room: strip(document.getElementById(`MTG_ROOM$${i}`)),
            });
          }
        }

        courses.push({
          subject: match ? match[1] : null,
          catalogNbr: match ? match[2] : null,
          titleFromPortal: match && match[3].trim() ? match[3].trim() : null,
          label,
          sections,
        });
      }

      const totalSections = courses.reduce((sum, c) => sum + c.sections.length, 0);
      const exceeds = !!document.body.textContent.match(/exceed the maximum limit/i);
      return { totalSections, exceeds, courses };
    });

    console.log(JSON.stringify(report, null, 2));
    console.log(`\nHTML → screenshots/recon-catalog-${PREFIX}.html`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Recon falló:', err.message);
  process.exit(1);
});
