import { SCHEDULE_URL } from './constants.js';
import { db, logSync, lastSync } from '../db.js';
import { saveSection } from './catalog.js';
import {
  scrapedScheduleSchema,
  scrapedSectionSchema,
  normalizeEnrollStatus,
} from '../shared/schemas.ts';
import { parseMeetings, normalizeComponent, parseDateRange } from '../shared/meetings.ts';
import { upsertTerm } from '../terms.js';

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
export function saveSchedule({ term, termLabel = null, courses }) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM enrollments WHERE term = ?').run(term);

    // La ventana del término sale de las fechas de sus secciones (MTG_DATES):
    // el primer inicio y el último fin. Es lo que el modelo de tiempo usa para
    // saber si el ciclo corre hoy.
    let start = null;
    let end = null;
    let saved = 0;
    for (const course of courses) {
      for (const s of course.sections) {
        if (s.startDate && (start === null || s.startDate < start)) start = s.startDate;
        if (s.endDate && (end === null || s.endDate > end)) end = s.endDate;
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
    // El STRM, su etiqueta y su ventana en la misma fila: acá se cruzan los dos
    // vocabularios de término. La etiqueta puede venir null (layout cambiado);
    // upsertTerm la deriva de la fecha de inicio como respaldo.
    upsertTerm({ code: term, label: termLabel, startDate: start, endDate: end });
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
  // La etiqueta en español sí está en pantalla, en la cabecera del estudiante:
  // "Septiembre de 2026 | Grado | Pont. Universidad…". Es la que cruza el STRM
  // con el vocabulario de grades, así que la capturamos junto al código.
  const termLabel =
    (strip(document.querySelector('[id^="DERIVED_REGFRM1_SSR_STDNTKEY_DESCR$"]')).split('|')[0] || '').trim() || null;

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

  return { term, termLabel, courses };
}

// Convierte lo extraído en el contrato Zod del horario.
function toSchedule(raw) {
  return scrapedScheduleSchema.parse({
    term: raw.term,
    termLabel: raw.termLabel ?? null,
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

// Pura y testeable: elige, entre los radios que ofrece el selector de término,
// el del ciclo pedido. Matchea por STRM (el `value` del radio) y, como respaldo,
// por etiqueta (la fila dice "Septiembre de 2026 | Grado | …"). Sin término
// pedido toma el primero, que es el default del portal. Si se pidió uno que no
// está en la lista, es un error explícito: sincronizar otro ciclo en silencio
// es justo el bug que este paso viene a cerrar.
export function pickTermRadio(radios, targetTerm) {
  if (!targetTerm) return radios[0] ?? null;
  const hit = radios.find((r) => r.value === targetTerm || (r.label ?? '').includes(targetTerm));
  if (!hit) throw new Error(`El ciclo ${targetTerm} no está disponible en Mi Horario`);
  return hit;
}

// El horario vive detrás de un selector de término: cuando hay más de un ciclo
// activo, PeopleSoft primero pide elegirlo (radios SSR_DUMMY + Continuar) y
// recién ahí muestra la grilla. Con un solo ciclo va directo, y el selector no
// aparece: en ese caso no hay nada que elegir y seguimos de largo.
async function selectTerm(page, targetTerm, onStep) {
  const selector = await findFrame(page, 'input[name^="SSR_DUMMY_RECV1$sels$"]', { timeout: 4000 });
  if (!selector) return;

  const radios = await selector.evaluate(() =>
    [...document.querySelectorAll('input[name^="SSR_DUMMY_RECV1$sels$"]')].map((radio) => {
      const row = radio.closest('tr');
      return { value: radio.value, id: radio.id, label: row ? row.textContent.replace(/\s+/g, ' ').trim() : null };
    })
  );

  const target = pickTermRadio(radios, targetTerm);
  if (!target) return;

  onStep('eligiendo el ciclo…');
  await selector.locator(`[id="${target.id}"]`).check();
  await page.waitForTimeout(1500);

  // El botón cambia de idioma según el portal ("Continue"/"Continuar"); aceptamos
  // ambos para no atarnos a la locale.
  const cont = await findFrame(page, 'input[value="Continue"], input[value="Continuar"]', { timeout: 5000 });
  if (cont) {
    await cont.locator('input[value="Continue"], input[value="Continuar"]').first().click();
    await page.waitForTimeout(8000);
  }
}

// Lee el horario inscrito del portal y lo persiste. Devuelve lo guardado.
// targetTerm (STRM) fija qué ciclo sincronizar; sin él, el que el portal dé por
// defecto (el arranque, cuando todavía no conocemos el STRM del ciclo actual).
export async function syncSchedule(page, { onStep = () => {}, targetTerm = null } = {}) {
  try {
    onStep('abriendo Mi Horario…');
    await page.goto(SCHEDULE_URL, { waitUntil: 'commit' });
    await page.waitForTimeout(6000);

    // Si el portal ofrece elegir ciclo, elegimos el pedido antes de leer nada.
    await selectTerm(page, targetTerm, onStep);

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

    // Verificación: si pedimos un ciclo y el portal devolvió otro, no lo
    // guardamos. Pasaba cuando el portal recuerda un ciclo previo y aterriza en
    // su grilla sin ofrecer el selector: guardar eso metía Septiembre donde se
    // pedía Abril. Mejor fallar fuerte que ensuciar el horario con otro término.
    if (targetTerm && schedule.term && schedule.term !== targetTerm) {
      throw new Error(
        `Se pidió el horario del ciclo ${targetTerm} pero PeopleSoft mostró ${schedule.term}. ` +
          'El portal no ofreció cambiar de ciclo; no se guardó nada.'
      );
    }

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
