import { db, logSync } from '../db.js';
import { portalDateToISO } from './enrollmentWindows.js';
import {
  mapDropDeadlineLabel,
  numericDateToISO,
  resolveNumericDateOrder,
} from '../shared/dropDeadlines.ts';
import {
  MANAGE_CLASSES_START_URL,
  VIEW_MY_CLASSES_URL,
  ENROLLMENT_DEADLINES_LINK,
  ENROLLMENT_DEADLINES_PANEL,
  ENROLLMENT_DEADLINES_MODAL_FRAME,
} from './constants.js';

// Los plazos de baja POR CLASE, de la pantalla "Enrollment Deadlines".
//
// Este módulo se escribió a ciegas suponiendo que esa pantalla traía las etapas
// del ciclo que a enrollmentWindows.js le faltan (modificación, tardía, retiro,
// notas). El recon del 2026-09-03 contra la pantalla real desmintió la premisa
// entera, y por eso lo que hay acá hoy no se parece a lo que se planeó.
//
// Lo que la pantalla publica son TRES fechas de UNA clase:
//
//   Drop - Delete Record   hasta acá la baja borra la clase de tu récord
//   Drop - Retain Record   hasta acá queda con estado 'dropped'
//   Drop with Penalty      desde acá la baja lleva penalidad
//
// Nada de eso es una etapa del ciclo, y forzarlo habría sido caro: mapear
// "Drop with Penalty" (5 de septiembre en la captura) a retiro-parcial habría
// cerrado el botón de dar de baja dos meses antes del plazo institucional real
// (6 de noviembre). Un control apagado por una fecha mal traducida es el peor
// resultado posible de este scraper.
//
// Así que estas fechas NO alimentan term_events. Viven en class_drop_deadlines,
// por clase y por sesión, y contestan lo único que el calendario institucional
// no puede: si la doy de baja hoy, ¿queda en mi récord?
//
// Se llega por el enlace "Enrollment Deadlines" de View My Classes, uno por
// clase inscrita. Ese enlace no navega: dispara submitAction y PeopleSoft abre
// un modal Fluid cuyo contenido vive en un iframe aparte (ptModFrame_N).
//
// Confirmado contra fixtures/recon-enrollment-deadlines.html, capturada de una
// sesión real y saneada.

/**
 * Extrae los pares etiqueta/fecha que muestre la pantalla de plazos.
 *
 * Corre dentro del browser vía evaluate(), así que no puede cerrar sobre nada
 * del módulo: todo lo que necesita va acá adentro.
 *
 * No busca etiquetas conocidas: recorre las dos gramáticas de PeopleSoft (la
 * grilla clásica PSLEVEL1GRID y las cajas Fluid ps_box-edit) y devuelve TODA
 * pareja cuyo valor tenga forma de fecha, con su etiqueta literal. Es
 * deliberado: no sabemos qué plazos publica PUCMM, y un extractor que solo
 * reconoce lo que ya esperábamos vuelve invisible lo que no esperábamos. Filtrar
 * por forma de fecha es lo que deja fuera aula, profesor y horario sin tener que
 * saber sus nombres, y decidir qué significa cada etiqueta es trabajo de node,
 * donde se puede reportar lo que no se entendió.
 */
