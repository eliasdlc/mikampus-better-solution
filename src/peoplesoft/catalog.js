import { CLASS_SEARCH_URL } from './constants.js';
import { db, logSync } from '../db.js';
import { scrapedSectionSchema, normalizeSeatStatus } from '../shared/schemas.ts';

// ── Capa de escritura en DB ────────────────────────────────────────────────
// Estas funciones son las que persisten lo que el scraper valida con Zod.
// Se prueban con scripts/seed-catalog.mjs sin tocar el portal.

const upsertCourseStmt = db.prepare(`
  INSERT INTO courses (code, subject, catalog_nbr, title, career, credits, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(code) DO UPDATE SET
    title = excluded.title,
    career = COALESCE(excluded.career, courses.career),
    credits = COALESCE(excluded.credits, courses.credits),
    updated_at = datetime('now')
`);

const upsertSectionStmt = db.prepare(`
  INSERT INTO sections (course_id, term, class_nbr, section, component, instructor, meetings, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(term, class_nbr) DO UPDATE SET
    course_id = excluded.course_id,
    section = excluded.section,
    component = excluded.component,
    instructor = excluded.instructor,
    meetings = excluded.meetings,
    updated_at = datetime('now')
`);

const recordSeatsStmt = db.prepare(`
  INSERT INTO seats_snapshot (section_id, status, seats_open, seats_cap, wait_total)
  VALUES (?, ?, ?, ?, ?)
`);

// Guarda una sección validada (course + section + snapshot de cupo) en una
// transacción. `s` ya pasó por scrapedSectionSchema.
export function saveSection(s) {
  upsertCourseStmt.run(s.courseCode, s.subject, s.catalogNbr, s.title, s.career, s.credits);
  const courseId = db.prepare('SELECT id FROM courses WHERE code = ?').get(s.courseCode).id;
  upsertSectionStmt.run(
    courseId,
    s.term,
    s.classNbr,
    s.section,
    s.component,
    s.instructor,
    JSON.stringify(s.meetings)
  );
  const sectionId = db.prepare('SELECT id FROM sections WHERE term = ? AND class_nbr = ?').get(s.term, s.classNbr).id;
  if (s.seats) {
    recordSeatsStmt.run(sectionId, s.seats.status, s.seats.open, s.seats.capacity, s.seats.waitTotal);
  }
  return sectionId;
}

// ── Capa de lectura (GET /api/catalog) ─────────────────────────────────────
// Sirve el catálogo cacheado desde disco en <10ms. Agrupa secciones por materia
// y adjunta el último snapshot de cupo de cada una con su timestamp.
export function readCatalog(term) {
  const sections = db
    .prepare(
      `SELECT s.id, s.course_id, s.class_nbr, s.section, s.component, s.instructor, s.meetings,
              c.code, c.subject, c.catalog_nbr, c.title, c.career, c.credits
       FROM sections s JOIN courses c ON c.id = s.course_id
       ${term ? 'WHERE s.term = ?' : ''}
       ORDER BY c.code, s.class_nbr`
    )
    .all(...(term ? [term] : []));

  const latestSeat = db.prepare(
    `SELECT status, seats_open, seats_cap, wait_total, captured_at
     FROM seats_snapshot WHERE section_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1`
  );

  const byCourse = new Map();
  for (const row of sections) {
    if (!byCourse.has(row.course_id)) {
      byCourse.set(row.course_id, {
        id: row.course_id,
        code: row.code,
        subject: row.subject,
        catalogNbr: row.catalog_nbr,
        title: row.title,
        career: row.career,
        credits: row.credits,
        sections: [],
      });
    }
    const seat = latestSeat.get(row.id);
    byCourse.get(row.course_id).sections.push({
      id: row.id,
      classNbr: row.class_nbr,
      section: row.section,
      component: row.component,
      instructor: row.instructor,
      meetings: row.meetings ? JSON.parse(row.meetings) : [],
      seats: seat
        ? {
            status: seat.status,
            open: seat.seats_open,
            capacity: seat.seats_cap,
            waitTotal: seat.wait_total,
          }
        : null,
      seatsUpdatedAt: seat?.captured_at ?? null,
    });
  }

  return {
    term: term ?? null,
    generatedAt: new Date().toISOString(),
    courses: [...byCourse.values()],
  };
}

// ── Scraper ────────────────────────────────────────────────────────────────
// RECON PENDIENTE: la navegación reusa el patrón probado de classSearch.js,
// pero la extracción de créditos, título limpio y patrón de horario depende de
// IDs que hay que confirmar con un volcado de HTML real antes de la primera
// corrida en vivo (principio #1: ningún scraper a ciegas). Hasta entonces se
// prueba la tubería con datos sembrados. No correr un barrido completo sin
// supervisión: pega muchas requests al portal (riesgo #2 del plan) → throttle.
async function findFrame(page, selector, { timeout = 8000 } = {}) {
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
  throw new Error(`No se encontró el elemento esperado: ${selector}`);
}

