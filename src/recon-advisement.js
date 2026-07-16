import { loginToPeopleSoft } from './login.js';
import fs from 'node:fs/promises';

// Recon de My Academics → informe de orientación académica (el "Reporte
// Orientación Académica" que PeopleSoft genera con BI Publisher). Si esta
// pantalla existe para el estudiante, el pensum y el avance salen del portal
// y no hay que mantener a mano ninguna lista de materias: cuando la PUCMM
// cambie el plan, el próximo sync lo trae solo.
//
// Solo navega y vuelca. No pide reportes pesados ni toca nada.
const MY_ACAD_URL =
  'https://micampus.pucmm.edu.do/psc/cs92pro/EMPLOYEE/SA/c/SA_LEARNER_SERVICES.SSS_MY_ACAD.GBL?Page=SSS_MY_ACAD&Action=U';

async function findFrame(page, selector, timeout = 12000) {
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

const { browser, page } = await loginToPeopleSoft({ headless: true });
try {
  await page.goto(MY_ACAD_URL, { waitUntil: 'commit' });
  await page.waitForTimeout(7000);

  const frame = await findFrame(page, 'a[href], input[type="submit"]');
  await fs.writeFile('screenshots/recon-myacad.html', await frame.content());
  await page.screenshot({ path: 'screenshots/recon-myacad.png', fullPage: true }).catch(() => {});

  const shape = await frame.evaluate(() => ({
    titulo: document.querySelector('#DERIVED_REGFRM1_SS_TRANSACT_TITLE, .PATRANSACTIONTITLE')?.textContent.trim(),
    // Qué caminos ofrece la pantalla: buscamos el que lleva al informe.
    links: [...document.querySelectorAll('a[id], a[href]')]
      .map((a) => ({ id: a.id, texto: a.textContent.replace(/\s+/g, ' ').trim() }))
      .filter((l) => l.texto && l.texto.length < 80),
    botones: [...document.querySelectorAll('input[type="button"], input[type="submit"], a.SSSBUTTON_CONFIRMLINK')].map(
      (b) => b.value || b.textContent.trim()
    ),
    cuerpo: document.body.textContent.replace(/\s+/g, ' ').trim().slice(0, 400),
  }));

  console.log('TÍTULO:', shape.titulo);
  console.log('\nBOTONES:', JSON.stringify(shape.botones));
  console.log('\nLINKS con pinta de informe/avance/pensum:');
  for (const l of shape.links) {
    if (/requis|advis|orient|report|avance|pensum|academ|grado|progres/i.test(l.texto + l.id)) {
      console.log('  ', (l.id || '(sin id)').padEnd(45), l.texto);
    }
  }
  console.log('\nCUERPO:', shape.cuerpo);

  // El informe de avance: el pensum con el estado de cada bloque.
  const link = frame.locator('[id="DERIVED_SSSACA2_SS_DEG_PROG_LINK"]');
  if ((await link.count()) === 0) throw new Error('No hay link al advisement report en esta cuenta');
  await link.first().click();
  await page.waitForTimeout(15000); // el informe se genera al vuelo, tarda

  const f2 = await findFrame(page, '[id="ICStateNum"]', 30000);
  await fs.writeFile('screenshots/recon-advisement.html', await f2.content());
  await page.screenshot({ path: 'screenshots/recon-advisement.png', fullPage: true }).catch(() => {});
  console.log('\n=== INFORME → screenshots/recon-advisement.html ===');

  const rep = await f2.evaluate(() => ({
    titulo: document.querySelector('#DERIVED_REGFRM1_SS_TRANSACT_TITLE, .PATRANSACTIONTITLE')?.textContent.trim(),
    // Los bloques del pensum (requisitos) y su estado satisfecho/no satisfecho.
    bloques: [...document.querySelectorAll('[id^="SAA_REQ_DESCR"], [id^="SAA_GRP_DESCR"], .PAGROUPDIVIDER')]
      .map((e) => e.textContent.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 25),
    // Cualquier celda que huela a código de materia.
    codigos: [...new Set([...document.body.textContent.matchAll(/\b\d?[A-Z]{2,4}\d{2,4}[A-Z]?\b/g)].map((m) => m[0]))].slice(0, 40),
    cuerpo: document.body.textContent.replace(/\s+/g, ' ').trim().slice(0, 700),
  }));
  console.log('TÍTULO:', rep.titulo);
  console.log('\nBLOQUES:', JSON.stringify(rep.bloques, null, 1));
  console.log('\nCÓDIGOS VISTOS:', rep.codigos.join(', '));
  console.log('\nCUERPO:', rep.cuerpo);
} finally {
  await browser.close();
}