export function extractEnrollmentDeadlines() {
  const clean = (value) => (value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const strip = (el) => (el ? clean(el.textContent) : '');
  // Las cuatro formas en que un portal PeopleSoft en español o en inglés
  // escribe un día. La numérica entra a propósito aunque sea ambigua: se
  // reporta como ilegible en node, que es más honesto que descartarla en
  // silencio o que adivinar si 03/09 es marzo o septiembre.
  const looksLikeDate = (value) =>
    /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{3,}\s+\d{1,2},\s*\d{4}$/.test(value) ||
    /^\d{1,2}\s+de\s+[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{3,}\s+de\s+\d{4}$/.test(value) ||
    /^\d{4}-\d{2}-\d{2}$/.test(value) ||
    /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(value);

  const pairs = [];
  const seen = new Set();
  const add = (label, value, shape) => {
    const cleanLabel = clean(label);
    const cleanValue = clean(value);
    // Un valor largo es un párrafo de la pantalla, no el dato de una etiqueta.
    if (!cleanLabel || !cleanValue || cleanValue.length > 120) return;
    // En la grilla de una fila por plazo, la celda de la etiqueta se aparea
    // consigo misma. No es un dato: es la etiqueta mirándose al espejo.
    if (cleanLabel === cleanValue) return;
    const key = `${shape}|${cleanLabel}|${cleanValue}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ label: cleanLabel, value: cleanValue, shape, isDate: looksLikeDate(cleanValue) });
  };

  // Una cabecera que solo dice "Fecha" no nombra el plazo: en esa grilla la
  // etiqueta real es la primera celda de la fila.
  const generic = /^(date|fecha|deadline|plazo|value|valor|status|estado)$/i;

  // 1. Grilla clásica. Dos formas conviven: una columna por plazo (la etiqueta
  //    está en el <th>) y una fila por plazo (la etiqueta está en la primera
  //    celda). Se resuelven las dos sin saber de antemano cuál es.
  for (const table of document.querySelectorAll('table.PSLEVEL1GRID')) {
    const headers = [...table.querySelectorAll('th')].map((th) => strip(th));
    for (const row of table.querySelectorAll('tr')) {
      const cells = [...row.children].filter((cell) => cell.tagName === 'TD').map((cell) => strip(cell));
      if (!cells.length) continue;
      const rowLabel = cells.find((cell) => cell && !looksLikeDate(cell)) ?? '';
      cells.forEach((value, index) => {
        const header = headers[index] ?? '';
        const label = header && !generic.test(header) ? header : rowLabel || header;
        add(label, value, 'grid');
      });
    }
  }

  // 2. Cajas Fluid: <div class="ps_box-edit"><div class="ps_box-label"><span
  //    class="ps-label">…</span></div><span class="ps_box-value">…</span></div>.
  for (const value of document.querySelectorAll('.ps_box-value')) {
    const box = value.closest('.ps_box-edit') ?? value.parentElement;
    add(box ? strip(box.querySelector('.ps-label')) : '', strip(value), 'fluid');
  }

  // La sesión se toma solo de una etiqueta que se llame así y nada más:
  // "Session Begins On" nombra un plazo, no la sesión, y tomarla de ahí
  // guardaría los plazos bajo una sesión que no existe.
  const session = pairs.find((pair) => !pair.isDate && /^(session|sesi[oó]n)( name| de clase)?$/i.test(pair.label))?.value ?? null;

  // De qué clase son estos plazos. El modal lo dice en dos lugares: el NRC en
  // "Full Class Specifications" ("Class 5225") y el código de materia en el
  // encabezado. Sin el NRC no se puede guardar la fila, porque los plazos son
  // por clase y dos clases distintas se pisarían.
  const classSpecs = strip(document.getElementById('DERIVED_SSR_FL_SSR_CLASS_SPECS'));
  const classNbr = (classSpecs.match(/(\d{3,6})/) ?? [])[1] ?? null;
  const heading = [...document.querySelectorAll('.ps_box-value, .ps-text, h1, h2')]
    .map(strip)
    .find((text) => /^[A-Z]{2,5}\s+[A-Z]{2,5}\d{2,4}\b/.test(text)) ?? null;

  return {
    // Mismo truco que enrollmentWindows: el STRM viaja en el estado de la
    // página, no en una celda visible. En este modal no está, así que el ciclo
    // lo aporta quien llama.
    termCode: (document.documentElement.innerHTML.match(/STRM:"(\d+)"/) ?? [])[1] ?? null,
    classNbr,
    classLabel: heading,
    session,
    title: clean(document.title),
    rows: pairs.filter((pair) => pair.isDate).map(({ label, value, shape }) => ({ label, value, shape })),
    // Lo que la pantalla mostró y no tenía forma de fecha. No se guarda nada de
    // esto: viaja para que un recon futuro pueda mirar qué se dejó afuera.
    ignoredPairs: pairs.filter((pair) => !pair.isDate).length,
  };
}

// ── De la pantalla a los plazos de baja de una clase ────────────────────────

/**
 * Convierte lo extraído en los plazos de baja de UNA clase, más el reporte de
 * lo que no se pudo interpretar.
 *
 * No toca la base ni el reloj: se prueba con un objeto en la mano.
 *
 * El orden de las fechas numéricas se resuelve con el conjunto entero (ver
 * shared/dropDeadlines.ts) en vez de asumir una configuración regional. Si las
 * dos lecturas siguen siendo posibles, las fechas se reportan ilegibles: una
 * fecha equivocada acá le diría al estudiante que su baja no deja rastro
 * cuando sí lo deja.
 */
export function parseEnrollmentDeadlines(raw, { classNbr = null } = {}) {
  const rows = raw.rows ?? [];
  const order = resolveNumericDateOrder(rows.map((row) => row.value));
  const unmapped = [];
  const unreadable = [];
  const found = new Map();

  for (const row of rows) {
    const id = mapDropDeadlineLabel(row.label);
    if (!id) {
      unmapped.push({ label: row.label, value: row.value });
      continue;
    }
    const iso = /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(row.value.trim())
      ? order && numericDateToISO(row.value, order)
      : safeISO(row.value);
    if (!iso) {
      unreadable.push({
        label: row.label,
        value: row.value,
        error: order
          ? 'no se pudo leer la fecha'
          : 'fecha numérica ambigua: ninguna de las tres resuelve si es día/mes o mes/día',
      });
      continue;
    }
    found.set(id, iso);
  }

  const deadlines = {
    classNbr: classNbr ?? raw.classNbr ?? null,
    session: raw.session || 'Regular Academic Session',
    deleteBy: found.get('delete-record') ?? null,
    retainBy: found.get('retain-record') ?? null,
    penaltyFrom: found.get('with-penalty') ?? null,
  };

  return { deadlines, unmapped, unreadable, title: raw.title ?? null };
}

// Las formas con mes escrito siguen aceptándose: la pantalla real usa la
// numérica, pero el portal cambia de idioma según la sesión y una fecha con el
// mes en letras nunca es ambigua.
function safeISO(value) {
  try {
    return portalDateToISO(value);
  } catch {
    return null;
  }
}

const upsertDropDeadlines = db.prepare(`
  INSERT INTO class_drop_deadlines
    (user_id, term_code, class_nbr, session, delete_by, retain_by, penalty_from, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(user_id, term_code, class_nbr) DO UPDATE SET
    session = excluded.session,
    delete_by = excluded.delete_by,
    retain_by = excluded.retain_by,
    penalty_from = excluded.penalty_from,
    updated_at = datetime('now')
`);

/**
 * Guarda los plazos de una clase. Sin NRC no se guarda: la fila se identifica
 * por la clase, y una sin identificar se pisaría con la siguiente.
 */
export function saveClassDropDeadlines(userId, termCode, deadlines) {
  if (!deadlines.classNbr) throw new Error('Los plazos de baja necesitan el NRC de la clase');
  upsertDropDeadlines.run(
    userId,
    termCode,
    deadlines.classNbr,
    deadlines.session,
    deadlines.deleteBy,
    deadlines.retainBy,
    deadlines.penaltyFrom
  );
  return deadlines;
}

export function readClassDropDeadlines(userId, termCode) {
  return db
    .prepare(
      `SELECT class_nbr AS classNbr, session, delete_by AS deleteBy, retain_by AS retainBy,
              penalty_from AS penaltyFrom, updated_at AS updatedAt
       FROM class_drop_deadlines WHERE user_id = ? AND term_code = ? ORDER BY class_nbr`
    )
    .all(userId, termCode);
}

// El iframe del modal aparece después del submitAction y su nombre lleva el
// índice de la materia (ptModFrame_0 para la primera clase de la lista).
async function waitForModalFrame(page, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const frame = page.frames().find((f) => ENROLLMENT_DEADLINES_MODAL_FRAME.test(f.name()));
    if (frame) return frame;
    await page.waitForTimeout(300);
  }
  return null;
}

async function findFrame(page, selector, timeout = 12_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    for (const frame of page.frames()) {
      try {
        if ((await frame.locator(selector).count()) > 0) return frame;
      } catch {
        // frame desprendido durante submitAction
      }
    }
    await page.waitForTimeout(300);
  }
  return null;
}

/**
 * Trae los plazos por clase del ciclo que el portal tenga seleccionado y los
 * guarda en term_events.
 *
 * Misma forma que syncEnrollmentWindows: recibe la página ya autenticada y
 * reporta cada paso. Devuelve lo parseado completo (eventos guardados más lo que
 * no se entendió), porque el reporte es la mitad del valor de este scraper: lo
 * que quedó sin mapear es exactamente la lista de etiquetas que hay que agregar
 * a DEADLINE_RULES cuando se capture el fixture.
 *
 * El ciclo lo decide el portal, no este scraper: se lee el STRM de la pantalla y
 * se verifica contra el pedido. Elegir otro ciclo en el selector de View My
 * Classes no está implementado, porque no hay fixture con el que confirmar el
 * control.
 */
export async function syncEnrollmentDeadlines(page, { userId, term, onStep = () => {} }) {
  if (!term) throw new Error('Los plazos de baja son por ciclo: hace falta el STRM');
  const leidos = [];
  const problemas = [];
  try {
    onStep('abriendo View My Classes…');
    // El START del tile crea el navigation collection: abrir la hoja Fluid
    // directa en una sesión fresca tira bIsCalledOutsideNavigationCollection.
    await page.goto(MANAGE_CLASSES_START_URL, { waitUntil: 'commit' });
    await page.waitForTimeout(6_000);
    await page.goto(VIEW_MY_CLASSES_URL, { waitUntil: 'commit' });
    await page.waitForTimeout(6_000);

    const listado = await findFrame(page, ENROLLMENT_DEADLINES_LINK);
    if (!listado) {
      throw new Error(
        'View My Classes no mostró el enlace Enrollment Deadlines: sin materias inscritas en el ciclo, el portal no publica plazos por clase'
      );
    }
    // Hay un enlace por clase inscrita, no uno por ciclo. Confirmado con el
    // recon: cuatro materias, cuatro enlaces.
    const total = await listado.locator(ENROLLMENT_DEADLINES_LINK).count();

    for (let i = 0; i < total; i += 1) {
      onStep(`leyendo los plazos de la clase ${i + 1} de ${total}…`);
      // Se recarga la lista antes de cada clase en vez de cerrar el modal: el
      // botón de cierre es otro selector sin confirmar, y una recarga es lenta
      // pero no puede dejar la página en un estado a medias.
      if (i > 0) {
        await page.goto(VIEW_MY_CLASSES_URL, { waitUntil: 'commit' });
        await page.waitForTimeout(6_000);
      }
      const frame = await findFrame(page, ENROLLMENT_DEADLINES_LINK);
      if (!frame) break;
      await frame.locator(ENROLLMENT_DEADLINES_LINK).nth(i).click();

      // El enlace dispara submitAction y PeopleSoft inserta un modal Fluid cuyo
      // contenido vive en un IFRAME aparte (ptModFrame_N). El frame del enlace
      // no cambia, así que buscar el panel ahí adentro leía la pantalla vieja.
      const modal = await waitForModalFrame(page, 25_000);
      if (!modal) {
        problemas.push({ index: i, error: 'el modal de plazos no abrió' });
        continue;
      }
      // El iframe existe antes que su contenido, que llega por AJAX.
      await modal.waitForSelector(ENROLLMENT_DEADLINES_PANEL, { timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(1_500);

      const raw = await modal.evaluate(extractEnrollmentDeadlines);
      const parsed = parseEnrollmentDeadlines(raw);
      for (const row of parsed.unmapped) {
        console.warn(`Plazo sin mapear: "${row.label}" = ${row.value}`);
      }
      for (const row of parsed.unreadable) {
        console.warn(`Plazo ilegible: "${row.label}" = ${row.value} (${row.error})`);
      }
      if (!parsed.deadlines.classNbr) {
        problemas.push({ index: i, error: 'el modal no dijo de qué clase eran los plazos' });
        continue;
      }
      const alguna = parsed.deadlines.deleteBy || parsed.deadlines.retainBy || parsed.deadlines.penaltyFrom;
      if (!alguna) {
        problemas.push({ index: i, classNbr: parsed.deadlines.classNbr, error: 'ninguna fecha legible' });
        continue;
      }
      saveClassDropDeadlines(userId, term, parsed.deadlines);
      leidos.push({ ...parsed.deadlines, classLabel: raw.classLabel ?? null });
    }

    if (!leidos.length) {
      throw new Error(
        `Ninguna de las ${total} clase(s) publicó plazos legibles${problemas.length ? `: ${problemas[0].error}` : ''}`
      );
    }
    logSync({ userId, kind: 'enrollmentDeadlines', term, status: 'ok', rows: leidos.length });
    return { term, classes: leidos, problemas };
  } catch (error) {
    logSync({ userId, kind: 'enrollmentDeadlines', term, status: 'error', detail: error.message });
    throw error;
  }
}