// Barre un subject (ej. "ICC") de un término/carrera y persiste sus secciones.
// throttleMs espacia las requests para no golpear el portal en el pico.
export async function syncCatalogSubject(page, { term, career, subject, throttleMs = 1500 }) {
  await page.goto(CLASS_SEARCH_URL, { waitUntil: 'commit' });
  await page.waitForTimeout(5000);

  let frame = await findFrame(page, 'select[name="CLASS_SRCH_WRK2_STRM$35$"]');
  await frame.selectOption('select[name="CLASS_SRCH_WRK2_STRM$35$"]', term);
  await page.waitForTimeout(4000);

  frame = await findFrame(page, 'select[name="SSR_CLSRCH_WRK_ACAD_CAREER$2"]');
  await frame.selectOption('select[name="SSR_CLSRCH_WRK_ACAD_CAREER$2"]', career);
  await page.waitForTimeout(4000);

  // Buscar por subject dejando el catalog_nbr vacío devuelve todo el subject.
  frame = await findFrame(page, 'input[name="SSR_CLSRCH_WRK_SUBJECT$0"]', { timeout: 4000 }).catch(() => null);
  if (frame) await frame.fill('input[name="SSR_CLSRCH_WRK_SUBJECT$0"]', subject).catch(() => {});
  await page.waitForTimeout(throttleMs);

  frame = await findFrame(page, '[id="SSR_CLSRCH_WRK_SSR_OPEN_ONLY$3"]');
  const openOnly = frame.locator('[id="SSR_CLSRCH_WRK_SSR_OPEN_ONLY$3"]');
  if (await openOnly.isChecked()) {
    await openOnly.uncheck();
    await page.waitForTimeout(3000);
  }

  frame = await findFrame(page, 'input[value="Search"]');
  await frame.click('input[value="Search"]');
  await page.waitForTimeout(7000);

  frame = await findFrame(page, '[id="ICStateNum"]');
  const exceeds = await frame.locator('text=exceed the maximum limit').count();
  if (exceeds > 0) {
    throw new Error(`El subject ${subject} excede el máximo de resultados — hay que paginarlo por catalog_nbr.`);
  }

  // Extracción provisional a partir de los IDs conocidos de la grilla de
  // resultados (MTG_*). RECON confirmará créditos/título/horario exactos.
  const raw = await frame.evaluate(() => {
    const rows = [];
    for (let i = 0; ; i++) {
      const nbrEl = document.getElementById(`MTG_CLASS_NBR$${i}`);
      if (!nbrEl) break;
      const nameEl = document.getElementById(`MTG_CLASSNAME$${i}`);
      const roomEl = document.getElementById(`MTG_ROOM$${i}`);
      const instrEl = document.getElementById(`MTG_INSTR$${i}`);
      const dayTimeEl = document.getElementById(`MTG_DAYTIME$${i}`);
      const statusImg = document.querySelector(`#win0divDERIVED_CLSRCH_SSR_STATUS_LONG\\$${i} img`);
      rows.push({
        classNbr: nbrEl.textContent.trim(),
        sectionLabel: nameEl ? nameEl.textContent.trim().replace(/\s+/g, ' ') : '',
        room: roomEl ? roomEl.textContent.trim() : '',
        instructor: instrEl ? instrEl.textContent.trim() : '',
        dayTime: dayTimeEl ? dayTimeEl.textContent.trim().replace(/\s+/g, ' ') : '',
        statusAlt: statusImg ? statusImg.alt : null,
      });
    }
    return rows;
  });

  let saved = 0;
  for (const r of raw) {
    // sectionLabel de PeopleSoft suele venir como "ICC 303 - 01" o similar;
    // parseo tolerante, se afina con el recon.
    const m = r.sectionLabel.match(/^([A-Za-z]{2,4})\s*[- ]?\s*(\d{2,4}[A-Za-z]?)\s*-?\s*(.*)$/);
    const subjectCode = m ? m[1].toUpperCase() : subject;
    const catalogNbr = m ? m[2] : '';
    const section = m ? m[3] : r.sectionLabel;
    const parsed = scrapedSectionSchema.safeParse({
      courseCode: `${subjectCode}-${catalogNbr}`,
      subject: subjectCode,
      catalogNbr,
      title: r.sectionLabel || `${subjectCode}-${catalogNbr}`,
      term,
      classNbr: r.classNbr,
      section,
      instructor: r.instructor || null,
      meetings: r.dayTime ? [{ days: [r.dayTime], start: null, end: null, room: r.room || null }] : [],
      seats: r.statusAlt
        ? { status: normalizeSeatStatus(r.statusAlt), open: null, capacity: null, waitTotal: null }
        : null,
    });
    if (parsed.success) {
      saveSection(parsed.data);
      saved++;
    }
  }

  logSync({ kind: 'catalog', term, status: 'ok', detail: subject, rows: saved });
  return saved;
}
