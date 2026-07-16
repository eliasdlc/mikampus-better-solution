import { loginToPeopleSoft } from './login.js';
import { SCHEDULE_URL } from './peoplesoft/constants.js';
import fs from 'node:fs/promises';

// Recon de "Mi Horario" (Fase 2): vuelca el HTML real del horario inscrito
// antes de escribir el scraper. No modifica nada — solo lee y guarda.
//
// El horario vive detrás de un selector de término: PeopleSoft primero pide
// elegir el término (radio + Continue) y recién ahí muestra la grilla. Este
// script recorre ese paso y vuelca ambas pantallas para poder mirarlas.
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
  return null;
}

const TERM = process.env.RECON_TERM || null;

async function dump(page, name) {
  const frame = (await findFrame(page, '[id="ICStateNum"]')) ?? page.mainFrame();
  const html = await frame.content();
  await fs.mkdir('screenshots', { recursive: true });
  await fs.writeFile(`screenshots/recon-schedule-${name}.html`, html);
  await page.screenshot({ path: `screenshots/recon-schedule-${name}.png`, fullPage: true }).catch(() => {});
  console.log(`  volcado → screenshots/recon-schedule-${name}.html`);
  return frame;
}

async function main() {
  const { browser, page } = await loginToPeopleSoft({ headless: true });
  try {
    console.log('Abriendo Mi Horario…');
    await page.goto(SCHEDULE_URL, { waitUntil: 'commit' });
    await page.waitForTimeout(6000);

    let frame = await dump(page, 'landing');

    // ¿Estamos en el selector de término? Se reconoce por los radios SSR_DUMMY.
    const termRadios = await findFrame(page, 'input[name="SSR_DUMMY_RECV1$sels$0"]', 4000);
    if (termRadios) {
      const terms = await termRadios.evaluate(() => {
        const out = [];
        document.querySelectorAll('input[name^="SSR_DUMMY_RECV1$sels$"]').forEach((radio) => {
          const row = radio.closest('tr');
          out.push({
            value: radio.value,
            id: radio.id,
            label: row ? row.textContent.replace(/\s+/g, ' ').trim().slice(0, 70) : null,
          });
        });
        return out;
      });
      console.log('Términos disponibles:', JSON.stringify(terms, null, 2));

      // Elegimos el término pedido, o el primero si no se especificó.
      const target = TERM ? terms.find((t) => t.label?.includes(TERM) || t.value === TERM) : terms[0];
      if (!target) throw new Error(`Término ${TERM} no está en la lista`);
      console.log(`Eligiendo: ${target.label}`);

      await termRadios.locator(`[id="${target.id}"]`).check();
      await page.waitForTimeout(1500);

      const cont = await findFrame(page, 'input[value="Continue"]', 5000);
      if (cont) {
        await cont.click('input[value="Continue"]');
        await page.waitForTimeout(8000);
        frame = await dump(page, 'grid');
      }
    }

    // El horario abre en "Weekly Calendar View" (una grilla pintada por
    // PeopleSoft, incómoda de parsear). "List View" da las mismas clases como
    // filas con class nbr, sección, días/horas, aula y profesor: ese es el
    // formato que queremos scrapear, así que lo pedimos explícitamente.
    const listRadio = await findFrame(page, '[id="DERIVED_REGFRM1_SSR_SCHED_FORMAT$258$"]', 5000);
    if (listRadio) {
      console.log('Cambiando a List View…');
      await listRadio.locator('[id="DERIVED_REGFRM1_SSR_SCHED_FORMAT$258$"]').check();
      await page.waitForTimeout(7000);
      frame = await dump(page, 'list');
    }

    // Inventario de lo que hay en la pantalla final: qué ids existen y con qué
    // texto. Es lo que decide los selectores del scraper.
    const report = await frame.evaluate(() => {
      const strip = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
      const interesting = [];
      for (const el of document.querySelectorAll('[id]')) {
        const t = strip(el);
        if (!t || t.length > 90 || el.children.length > 2) continue;
        if (/^(win0div)?(DERIVED|SSR|MTG|CLASS|CRSE|STDNT)/i.test(el.id)) {
          interesting.push(`${el.id} :: ${t}`);
        }
      }
      const statusIcons = [...document.querySelectorAll('img[src*="STATUS"]')].map((i) => ({
        src: (i.getAttribute('src') ?? '').split('/').pop(),
        holder: i.closest('[id]')?.id ?? null,
      }));
      return {
        heading: strip(document.querySelector('h1, [id*="PAGETITLE"]')),
        idCount: document.querySelectorAll('[id]').length,
        interesting: [...new Set(interesting)].slice(0, 60),
        statusIcons: statusIcons.slice(0, 10),
      };
    });

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Recon falló:', err.message);
  process.exit(1);
});
