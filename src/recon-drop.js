import { loginForRecon } from './reconLogin.js';
import { DROP_URL } from './peoplesoft/constants.js';
import fs from 'node:fs/promises';

// Recon de la baja de materias (plan §5.5, Fase 5). Vuelca el HTML real de la
// pantalla de Drop antes de escribir el scraper — como todo scraper de este
// repo (principio #1: recon → scraper validado con Zod → endpoint → pantalla).
//
// Este recon es distinto a los demás en una cosa: los otros leen pantallas que
// no cambian nada (notas, horario, catálogo). El drop MODIFICA tu matrícula, y
// una baja no se deshace: si el cupo era el último, lo perdiste. Por eso acá el
// script tiene frenos que los otros no necesitan:
//
//   1. Por defecto NO pasa del Paso 1 (la lista de materias con checkboxes).
//      Con eso ya se ve la mitad del scraper: cómo se identifica cada materia y
//      con qué id se la selecciona.
//   2. --hasta-confirmacion selecciona una materia y llega al Paso 2 (la
//      pantalla de "confirmá tu selección"). En PeopleSoft ese paso todavía no
//      da de baja nada — la baja la hace "Finish Dropping" del Paso 2— pero es
//      TU matrícula y la afirmación es de la documentación, no de haberlo visto.
//      Por eso es opt-in y no el default.
//   3. "Finish Dropping" no se clickea NUNCA. No hay flag que lo habilite: si
//      alguna vez hay que ver el Paso 3, que sea escribiéndolo a propósito y no
//      pasando una bandera de más.
//
//   node src/recon-drop.js                      # Paso 1
//   node src/recon-drop.js --hasta-confirmacion # Paso 1 → Paso 2 (sin confirmar)
//   RECON_TERM="Septiembre" node src/recon-drop.js
//
// Lo volcado va a screenshots/ y NO al repo: tiene PII. Para convertirlo en
// fixture, pasalo por scripts/make-fixture.mjs, que la limpia.

const HASTA_CONFIRMACION = process.argv.includes('--hasta-confirmacion');
const TERM = process.env.RECON_TERM || null;

// La frase que jamás se clickea. Vive en una constante para que el guard de más
// abajo y este comentario no puedan separarse.
const BOTON_DESTRUCTIVO = 'Finish Dropping';

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
  await fs.writeFile(`screenshots/recon-drop-${name}.html`, html);
  await page.screenshot({ path: `screenshots/recon-drop-${name}.png`, fullPage: true }).catch(() => {});
  console.log(`  volcado → screenshots/recon-drop-${name}.html`);
  return frame;
}

// Inventario de la pantalla: qué ids hay, con qué texto, y qué botones existen.
// Es lo que decide los selectores del scraper que venga después.
async function inventario(frame) {
  return frame.evaluate(() => {
    const strip = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
    const interesting = [];
    for (const el of document.querySelectorAll('[id]')) {
      const t = strip(el);
      if (!t || t.length > 90 || el.children.length > 2) continue;
      if (/^(win0div)?(DERIVED|SSR|MTG|CLASS|CRSE|STDNT|P_)/i.test(el.id)) interesting.push(`${el.id} :: ${t}`);
    }
    return {
      heading: strip(document.querySelector('h1, [id*="PAGETITLE"]')),
      // Los checkboxes de selección: la llave de "qué materia estoy dando de
      // baja" y lo primero que el scraper necesita saber.
      checkboxes: [...document.querySelectorAll('input[type="checkbox"]')].map((c) => ({
        id: c.id,
        name: c.name,
        fila: strip(c.closest('tr')).slice(0, 80),
      })),
      botones: [...document.querySelectorAll('input[type="button"], input[type="submit"], a.SSSBUTTON_CONFIRMLINK')].map(
        (b) => b.value || strip(b)
      ),
      // ¿Dice el portal si una materia NO se puede dar de baja (fuera de plazo,
      // hold)? Es la pregunta que decide si la UI puede prometer el botón.
      mensajes: [...document.querySelectorAll('[id*="MESSAGE"], .PSTEXT')]
        .map((el) => strip(el))
        .filter((t) => t && t.length < 200)
        .slice(0, 15),
      interesting: [...new Set(interesting)].slice(0, 60),
    };
  });
}

