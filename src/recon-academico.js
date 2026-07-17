import { loginToPeopleSoft } from './login.js';
import fs from 'node:fs/promises';

// Recon de Fase 4: notas (Academic Records) y holds/pendientes (Centro del
// Alumnado). Solo navega y vuelca — no modifica nada del portal.
//
// Las dos pantallas se recorren en una sola sesión a propósito: cada login es
// un golpe al portal, y esto ya son varias cargas de página.
//
// Lo que este recon tiene que contestar antes de escribir un scraper:
//   - ¿Las notas vienen por término detrás de un selector, como Mi Horario?
//   - ¿El portal da el GPA (del término y acumulado) o hay que calcularlo?
//   - ¿Los holds traen severidad (bloquea inscripción vs informativo) o solo
//     texto? De eso depende si /holds puede pintar rojo con criterio.
const GRADES_URL =
  'https://micampus.pucmm.edu.do/psp/cs92pro/EMPLOYEE/SA/c/SA_LEARNER_SERVICES.SSR_SSENRL_GRADE.GBL?FolderPath=PORTAL_ROOT_OBJECT.CO_EMPLOYEE_SELF_SERVICE.HCCC_ENROLLMENT.HC_SSR_SSENRL_GRADE_GBL&IsFolder=false&IgnoreParamTempl=FolderPath%2cIsFolder';

const STUDENT_CENTER_URL =
  'https://micampus.pucmm.edu.do/psp/cs92pro/EMPLOYEE/SA/c/SA_LEARNER_SERVICES.SSS_STUDENT_CENTER.GBL?Page=SSS_STUDENT_CENTER&Action=U';

// Course History: el histórico completo de materias cursadas con nota. Ir por
// URL adivinada (SS_MY_CRSEHIST.GBL) devuelve "You are not authorized for this
// page": el acceso es por el dropdown de Academics del Student Center, que lo
// lista como opción 2050. Se navega desde ahí.
const MORE_ACADEMICS_SELECT = 'DERIVED_SSS_SCL_SSS_MORE_ACADEMICS';
const COURSE_HISTORY_OPTION = '2050';

// Cuál término leer en el recon de notas. El 0 es el término en curso y no
// tiene notas todavía; hay que bajar hasta uno ya cerrado.
const TERM_INDEX = Number(process.env.RECON_TERM_INDEX ?? 2);

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
  return null;
}

async function dump(page, name) {
  const frame = (await findFrame(page, '[id="ICStateNum"]')) ?? page.mainFrame();
  await fs.mkdir('screenshots', { recursive: true });
  await fs.writeFile(`screenshots/recon-${name}.html`, await frame.content());
  await page.screenshot({ path: `screenshots/recon-${name}.png`, fullPage: true }).catch(() => {});
  console.log(`  volcado → screenshots/recon-${name}.html`);
  return frame;
}

// Qué hay en la página, en crudo: ids con pinta de dato, tablas y texto.
async function shapeOf(frame) {
  return frame.evaluate(() => {
    const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
    const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
    return {
      titulo: clean(document.querySelector('#DERIVED_REGFRM1_SS_TRANSACT_TITLE, .PATRANSACTIONTITLE')?.textContent),
      // Los ids repetidos con $N son las filas de datos: agrupamos por prefijo
      // para ver la forma sin ahogarnos en 3000 ids.
      familias: Object.entries(
        ids.reduce((acc, id) => {
          const base = id.replace(/\$\d+$/, '$N').replace(/\$span\$\d+$/, '$span$N');
          if (base.endsWith('$N')) acc[base] = (acc[base] ?? 0) + 1;
          return acc;
        }, {})
      )
        .sort((a, b) => b[1] - a[1])
        .slice(0, 40),
      // Cualquier cosa que huela a GPA/índice/promedio, con su id.
      posiblesGPA: [...document.querySelectorAll('span[id], div[id], td[id]')]
        .filter((e) => /gpa|index|indice|promedio|average|cum/i.test(e.id))
        .map((e) => ({ id: e.id, texto: clean(e.textContent).slice(0, 60) }))
        .slice(0, 30),
      encabezadosTabla: [...document.querySelectorAll('th')].map((e) => clean(e.textContent)).filter(Boolean).slice(0, 30),
      cuerpo: clean(document.body.textContent).slice(0, 900),
    };
  });
}

