import { loginToPeopleSoft } from './login.js';
import { MANAGE_CLASSES_START_URL, VIEW_MY_CLASSES_URL } from './peoplesoft/constants.js';
import fs from 'node:fs/promises';

// Recon de View My Classes (Fluid) — el horario REAL con día/hora/aula de
// cualquier ciclo inscrito, actual o pasado. Es la pantalla a la que hay que
// mudar /horario: SSR_SSENRL_SCHD_W (el que usamos hoy) solo ve el ciclo abierto
// para inscribir, y SS_LAM_STD_GR_LST (el gradebook) no trae reuniones.
//
// No modifica nada: abre el START del tile Manage Classes para crear el
// navigation collection Fluid, entra a la hoja View My Classes, y vuelca el HTML
// real (landing + un ciclo pasado) para escribir el parser contra un fixture, no
// a ciegas. Todavía no sabemos la forma exacta: si el selector de ciclo es un
// dropdown, tabs o un panel; ni con qué ids pinta las reuniones. Este script
// vuelca lo que aparezca e inventaría los ids con texto. Correr: npm run recon:my-classes
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
  await fs.writeFile(`screenshots/recon-my-classes-${name}.html`, html);
  await page.screenshot({ path: `screenshots/recon-my-classes-${name}.png`, fullPage: true }).catch(() => {});
  console.log(`  volcado → screenshots/recon-my-classes-${name}.html`);
  return frame;
}

// Inventario de ids con texto corto: la materia prima de los selectores del
// futuro parser. Reporta también si hay una pinta de selector de ciclo (combo,
// tabs) y si hay reuniones a la vista (días/horas).
async function inventory(frame) {
  return frame.evaluate(() => {
    const strip = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
    const interesting = [];
    for (const el of document.querySelectorAll('[id]')) {
      const t = strip(el);
      if (!t || t.length > 90 || el.children.length > 2) continue;
      if (/(TERM|STRM|CLASS|CRSE|MTG|SCHED|MEETING|DAYS|ROOM|INSTR|SSR_|SSRDCLS|ENRL|SUBJECT|CATALOG)/i.test(el.id)) {
        interesting.push(`${el.id} :: ${t}`);
      }
    }
    // Candidatos a selector de ciclo: <select> o cualquier control con TERM/STRM.
    const termControls = [...document.querySelectorAll('select, [id*="TERM" i], [id*="STRM" i]')]
      .map((el) => `${el.tagName}#${el.id} :: ${(el.textContent || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 70)}`)
      .slice(0, 30);
    return {
      heading: strip(document.querySelector('h1, [id*="PAGETITLE" i], [id*="PAGE_TITLE" i]')),
      idCount: document.querySelectorAll('[id]').length,
      strm: (document.documentElement.innerHTML.match(/STRM:"(\d+)"/) ?? [])[1] ?? null,
      outsideNavCollection: /bIsCalledOutsideNavigationCollection/.test(document.documentElement.innerHTML),
      notAuthorized: /not authorized for this page/i.test(document.body.textContent),
      termControls: [...new Set(termControls)],
      interesting: [...new Set(interesting)].slice(0, 100),
    };
  });
}

async function main() {
  const { browser, page } = await loginToPeopleSoft({ headless: true });
  try {
    // 1) Crear el navigation collection Fluid lanzando el START del tile.
    console.log('Creando el contexto Fluid (Manage Classes START)…');
    await page.goto(MANAGE_CLASSES_START_URL, { waitUntil: 'commit' });
    await page.waitForTimeout(6000);

    // 2) Entrar a la hoja View My Classes ya con el contexto creado.
    console.log('Abriendo View My Classes…');
    await page.goto(VIEW_MY_CLASSES_URL, { waitUntil: 'commit' });
    await page.waitForTimeout(6000);

    const frame = await dump(page, 'landing');
    const report = await inventory(frame);
    console.log(JSON.stringify(report, null, 2));

    if (report.outsideNavCollection) {
      console.log('\n⚠  La hoja salió fuera del navigation collection. El START no bastó para crear el contexto:');
      console.log('   probar entrar a View My Classes navegando por el tile en vez de por URL directa.');
      return;
    }

    // 3) View My Classes abre en un selector de ciclo tipo GRILLA ("Select a
    //    Value"): cada ciclo es una fila con un link SSR_ENTRMCUR_VW_TERM_DESCR30$N.
    //    Solo lista "Current Terms" (el actual y el próximo); no expone pasados.
    //    Hay que CLICKEAR el link del ciclo para abrir el horario real.
    const terms = await frame.evaluate(() =>
      [...document.querySelectorAll('a[id^="SSR_ENTRMCUR_VW_TERM_DESCR30$"]')]
        .filter((a) => /^SSR_ENTRMCUR_VW_TERM_DESCR30\$\d+$/.test(a.id))
        .map((a) => ({ id: a.id, label: a.textContent.replace(/\s+/g, ' ').trim() }))
    );

    if (!terms.length) {
      console.log('\nNo apareció el selector de ciclo (links de término). Revisar recon-my-classes-landing.html.');
      return;
    }
    console.log('\nCiclos disponibles en View My Classes:', JSON.stringify(terms, null, 2));

    // Por defecto el primero de la grilla (el ciclo actual). RECON_TERM elige otro
    // por etiqueta (ej. RECON_TERM="Septiembre de 2026").
    const wanted = process.env.RECON_TERM || null;
    const target = wanted ? terms.find((t) => t.label.includes(wanted)) : terms[0];
    if (!target) {
      console.log(`\nEl ciclo "${wanted}" no está en la grilla (esta pantalla solo trae ciclos actuales/próximos).`);
      return;
    }

    console.log(`\nAbriendo el horario de: ${target.label}`);
    await frame.locator(`a[id="${target.id}"]`).click();
    await page.waitForTimeout(7000);

    // El horario puede vivir en otro frame tras el click; re-buscamos el activo.
    const termFrame = (await findFrame(page, '[id="ICStateNum"]')) ?? page.mainFrame();
    await dump(page, 'term');
    console.log(JSON.stringify(await inventory(termFrame), null, 2));
    console.log('\nTip: RECON_TERM="Septiembre de 2026" npm run recon:my-classes para volcar el próximo ciclo.');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Recon falló:', err.message);
  process.exit(1);
});
