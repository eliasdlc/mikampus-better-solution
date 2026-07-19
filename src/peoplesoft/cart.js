import { CART_URL, CONTENT_FRAME_NAME } from './constants.js';
import { db, logSync, lastSync } from '../db.js';
import { cartRowSchema, cartValidationResponseSchema, normalizeSeatStatus } from '../shared/schemas.ts';
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

// Capabilities del wizard, contra fixtures/recon-cart-phase85-step{1,2}.html.
// Es deliberadamente un parser separado de las filas: responde qué decisiones
// ofrece PeopleSoft, no qué estados pinta como leyenda.
export function extractCartCapabilities() {
  const controls = [...document.querySelectorAll('input, button, a')].map((el) => ({
    text: `${el.value ?? ''} ${el.textContent ?? ''} ${el.getAttribute('title') ?? ''}`.replace(/\s+/g, ' ').trim(),
    id: el.id ?? '',
    type: el.getAttribute('type') ?? '',
  }));
  const validate = controls.some((control) => /\bvalidate\b/i.test(control.text) || /VALIDATE/i.test(control.id));
  const waitlistChoice = controls.some(
    (control) =>
      /WAIT_LIST_OKAY|WAITLIST_OKAY|WAIT_LIST_CHOICE/i.test(control.id) ||
      (/wait\s*list/i.test(control.text) && /checkbox|radio/i.test(control.type))
  );
  const bodyText = document.body.textContent.replace(/\s+/g, ' ');
  const waitlistPosition = /wait\s*list\s*position|position\s*(?:on|in)\s*(?:the\s*)?wait/i.test(bodyText);
  return { validate, waitlistChoice, waitlistPosition };
}

export async function validateCart(page) {
  await page.goto(CART_URL, { waitUntil: 'commit' });
  await page.waitForTimeout(5_000);
  const frame = contentFrame(page);
  const capabilities = await frame.evaluate(extractCartCapabilities);

  // El recon es una conclusión de producto: esta instalación no expone el
  // Validate nativo prometido por el plan. Si aparece tras un parche, fallamos
  // explícitamente para capturar el nuevo flujo antes de clickear a ciegas.
  if (capabilities.validate) {
    throw new Error('PeopleSoft ahora muestra Validate; hace falta un recon del resultado antes de habilitarlo');
  }
  const unavailable =
    'El portal de PUCMM no ofrece Validate en el carrito ni en el paso de revisión; solo valida al someter la inscripción.';
  return cartValidationResponseSchema.parse({
    validatedAt: new Date().toISOString(),
    validate: { supported: false, reason: unavailable },
    waitlistChoice: {
      supported: capabilities.waitlistChoice,
      reason: capabilities.waitlistChoice
        ? null
        : 'El wizard no ofrece decidir waitlist por materia; conserva la política configurada por el portal.',
    },
    waitlistPosition: {
      supported: capabilities.waitlistPosition,
      reason: capabilities.waitlistPosition ? null : 'El carrito no publica una posición de lista de espera.',
    },
    results: [],
  });
}

// ── Cache ───────────────────────────────────────────────────────────────────
// Leer el carrito son ~10s de Playwright. Que eso pase al abrir una pantalla
// (el Dashboard lo muestra en cada carga) rompe el presupuesto del plan §6 y
// castiga al portal sin motivo, así que el carrito se cachea como el horario,
// las notas y los holds: el GET sirve disco y el refresh es explícito.

// El carrito del portal es un estado completo, no un incremento: se borra y se
// reescribe entero (solo el del usuario en cuestión). Guardarlo fila por fila
// dejaría en la DB materias que el usuario ya sacó del carrito en micampus.
export function saveCart(userId, rows) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM cart_rows WHERE user_id = ?').run(userId);
    const insert = db.prepare(
      `INSERT INTO cart_rows (user_id, idx, class_label, course_code, title, section, class_nbr,
                              instructor, credits, campus, meetings, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      insert.run(
        userId,
        row.index,
        row.classLabel,
        row.courseCode,
        row.title,
        row.section,
        row.classNbr,
        row.instructor,
        row.credits,
        row.campus,
        JSON.stringify(row.meetings ?? []),
        row.status
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  logSync({ userId, kind: 'cart', status: 'ok', detail: `${rows.length} materia(s)`, rows: rows.length });
  return rows.length;
}

export function readCart(userId) {
  const rows = db
    .prepare(
      `SELECT idx, class_label, course_code, title, section, class_nbr, instructor,
              credits, campus, meetings, status
       FROM cart_rows WHERE user_id = ? ORDER BY idx`
    )
    .all(userId)
    .map((r) =>
      cartRowSchema.parse({
        index: r.idx,
        classLabel: r.class_label,
        courseCode: r.course_code,
        title: r.title,
        section: r.section,
        classNbr: r.class_nbr,
        instructor: r.instructor,
        credits: r.credits,
        campus: r.campus,
        meetings: r.meetings ? JSON.parse(r.meetings) : [],
        status: r.status,
      })
    );

  return { generatedAt: new Date().toISOString(), syncedAt: lastSync('cart', { userId }), rows };
}

// La única lectura en vivo. La usa el refresh explícito de /inscripcion y cada
// tick del watcher, así que el cache queda fresco sin pedirle nada extra al
// portal. La página YA es la sesión de ese usuario; userId dice de quién es el
// cache que se escribe.
export async function syncCart(page, { userId }) {
  try {
    const rows = await getCartStatus(page);
    saveCart(userId, rows);
    return rows;
  } catch (err) {
    logSync({ userId, kind: 'cart', status: 'error', detail: err.message });
    throw err;
  }
}