const { browser, page } = await loginToPeopleSoft({ headless: true });
try {
  // ---------- 1. NOTAS ----------
  console.log('\n=== ACADEMIC RECORDS → Notas ===');
  await page.goto(GRADES_URL, { waitUntil: 'commit' });
  await page.waitForTimeout(7000);
  let frame = await dump(page, 'grades-landing');
  console.log(JSON.stringify(await shapeOf(frame), null, 1));

  // La pantalla NO abre en un selector de término: abre directo en el término
  // en curso. El selector está detrás del link "change term", y hace falta
  // porque el término en curso todavía no tiene notas — el fixture del parser
  // tiene que salir de un término ya calificado.
  const CHANGE_TERM_LINK = 'DERIVED_SSS_SCT_SSS_TERM_LINK';
  const linkFrame = await findFrame(page, `[id="${CHANGE_TERM_LINK}"]`, 5000);
  if (linkFrame) {
    await linkFrame.locator(`[id="${CHANGE_TERM_LINK}"]`).first().click();
    await page.waitForTimeout(7000);
    const termFrame = (await findFrame(page, 'input[name="SSR_DUMMY_RECV1$sels$0"]', 8000)) ?? page.mainFrame();
    await dump(page, 'grades-terms');

    const terms = await termFrame.evaluate(() =>
      [...document.querySelectorAll('input[name="SSR_DUMMY_RECV1$sels$0"]')].map((r, i) => ({
        i,
        value: r.value,
        // La etiqueta del término vive en la fila, no en el radio.
        texto: r.closest('tr')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 90),
      }))
    );
    console.log('\nTÉRMINOS OFRECIDOS:', JSON.stringify(terms, null, 1));

    const idx = Math.min(TERM_INDEX, terms.length - 1);
    await termFrame.locator('input[name="SSR_DUMMY_RECV1$sels$0"]').nth(idx).check();
    await termFrame.locator('[id="DERIVED_SSS_SCT_SSR_PB_GO"]').first().click();
    await page.waitForTimeout(8000);
    frame = await dump(page, 'grades-past');
    console.log(`\nFORMA DE LAS NOTAS (término "${terms[idx]?.texto}"):`);
    console.log(JSON.stringify(await shapeOf(frame), null, 1));
  } else {
    console.log('(no hay link de cambio de término)');
  }

  // ---------- 1b. COURSE HISTORY ----------
  // Si esta pantalla trae todas las materias cursadas con su nota, un sync de
  // notas es UNA carga en vez de una por término.
  console.log('\n\n=== COURSE HISTORY (vía dropdown del Student Center) ===');
  await page.goto(STUDENT_CENTER_URL, { waitUntil: 'commit' });
  await page.waitForTimeout(8000);
  const scFrame = await findFrame(page, `[id="${MORE_ACADEMICS_SELECT}"]`, 8000);
  if (scFrame) {
    await scFrame.locator(`[id="${MORE_ACADEMICS_SELECT}"]`).selectOption(COURSE_HISTORY_OPTION);
    // El dropdown no navega solo: hay un botón GO al lado.
    const go = scFrame.locator('[id^="DERIVED_SSS_SCL_SSS_GO"]').first();
    if ((await go.count()) > 0) await go.click();
    await page.waitForTimeout(9000);
    frame = await dump(page, 'course-history');
    console.log(JSON.stringify(await shapeOf(frame), null, 1));
  } else {
    console.log('(no se encontró el dropdown de Academics)');
  }

  // ---------- 2. HOLDS Y PENDIENTES ----------
  console.log('\n\n=== CENTRO DEL ALUMNADO → Holds / To-Do ===');
  await page.goto(STUDENT_CENTER_URL, { waitUntil: 'commit' });
  await page.waitForTimeout(8000);
  frame = await dump(page, 'student-center');

  const sc = await frame.evaluate(() => {
    const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
    return {
      titulo: clean(document.querySelector('#DERIVED_REGFRM1_SS_TRANSACT_TITLE, .PATRANSACTIONTITLE')?.textContent),
      // Los paneles laterales: Holds, To Do List, Milestones, Enrollment Dates.
      paneles: [...document.querySelectorAll('.PAGROUPDIVIDER, .SSSGROUPBOXLABEL, .PSGROUPBOXLABEL')]
        .map((e) => clean(e.textContent))
        .filter(Boolean),
      // Todo id que mencione hold/todo/service indicator.
      idsHold: [...document.querySelectorAll('[id]')]
        .map((e) => e.id)
        .filter((id) => /hold|todo|to_do|svc|service_ind|SI_/i.test(id))
        .slice(0, 60),
      textosHold: [...document.querySelectorAll('span[id], a[id], div[id]')]
        .filter((e) => /hold|todo|to_do|svc|service/i.test(e.id))
        .map((e) => ({ id: e.id, texto: clean(e.textContent).slice(0, 70) }))
        .filter((x) => x.texto)
        .slice(0, 40),
      cuerpo: clean(document.body.textContent).slice(0, 1200),
    };
  });
  console.log(JSON.stringify(sc, null, 1));

  // El detalle del hold es donde debería estar la severidad ("impide
  // inscripción"). Sin eso, /holds no puede pintar rojo con criterio.
  const detalle = await findFrame(page, '[id^="DERIVED_SSS_SCR_SSS_LINK_ANCHOR"]', 3000);
  if (detalle) {
    const links = await detalle.evaluate(() =>
      [...document.querySelectorAll('[id^="DERIVED_SSS_SCR_SSS_LINK_ANCHOR"]')].map((a) => ({
        id: a.id,
        texto: a.textContent.replace(/\s+/g, ' ').trim(),
      }))
    );
    console.log('\nLINKS "details" del Student Center:', JSON.stringify(links, null, 1));
  }
} finally {
  await browser.close();
}
