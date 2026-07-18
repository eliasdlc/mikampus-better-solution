import { loginToPeopleSoft } from './login.js';
import { VIEW_SCHEDULE_URL } from './peoplesoft/constants.js';
import fs from 'node:fs/promises';

// Recon del VISOR de horario (componente LAM SS_LAM_STD_GR_LST), el que muestra
// el ciclo actual y los pasados — a diferencia de SSR_SSENRL_SCHD_W, que solo
// ofrece ciclos abiertos para inscribir. No modifica nada: solo lee y vuelca el
// HTML real para escribir el parser contra un fixture, no a ciegas.
//
// Todavía no sabemos la forma de esta pantalla: si abre directo en un ciclo, si
// pide elegir término, ni con qué ids pinta las materias. Este script vuelca lo
// que aparezca e inventaría los ids con texto, que es lo que decide los
// selectores del futuro scraper. Correr: npm run recon:view-schedule
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

async function dump(page, name) {
  const frame = (await findFrame(page, '[id="ICStateNum"]')) ?? page.mainFrame();
  const html = await frame.content();
  await fs.mkdir('screenshots', { recursive: true });
  await fs.writeFile(`screenshots/recon-view-schedule-${name}.html`, html);
  await page.screenshot({ path: `screenshots/recon-view-schedule-${name}.png`, fullPage: true }).catch(() => {});
  console.log(`  volcado → screenshots/recon-view-schedule-${name}.html`);
  return frame;
}

async function main() {
  const { browser, page } = await loginToPeopleSoft({ headless: true });
  try {
    console.log('Abriendo el visor de horario (LAM)…');
    await page.goto(VIEW_SCHEDULE_URL, { waitUntil: 'commit' });
    await page.waitForTimeout(6000);

    let frame = await dump(page, 'landing');

    // ¿Hay selector de término tipo SSR_DUMMY como en Mi Horario? Lo reportamos
    // para saber si este componente también lo pide o si abre directo.
    const termRadios = await findFrame(page, 'input[name^="SSR_DUMMY_RECV1$sels$"]', 4000);
    if (termRadios) {
      const terms = await termRadios.evaluate(() =>
        [...document.querySelectorAll('input[name^="SSR_DUMMY_RECV1$sels$"]')].map((radio) => {
          const row = radio.closest('tr');
          return {
            value: radio.value,
            id: radio.id,
            label: row ? row.textContent.replace(/\s+/g, ' ').trim().slice(0, 70) : null,
          };
        })
      );
      console.log('Selector de término presente. Términos:', JSON.stringify(terms, null, 2));

      // Elegimos un ciclo y damos Continuar para ver qué devuelve la pantalla
      // interna: si trae días/horas/aula (horario real) o solo materias+notas.
      // Por defecto el más reciente (el último de la lista); RECON_TERM lo cambia
      // (matchea por etiqueta, ej. RECON_TERM="Abril de 2026", o por value).
      const wanted = process.env.RECON_TERM || null;
      const target = wanted ? terms.find((t) => t.label?.includes(wanted) || t.value === wanted) : terms[terms.length - 1];
      if (!target) throw new Error(`Término ${wanted} no está en la lista`);
      console.log(`Eligiendo: ${target.label}`);

      await termRadios.locator(`[id="${target.id}"]`).check();
      await page.waitForTimeout(1500);
      const cont = await findFrame(page, 'input[value="Continue"], input[value="Continuar"]', 5000);
      if (cont) {
        await cont.locator('input[value="Continue"], input[value="Continuar"]').first().click();
        await page.waitForTimeout(8000);
        frame = await dump(page, 'term');
      } else {
        console.log('No apareció el botón Continuar tras elegir el ciclo.');
      }
    } else {
      console.log('Sin selector de término: el componente abre directo en un ciclo.');
    }

    // Inventario de ids con texto corto: la materia prima de los selectores.
    const report = await frame.evaluate(() => {
      const strip = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
      const interesting = [];
      for (const el of document.querySelectorAll('[id]')) {
        const t = strip(el);
        if (!t || t.length > 90 || el.children.length > 2) continue;
        if (/^(win0div)?(DERIVED|SSR|MTG|CLASS|CRSE|STDNT|SS_LAM|ACE|PAGROUP)/i.test(el.id)) {
          interesting.push(`${el.id} :: ${t}`);
        }
      }
      return {
        heading: strip(document.querySelector('h1, [id*="PAGETITLE"]')),
        idCount: document.querySelectorAll('[id]').length,
        strm: (document.documentElement.innerHTML.match(/STRM:"(\d+)"/) ?? [])[1] ?? null,
        interesting: [...new Set(interesting)].slice(0, 80),
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
