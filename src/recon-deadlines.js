import { loginToPeopleSoft } from './login.js';
import { VIEW_MY_CLASSES_URL, ENROLLMENT_DEADLINES_LINK, ENROLLMENT_DEADLINES_PANEL } from './peoplesoft/constants.js';
import fs from 'node:fs/promises';
import readline from 'node:readline';

// Recon de los plazos POR CLASE ("Enrollment Deadlines").
//
// Es la única pantalla del plan que quedó sin capturar, y por eso
// peoplesoft/enrollmentDeadlines.js sigue sin cablearse: su extractor está
// probado contra HTML armado a mano, pero ni el selector del panel ni las
// etiquetas literales que publica PUCMM están confirmadas contra la realidad.
//
// Solo LEE. No hace click en ningún botón que modifique la matrícula: abre View
// My Classes, sigue el enlace de plazos y vuelca lo que aparezca.
//
//   node src/recon-deadlines.js
//
// La contraseña se pide acá, en el momento, y no se lee del .env ni se guarda:
// es la misma regla que el resto del repo sigue desde que la credencial vive en
// el vault cifrado. El usuario se propone desde PUCMM_USERNAME si está seteado.
//
// Lo volcado va a screenshots/ y NO al repo: tiene PII. Para convertirlo en
// fixture, pasalo por scripts/make-fixture.mjs, que la limpia.

// Pide la contraseña sin ecoarla. `output: process.stderr` deja stdout limpio
// para que la salida del recon se pueda redirigir a un archivo sin arrastrar el
// prompt.
function preguntar(pregunta, { oculto = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  return new Promise((resolve) => {
    if (oculto) {
      const escribir = rl._writeToOutput.bind(rl);
      rl._writeToOutput = (str) => escribir(str.includes(pregunta) ? str : '');
    }
    rl.question(pregunta, (respuesta) => {
      if (oculto) process.stderr.write('\n');
      rl.close();
      resolve(respuesta.trim());
    });
  });
}

async function credenciales() {
  const porDefecto = process.env.PUCMM_USERNAME ?? '';
  const username = (await preguntar(`Usuario de micampus${porDefecto ? ` [${porDefecto}]` : ''}: `)) || porDefecto;
  if (!username) throw new Error('Hace falta el usuario');
  const password = await preguntar('Contraseña (no se guarda): ', { oculto: true });
  if (!password) throw new Error('Hace falta la contraseña');
  return { username, password };
}

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
  const frame = (await findFrame(page, '[id="ICStateNum"]', 4000)) ?? page.mainFrame();
  const html = await frame.content();
  await fs.mkdir('screenshots', { recursive: true });
  await fs.writeFile(`screenshots/recon-deadlines-${name}.html`, html);
  await page.screenshot({ path: `screenshots/recon-deadlines-${name}.png`, fullPage: true }).catch(() => {});
  console.log(`  volcado → screenshots/recon-deadlines-${name}.html`);
  return frame;
}

// Lo que decide si el scraper sirve: qué pares etiqueta/fecha publica la
// pantalla. El extractor real recorre las dos gramáticas de PeopleSoft (grilla
// clásica y cajas Fluid); acá se replica en crudo para poder comparar.
async function inventario(frame) {
  return frame.evaluate(() => {
    const clean = (value) => (value ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
    const strip = (el) => (el ? clean(el.textContent) : '');
    const looksLikeDate = (value) =>
      /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{3,}\s+\d{1,2},\s*\d{4}$/.test(value) ||
      /^\d{1,2}\s+de\s+[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{3,}\s+de\s+\d{4}$/.test(value) ||
      /^\d{4}-\d{2}-\d{2}$/.test(value) ||
      /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(value);

    const pares = [];
    for (const row of document.querySelectorAll('tr')) {
      const celdas = [...row.querySelectorAll('td, th')].map(strip).filter(Boolean);
      if (celdas.length < 2) continue;
      for (let i = 1; i < celdas.length; i++) {
        if (looksLikeDate(celdas[i])) pares.push({ etiqueta: celdas[i - 1], valor: celdas[i], via: 'grilla' });
      }
    }
    for (const box of document.querySelectorAll('div[id^="win0div"]')) {
      const label = strip(box.querySelector('label, .ps-label, .ps_box-label'));
      const value = strip(box.querySelector('.ps-text, .ps_box-value, span'));
      if (label && looksLikeDate(value)) pares.push({ etiqueta: label, valor: value, via: 'fluid' });
    }

    return {
      titulo: strip(document.querySelector('h1, [id*="PAGETITLE"], [id*="SS_TRANSACT_TITLE"]')),
      // Con qué selector se puede anclar el panel: es la mitad no confirmada
      // del scraper.
      tablas: [...document.querySelectorAll('table')].map((t) => t.id || t.className).filter(Boolean).slice(0, 20),
      modales: [...document.querySelectorAll('[id*="MODAL"], [id*="SSR_ENRL_DL"]')].map((el) => el.id).slice(0, 20),
      pares: pares.slice(0, 40),
    };
  });
}

async function main() {
  console.log('Recon de los plazos por clase — solo lee, no toca la matrícula.');
  const { username, password } = await credenciales();
  const { browser, page } = await loginToPeopleSoft({ headless: true, username, password });
  try {
    await page.goto(VIEW_MY_CLASSES_URL, { waitUntil: 'commit' });
    await page.waitForTimeout(8000);
    await dump(page, 'my-classes');

    const linkFrame = await findFrame(page, ENROLLMENT_DEADLINES_LINK, 8000);
    if (!linkFrame) {
      console.log('\nNo apareció el enlace de plazos con el selector actual:');
      console.log(`  ${ENROLLMENT_DEADLINES_LINK}`);
      console.log('El volcado de my-classes igual sirve: ahí está el enlace real con su id.');
      return;
    }

    await linkFrame.locator(ENROLLMENT_DEADLINES_LINK).first().click();
    await page.waitForTimeout(7000);
    const frame = await dump(page, 'panel');

    const panelFrame = (await findFrame(page, ENROLLMENT_DEADLINES_PANEL, 5000)) ?? frame;
    console.log('\nINVENTARIO DEL PANEL:');
    console.log(JSON.stringify(await inventario(panelFrame), null, 1));
    console.log('\nLo que importa son los `pares`: son las etiquetas literales que');
    console.log('DEADLINE_RULES tiene que reconocer en enrollmentDeadlines.js.');
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
