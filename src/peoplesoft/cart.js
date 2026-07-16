import { CART_URL, CONTENT_FRAME_NAME } from './constants.js';
import { db } from '../db.js';
import { cartRowSchema, normalizeSeatStatus } from '../shared/schemas.ts';
import { parseMeetings } from '../shared/meetings.ts';
import { splitCourseCode, courseCodeToString } from '../shared/courseCode.ts';
import { knownSubjects } from './browseCatalog.js';

function contentFrame(page) {
  return page.frame({ name: CONTENT_FRAME_NAME }) || page.mainFrame();
}

// Lee el carrito de inscripción. Recon en fixtures/recon-cart.html: cada fila
// trae, además del nombre ("FIS FIS139-101") y el ícono de estado, el horario
// (SSR_MTG_SCHED_LONG), aula, profesor, créditos y campus — suficiente para
// proyectar el carrito en el WeeklyGrid sin tocar ninguna otra pantalla.
//
// Se ejecuta dentro del browser vía evaluate(): no puede cerrar sobre nada del
// módulo. A cambio corre contra el fixture sin portal (scripts/test-cart-parser.mjs).
export function extractCartRows() {
  const strip = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

  // Las filas "atadas" (prácticos ligados a una clase, sin link propio) no
  // tienen <a id="P_CLASS_NAME$N">, solo un <span> deshabilitado dentro del
  // mismo div wrapper — por eso se itera sobre el wrapper, no el link, y se
  // tolera un hueco de índice sin cortar el loop de inmediato.
  const rows = [];
  let consecutiveMisses = 0;
  for (let i = 0; consecutiveMisses < 3; i++) {
    const wrapperEl = document.getElementById(`win0divP_CLASS_NAME$${i}`);
    if (!wrapperEl) {
      consecutiveMisses++;
      continue;
    }
    consecutiveMisses = 0;
    const byId = (prefix) => strip(document.getElementById(`${prefix}$${i}`));

    // La celda de horario puede traer varias reuniones separadas por <br>;
    // innerText conserva los saltos de línea (que parseMeetings usa para
    // separar), textContent los pierde.
    const schedEl = document.getElementById(`DERIVED_REGFRM1_SSR_MTG_SCHED_LONG$${i}`);

    // El estado del cupo vive en el ícono. El src es el dato confiable
    // (PS_CS_STATUS_OPEN_ICN_1.gif); el alt a veces viene vacío en otras
    // pantallas del portal, así que no se depende de él.
    const statusImg = document.querySelector(`[id="win0divDERIVED_REGFRM1_SSR_STATUS_LONG$${i}"] img`);
    const statusSrc = statusImg ? (statusImg.getAttribute('src') ?? '') : '';
    const statusMatch = statusSrc.match(/STATUS_(OPEN|CLOSED|WAITLIST)/i);

    rows.push({
      index: i,
      classLabel: strip(wrapperEl),
      dayTime: schedEl ? (schedEl.innerText ?? schedEl.textContent ?? '').trim() : '',
      room: byId('DERIVED_REGFRM1_SSR_MTG_LOC_LONG'),
      instructor: byId('DERIVED_REGFRM1_SSR_INSTR_LONG'),
      units: byId('SSR_REGFORM_VW_UNT_TAKEN'),
      campus: byId('CAMPUS_TBL_DESCR'),
      status: statusMatch ? statusMatch[1] : null,
    });
  }
  return rows;
}

// Completa lo extraído con lo que el carrito no dice pero la DB local sí: el
// código canónico (la llave del color estable y del cruce con el catálogo) y
// el título real del diccionario `courses`. Corre en node, con acceso a DB.
export function enrichCartRows(rawRows) {
  const subjects = knownSubjects();
  const titleStmt = db.prepare('SELECT title FROM courses WHERE code = ?');

  return rawRows.map((row) => {
    // "FIS FIS139-101 (3656)" → subject del grupo, código crudo, sección y
    // class number. El código canónico sale de la misma regla que catálogo y
    // horario (courseCode.ts); si el label no matchea, la fila igual se
    // muestra con su texto crudo.
    const m = row.classLabel.match(/^([A-Z]{2,4})\s+(\S+)-(\S+?)(?:\s*\((\d+)\))?$/);
    const code = m ? splitCourseCode(m[2], { subjectHint: m[1], knownSubjects: subjects }) : null;
    const courseCode = code ? courseCodeToString(code) : null;
    const title = (courseCode && titleStmt.get(courseCode)?.title) || courseCode || row.classLabel;

    return cartRowSchema.parse({
      index: row.index,
      classLabel: row.classLabel,
      courseCode,
      title,
      section: m ? m[3] : null,
      classNbr: m?.[4] ?? null,
      instructor: row.instructor || null,
      credits: row.units ? Number(row.units) : null,
      campus: row.campus || null,
      meetings: parseMeetings(row.dayTime, row.room),
      status: row.status ? normalizeSeatStatus(row.status) : null,
    });
  });
}

export async function getCartStatus(page) {
  await page.goto(CART_URL, { waitUntil: 'commit' });
  await page.waitForTimeout(5000);

  const frame = contentFrame(page);
  return enrichCartRows(await frame.evaluate(extractCartRows));
}
