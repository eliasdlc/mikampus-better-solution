import { CLASS_SEARCH_URL } from './constants.js';

// PeopleSoft no siempre pone el contenido en un frame llamado "TargetContent":
// a veces lo renderiza directo en el frame principal, dependiendo de cómo se
// llegó a la página. En vez de asumir un nombre fijo, se busca en todos los
// frames actuales cuál contiene realmente el selector que se necesita.
async function findFrame(page, selector, { timeout = 8000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const frame of page.frames()) {
      try {
        if ((await frame.locator(selector).count()) > 0) return frame;
      } catch {
        // el frame se pudo haber desprendido a mitad de un redibujado (AJAX);
        // se ignora y se reintenta en la siguiente vuelta
      }
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`No se encontró el elemento esperado en la página: ${selector}`);
}

export async function getSearchFormOptions(page) {
  await page.goto(CLASS_SEARCH_URL, { waitUntil: 'commit' });
  await page.waitForTimeout(5000);

  const frame = await findFrame(page, 'select[name="CLASS_SRCH_WRK2_STRM$35$"]');
  return frame.evaluate(() => {
    function opts(selector) {
      const el = document.querySelector(selector);
      if (!el) return [];
      return Array.from(el.options)
        .filter((o) => o.value)
        .map((o) => ({ value: o.value, label: o.textContent.trim() }));
    }
    return {
      terms: opts('select[name="CLASS_SRCH_WRK2_STRM$35$"]'),
      careers: opts('select[name="SSR_CLSRCH_WRK_ACAD_CAREER$2"]'),
    };
  });
}

export async function searchClasses(page, { term, career, courseNumber }) {
  await page.goto(CLASS_SEARCH_URL, { waitUntil: 'commit' });
  await page.waitForTimeout(5000);

  let frame = await findFrame(page, 'select[name="CLASS_SRCH_WRK2_STRM$35$"]');
  await frame.selectOption('select[name="CLASS_SRCH_WRK2_STRM$35$"]', term);
  await page.waitForTimeout(4000);

  frame = await findFrame(page, 'select[name="SSR_CLSRCH_WRK_ACAD_CAREER$2"]');
  await frame.selectOption('select[name="SSR_CLSRCH_WRK_ACAD_CAREER$2"]', career);
  await page.waitForTimeout(4000);

  frame = await findFrame(page, 'input[name="SSR_CLSRCH_WRK_CATALOG_NBR$1"]');
  await frame.fill('input[name="SSR_CLSRCH_WRK_CATALOG_NBR$1"]', courseNumber);
  await page.waitForTimeout(1500);

  // Sin esto, PeopleSoft solo muestra secciones con cupo — para el buscador
  // queremos ver también las llenas, ya que igual se pueden meter al carrito
  // para que el watcher las vigile.
  frame = await findFrame(page, '[id="SSR_CLSRCH_WRK_SSR_OPEN_ONLY$3"]');
  const openOnly = frame.locator('[id="SSR_CLSRCH_WRK_SSR_OPEN_ONLY$3"]');
  if (await openOnly.isChecked()) {
    await openOnly.uncheck();
    await page.waitForTimeout(4000);
  }

  frame = await findFrame(page, 'input[value="Search"]');
  await frame.click('input[value="Search"]');
  await page.waitForTimeout(7000);

  frame = await findFrame(page, '[id="ICStateNum"]');
  const noResults = await frame.locator('text=no results that match').count();
  if (noResults > 0) return [];

  const exceedsLimit = await frame.locator('text=exceed the maximum limit').count();
  if (exceedsLimit > 0) {
    throw new Error('Demasiados resultados — especificá un código de materia más exacto.');
  }

  return frame.evaluate(() => {
    const rows = [];
    for (let i = 0; ; i++) {
      const nbrEl = document.getElementById(`MTG_CLASS_NBR$${i}`);
      if (!nbrEl) break;
      const nameEl = document.getElementById(`MTG_CLASSNAME$${i}`);
      const roomEl = document.getElementById(`MTG_ROOM$${i}`);
      const instrEl = document.getElementById(`MTG_INSTR$${i}`);
      const statusImg = document.querySelector(
        `#win0divDERIVED_CLSRCH_SSR_STATUS_LONG\\$${i} img`
      );
      const selectBtn = document.querySelector(`input[name="SSR_PB_SELECT\\$${i}"]`);
      rows.push({
        index: i,
        classNbr: nbrEl.textContent.trim(),
        section: nameEl ? nameEl.textContent.trim().replace(/\s+/g, ' ') : '',
        room: roomEl ? roomEl.textContent.trim() : '',
        instructor: instrEl ? instrEl.textContent.trim() : '',
        status: statusImg ? statusImg.alt : null,
        inCart: !selectBtn,
      });
    }
    return rows;
  });
}

// PeopleSoft intercala pasos variables entre "Select" y que la clase quede
// realmente en el carrito (sección relacionada obligatoria, preferencias de
// inscripción) según la materia. En vez de mapear cada combinación posible,
// se hace click en "Select" y después en cada "Next" que vaya apareciendo,
// marcando la primera opción disponible si el paso pide elegir una sección,
// hasta que no quede ningún "Next" — eso indica que ya se agregó.
export async function addClassToCart(page, index) {
  let frame = await findFrame(page, `input[name="SSR_PB_SELECT$${index}"]`);
  await frame.click(`input[name="SSR_PB_SELECT$${index}"]`);
  await page.waitForTimeout(5000);

  for (let step = 0; step < 5; step++) {
    frame = await findFrame(page, '[id="ICStateNum"]');

    const radios = frame.locator('input.PSRADIOBUTTON[type="radio"]');
    if ((await radios.count()) > 0) {
      const anyChecked = await frame.locator('input.PSRADIOBUTTON[type="radio"]:checked').count();
      if (anyChecked === 0) {
        await radios.first().check();
        await page.waitForTimeout(1000);
      }
    }

    const nextBtn = frame.locator('input[value="Next"]');
    if ((await nextBtn.count()) === 0) break;
    await nextBtn.click();
    await page.waitForTimeout(5000);
  }
}
