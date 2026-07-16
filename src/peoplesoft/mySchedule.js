import { SCHEDULE_URL } from './constants.js';
import { db, logSync, lastSync } from '../db.js';
import { saveSection } from './catalog.js';
import {
  scrapedScheduleSchema,
  scrapedSectionSchema,
  normalizeEnrollStatus,
} from '../shared/schemas.ts';
import { parseMeetings, normalizeComponent, parseDateRange } from '../shared/meetings.ts';

// Horario inscrito. Recon en fixtures/recon-schedule-list.html (ver
// src/recon-schedule.js). Lo que confirmó, y que manda en el diseño de acá:
//
//   1. La pantalla abre en "Weekly Calendar View" (una grilla ya pintada por
//      PeopleSoft, incómoda de parsear). Hay que pedir "List View", que da las
//      mismas clases como filas con class nbr, sección, días/horas y profesor.
//   2. Cada materia inscrita es un contenedor ACE_STDNT_ENRL_SSV2$N con su
//      título en un .PAGROUPDIVIDER ("ICC     ICC233 - Seg. en Tecnología
//      Información") y adentro su grilla de componentes.
//   3. A diferencia del class search, ACÁ SÍ vienen el título y los créditos.
//      Por eso esta pantalla es la que llena el diccionario `courses`.
//   4. El índice de las filas de componente es global a la página, no por
//      materia → agrupar por contención, nunca por índice.

// ── Capa de escritura ──────────────────────────────────────────────────────

const upsertEnrollmentStmt = db.prepare(`
  INSERT INTO enrollments (term, course_id, section_id, status, units, grading, grade, start_date, end_date, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(term, section_id) DO UPDATE SET
    status = excluded.status,
    units = excluded.units,
    grading = excluded.grading,
    grade = excluded.grade,
    start_date = excluded.start_date,
    end_date = excluded.end_date,
    updated_at = datetime('now')
`);

// Persiste el horario de un término. Borra las inscripciones previas de ese
// término antes de reinsertar: si diste de baja una materia, un upsert solo la
// dejaría para siempre en tu horario. Va en transacción para que el horario
// nunca se lea a medio reemplazar.
export function saveSchedule({ term, courses }) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM enrollments WHERE term = ?').run(term);

    let saved = 0;
    for (const course of courses) {
      for (const s of course.sections) {
        const sectionId = saveSection(
          scrapedSectionSchema.parse({
            courseCode: course.courseCode,
            subject: course.subject,
            catalogNbr: course.catalogNbr,
            title: course.title,
            // Los créditos son de la materia; el class search no los da.
            credits: course.units,
            term,
            classNbr: s.classNbr,
            section: s.section,
            component: s.component,
            instructor: s.instructor,
            meetings: s.meetings,
          })
        );
        const courseId = db.prepare('SELECT course_id FROM sections WHERE id = ?').get(sectionId).course_id;
        upsertEnrollmentStmt.run(
          term,
          courseId,
          sectionId,
          course.status,
          course.units,
          course.grading,
          course.grade,
          s.startDate,
          s.endDate
        );
        saved++;
      }
    }
    db.exec('COMMIT');
    return saved;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ── Capa de lectura (GET /api/schedule) ────────────────────────────────────

// El término del horario que se sincronizó más recientemente. Sirve para que
// /horario funcione sin configurar nada: PeopleSoft ya sabe cuál es tu término
// activo, así que el primer sync lo descubre y desde ahí es el default.
export function latestScheduledTerm() {
  const row = db.prepare('SELECT term FROM enrollments ORDER BY updated_at DESC, term DESC LIMIT 1').get();
  return row?.term ?? null;
}

export function readSchedule(term) {
  // Sin término (nunca se sincronizó y no hay TARGET_TERM) no es un error:
  // es un horario vacío, y la UI ofrece traerlo del portal.
  if (!term) {
    return { term: null, generatedAt: new Date().toISOString(), syncedAt: null, courses: [] };
  }

  const rows = db
    .prepare(
      `SELECT e.status, e.units, e.grading, e.grade, e.start_date, e.end_date,
              s.id AS section_id, s.class_nbr, s.section, s.component, s.instructor, s.meetings,
              c.id AS course_id, c.code, c.subject, c.catalog_nbr, c.title
       FROM enrollments e
       JOIN sections s ON s.id = e.section_id
       JOIN courses c ON c.id = e.course_id
       WHERE e.term = ?
       ORDER BY c.code, s.class_nbr`
    )
    .all(term);

  const byCourse = new Map();
  for (const row of rows) {
    if (!byCourse.has(row.course_id)) {
      byCourse.set(row.course_id, {
        id: row.course_id,
        code: row.code,
        subject: row.subject,
        catalogNbr: row.catalog_nbr,
        title: row.title,
        status: row.status,
        units: row.units,
        grading: row.grading,
        grade: row.grade,
        sections: [],
      });
    }
    byCourse.get(row.course_id).sections.push({
      id: row.section_id,
      classNbr: row.class_nbr,
      section: row.section,
      component: row.component,
      instructor: row.instructor,
      meetings: row.meetings ? JSON.parse(row.meetings) : [],
      startDate: row.start_date,
      endDate: row.end_date,
    });
  }

  return {
    term: term ?? null,
    generatedAt: new Date().toISOString(),
    syncedAt: lastSync('mySchedule', term),
    courses: [...byCourse.values()],
  };
}