async function main() {
  console.log('Recon de la baja de materias — NO da de baja nada.');
  console.log(HASTA_CONFIRMACION ? '  modo: Paso 1 → Paso 2 (sin confirmar)' : '  modo: solo Paso 1');

  const { browser, page } = await loginForRecon();
  try {
    await page.goto(DROP_URL, { waitUntil: 'commit' });
    await page.waitForTimeout(6000);

    let frame = await dump(page, 'landing');

    // Igual que Mi Horario: primero pide elegir término (radios SSR_DUMMY).
    const termRadios = await findFrame(page, 'input[name="SSR_DUMMY_RECV1$sels$0"]', 4000);
    if (termRadios) {
      const terms = await termRadios.evaluate(() =>
        [...document.querySelectorAll('input[name^="SSR_DUMMY_RECV1$sels$"]')].map((radio) => ({
          id: radio.id,
          value: radio.value,
          label: radio.closest('tr')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 70) ?? null,
        }))
      );
      console.log('Términos:', JSON.stringify(terms, null, 2));

      const target = TERM ? terms.find((t) => t.label?.includes(TERM) || t.value === TERM) : terms[0];
      if (!target) throw new Error(`Término ${TERM} no está en la lista`);
      console.log(`Eligiendo: ${target.label}`);
      await termRadios.locator(`[id="${target.id}"]`).check();
      await page.waitForTimeout(1500);

      const cont = await findFrame(page, 'input[value="Continue"]', 5000);
      if (cont) {
        await cont.click('input[value="Continue"]');
        await page.waitForTimeout(8000);
        frame = await dump(page, 'paso1');
      }
    }

    const paso1 = await inventario(frame);
    console.log('\n── Paso 1: elegir materias ──');
    console.log(JSON.stringify(paso1, null, 2));

    if (!HASTA_CONFIRMACION) {
      console.log('\nHasta acá llega el default. Para ver la pantalla de confirmación:');
      console.log('  node src/recon-drop.js --hasta-confirmacion');
      return;
    }

    // Paso 1 → Paso 2. Selecciona la PRIMERA materia listada solo para que el
    // portal muestre la pantalla siguiente; nada de esto la da de baja.
    const check = paso1.checkboxes[0];
    if (!check) {
      console.log('\nNo hay materias que dar de baja en este término: no hay Paso 2 que ver.');
      return;
    }
    console.log(`\nSeleccionando "${check.fila}" para llegar al Paso 2 (sigue sin dar de baja nada)…`);
    await frame.locator(`[id="${check.id}"]`).check();
    await page.waitForTimeout(1000);

    const dropBtn = await findFrame(page, 'input[value="Drop Selected Classes"]', 5000);
    if (!dropBtn) {
      console.log('No apareció "Drop Selected Classes" — mirá el volcado del Paso 1.');
      return;
    }
    await dropBtn.click('input[value="Drop Selected Classes"]');
    await page.waitForTimeout(8000);
    frame = await dump(page, 'paso2-confirmacion');

    const paso2 = await inventario(frame);
    console.log('\n── Paso 2: confirmación (NO confirmada) ──');
    console.log(JSON.stringify(paso2, null, 2));

    // El freno, escrito como código y no como intención: si el botón
    // destructivo está en pantalla, se reporta y se sale. Nadie lo clickea.
    if (paso2.botones.some((b) => b.includes(BOTON_DESTRUCTIVO))) {
      console.log(`\n⚠ "${BOTON_DESTRUCTIVO}" está en pantalla y NO se tocó. El recon termina acá.`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Recon falló:', err.message);
  process.exit(1);
});