// ── Scraper ────────────────────────────────────────────────────────────────

// Se ejecuta dentro del browser: no puede cerrar sobre nada del módulo. A
// cambio corre contra el fixture sin tocar el portal (scripts/test-schedule-parser.mjs).
export function extractSchedule() {
  const strip = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const textOf = (root, selector) => strip(root.querySelector(selector));

  // El código de término no se muestra en pantalla (la cabecera dice
  // "Septiembre de 2026"), pero el portal lo deja en un objeto JS.
  const term = (document.documentElement.innerHTML.match(/STRM:"(\d+)"/) ?? [])[1] ?? null;

  const courses = [];
  for (const box of document.querySelectorAll('[id^="ACE_STDNT_ENRL_SSV2$"]')) {
    // "ICC     ICC233 - Seg. en Tecnología Información". El subject se repite
    // dentro del catalog_nbr, y lo dejamos fuera para que el código canónico
    // sea "ICC-233" — el mismo que produce el catálogo.
    const label = textOf(box, '.PAGROUPDIVIDER');
    const m = label.match(/^([A-Z]{2,4})\s+\1?(\d{2,4}[A-Z]?)\s*-\s*(.*)$/);
    if (!m) continue;

    const sections = [];
    const rows = [...box.querySelectorAll('[id^="DERIVED_CLS_DTL_CLASS_NBR$"]')].filter((el) =>
      /^DERIVED_CLS_DTL_CLASS_NBR\$\d+$/.test(el.id)
    );
    for (const row of rows) {
      const i = row.id.split('$')[1];
      const byId = (prefix) => strip(document.getElementById(`${prefix}$${i}`));
      sections.push({
        classNbr: strip(row),
        section: byId('MTG_SECTION') || null,
        component: byId('MTG_COMP') || null,
        dayTime: byId('MTG_SCHED'),
        room: byId('MTG_LOC'),
        instructor: byId('DERIVED_CLS_DTL_SSR_INSTR_LONG') || null,
        dates: byId('MTG_DATES'),
      });
    }

    courses.push({
      subject: m[1],
      catalogNbr: m[2],
      title: m[3].trim() || null,
      status: textOf(box, '[id^="STATUS$"]') || null,
      units: textOf(box, '[id^="DERIVED_REGFRM1_UNT_TAKEN$"]') || null,
      grading: textOf(box, '[id^="GB_DESCR$"]') || null,
      grade: textOf(box, '[id^="CRSE_GRADE_OFF$"]') || null,
      sections,
    });
  }

  return { term, courses };
}

// Convierte lo extraído en el contrato Zod del horario.
function toSchedule(raw) {
  return scrapedScheduleSchema.parse({
    term: raw.term,
    courses: raw.courses.map((c) => ({
      courseCode: `${c.subject}-${c.catalogNbr}`,
      subject: c.subject,
      catalogNbr: c.catalogNbr,
      title: c.title,
      status: normalizeEnrollStatus(c.status),
      units: c.units ? Number(c.units) : null,
      grading: c.grading || null,
      grade: c.grade || null,
      sections: c.sections.map((s) => {
        const { start, end } = parseDateRange(s.dates);
        return {
          classNbr: s.classNbr,
          section: s.section,
          component: normalizeComponent(s.component),
          instructor: s.instructor,
          meetings: parseMeetings(s.dayTime, s.room),
          startDate: start,
          endDate: end,
        };
      }),
    })),
  });
}

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
  return null;
}

// Lee el horario inscrito del portal y lo persiste. Devuelve lo guardado.
export async function syncSchedule(page, { onStep = () => {} } = {}) {
  try {
    onStep('abriendo Mi Horario…');
    await page.goto(SCHEDULE_URL, { waitUntil: 'commit' });
    await page.waitForTimeout(6000);

    // La pantalla abre en vista de calendario; List View es la que parseamos.
    const listRadio = await findFrame(page, '[id="DERIVED_REGFRM1_SSR_SCHED_FORMAT$258$"]');
    if (listRadio) {
      const radio = listRadio.locator('[id="DERIVED_REGFRM1_SSR_SCHED_FORMAT$258$"]');
      if (!(await radio.isChecked())) {
        onStep('cambiando a vista de lista…');
        await radio.check();
        await page.waitForTimeout(7000);
      }
    }

    const frame = await findFrame(page, '[id="ICStateNum"]');
    if (!frame) throw new Error('No se encontró el contenido del horario');

    onStep('leyendo materias inscritas…');
    const schedule = toSchedule(await frame.evaluate(extractSchedule));

    const saved = saveSchedule(schedule);
    logSync({
      kind: 'mySchedule',
      term: schedule.term,
      status: 'ok',
      detail: `${schedule.courses.length} materia(s)`,
      rows: saved,
    });
    return schedule;
  } catch (err) {
    logSync({ kind: 'mySchedule', status: 'error', detail: err.message });
    throw err;
  }
}
