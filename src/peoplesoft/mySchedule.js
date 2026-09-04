import { MANAGE_CLASSES_START_URL, VIEW_MY_CLASSES_URL } from './constants.js';
import { db, logSync, lastSync } from '../db.js';
import { termAliases } from '../terms.js';
import { saveSection } from './catalog.js';
import {
  scrapedScheduleSchema,
  scrapedSectionSchema,
  normalizeEnrollStatus,
} from '../shared/schemas.ts';
import { parseFluidMeeting, normalizeComponent, parseDateRange } from '../shared/meetings.ts';
import { upsertTerm } from '../terms.js';

// Horario inscrito. Fuente: View My Classes (Fluid), volcado en
// fixtures/recon-my-classes-view.html (ver src/recon-my-classes.js). Es la
// pantalla del horario REAL: reemplazó a SSR_SSENRL_SCHD_W (el viejo, atado a la
// ventana de inscripción, que solo veía el ciclo abierto para inscribir y por eso
// era ciego al ciclo en curso). Lo que el recon confirmó y manda el diseño de acá:
//
//   1. Es Fluid: hay que crear el navigation collection lanzando el START del
//      tile Manage Classes antes de abrir la hoja, o el portal tira
//      `bIsCalledOutsideNavigationCollection` (MAPA §68-72).
//   2. La hoja abre en un selector de ciclo tipo grilla ("Select a Value") que
//      solo lista los ciclos ACTUAL y PRÓXIMO (no los pasados). Hay que clickear
//      el link del ciclo (SSR_ENTRMCUR_VW_TERM_DESCR30$N) para ver su horario.
//   3. Cada materia es un contenedor SSR_SBJCT_LVL1_row$N que agrupa por
//      contención su título, estado, créditos y sus reuniones. El índice de las
//      reuniones ($M) es global a la página → agrupar por contención, nunca por
//      índice (misma regla que el resto de los scrapers del portal).
//   4. Trae el ESTADO por materia (DRV_STAT: Enrolled/Dropped/Waiting). La
//      pantalla muestra las dadas de baja mezcladas con las inscritas; el parser
//      las descarta por ese estado (si no, una materia dada de baja aparecería en
//      el horario).
//   5. NO expone el STRM (solo la etiqueta "Abril de 2026") ni el profesor/sección
//      en la vista principal. Por eso el horario se keyea por la etiqueta y el
//      STRM queda opcional (se rellena por COALESCE si otra fuente ya lo conoce).
//      Ver [[horario-real-source]] y constants.js.

// ── Capa de escritura ──────────────────────────────────────────────────────

const upsertEnrollmentStmt = db.prepare(`
  INSERT INTO enrollments (user_id, term, course_id, section_id, status, units, grading, grade, start_date, end_date, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(user_id, term, section_id) DO UPDATE SET
    status = excluded.status,
    units = excluded.units,
    grading = excluded.grading,
    grade = excluded.grade,
    start_date = excluded.start_date,
    end_date = excluded.end_date,
    updated_at = datetime('now')
`);

// El STRM que la tabla `terms` ya conozca para una etiqueta ("Abril de 2026" →
// "1920"), o null. Es lo que permite keyear el horario por STRM cuando otra
// fuente (notas, catálogo) ya lo aportó, y por la etiqueta cuando no. Así el
// identificador del término coincide con el que readTerms calcula (code ?? label).
export function codeForLabel(label) {
  if (!label) return null;
  return db.prepare('SELECT code FROM terms WHERE label = ? AND code IS NOT NULL').get(label)?.code ?? null;
}

// El class search da títulos completos vía Browse Catalog; View My Classes los da
// TRUNCADOS ("Program. Paralela y Concurr"). Regla: no pisar un título real ya
// conocido con el truncado. Si no hay título todavía, el truncado es mejor que el
// código pelado. Devuelve el título a guardar (null = conservar el de la DB).
function scheduleTitle(courseCode, scrapedTitle) {
  const known = db.prepare('SELECT title FROM courses WHERE code = ?').get(courseCode);
  if (known?.title && known.title !== courseCode) return null;
  return scrapedTitle;
}

// Persiste el horario de un término. Borra las inscripciones previas de ese
// término antes de reinsertar: si diste de baja una materia, un upsert solo la
// dejaría para siempre en tu horario. Va en transacción para que el horario
// nunca se lea a medio reemplazar.
//
// `term` es el identificador resuelto: el STRM si `terms` ya lo conocía para esta
// etiqueta, si no la propia etiqueta. `termLabel` es la etiqueta en español y es
// obligatoria (es la que nombra el ciclo y de la que sale el STRM opcional).
export function saveSchedule(userId, { term, termLabel = null, courses }) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM enrollments WHERE user_id = ? AND term = ?').run(userId, term);

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
            // No pisar un título completo del catálogo con el truncado de acá.
            title: scheduleTitle(course.courseCode, course.title),
            // Los créditos son de la materia; el class search no los da.
            credits: course.units,
            term,
            classNbr: s.classNbr,
            section: s.section,
            component: s.component,
            instructor: s.instructor,
            meetings: s.meetings,
          }),
          // View My Classes es autoritativo para tu horario y tu aula, pero NO
          // publica profesor: manda null. Sin declarar la procedencia, ese null
          // borraba en cada sync el profesor que el catálogo había enriquecido.
          { source: 'my-classes' }
        );
        const courseId = db.prepare('SELECT course_id FROM sections WHERE id = ?').get(sectionId).course_id;
        upsertEnrollmentStmt.run(
          userId,
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
    // vocabularios de término. El código va solo cuando el identificador ES un
    // STRM (distinto de la etiqueta); si se keyeó por etiqueta, code queda null y
    // el COALESCE de upsertTerm no lo inventa.
    const code = term && term !== termLabel ? term : null;
    upsertTerm({ code, label: termLabel, startDate: start, endDate: end });
    db.exec('COMMIT');
    return saved;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ── Capa de lectura (GET /api/schedule) ────────────────────────────────────

// El término del horario que se sincronizó más recientemente. Sirve para que
// /horario funcione sin configurar nada: el primer sync descubre el término
// activo y desde ahí es el default.
export function latestScheduledTerm(userId) {
  const row = db
    .prepare('SELECT term FROM enrollments WHERE user_id = ? ORDER BY updated_at DESC, term DESC LIMIT 1')
    .get(userId);
  return row?.term ?? null;
}

export function readSchedule(userId, term) {
  // Sin término (nunca se sincronizó) no es un error:
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
       WHERE e.user_id = ? AND e.term = ?
       ORDER BY c.code, s.class_nbr`
    )
    .all(userId, term);

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

  // El estado de sync sale del REGISTRO de sync del ciclo, no de si esta query
  // encontró filas (§P0.5): un ciclo sincronizado sin materias inscritas está
  // sincronizado igual. Se mira bajo todos los alias del ciclo para que la
  // frescura sobreviva a que el STRM aparezca después de haber sincronizado por
  // etiqueta.
  const syncedAt = termAliases(term)
    .map((alias) => lastSync('mySchedule', { term: alias, userId }))
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;

  return {
    term: term ?? null,
    generatedAt: new Date().toISOString(),
    syncedAt,
    courses: [...byCourse.values()],
  };
}

export function removeEnrollmentCourse(userId, term, courseCode) {
  return db
    .prepare(
      `DELETE FROM enrollments
       WHERE user_id = ? AND term = ? AND course_id IN (SELECT id FROM courses WHERE code = ?)`
    )
    .run(userId, term, courseCode).changes;
}

// ── Scraper ────────────────────────────────────────────────────────────────

// Se ejecuta dentro del browser: no puede cerrar sobre nada del módulo. A
// cambio corre contra el fixture sin tocar el portal (scripts/test-schedule-parser.mjs).
export function extractSchedule() {
  const strip = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

  // La etiqueta del ciclo ("Abril de 2026") vive en la cabecera de la pantalla.
  // Es la identidad del término: View My Classes no expone el STRM.
  const termLabel = strip(document.getElementById('TERM_VAL_TBL_DESCR')) || null;

  const courses = [];
  // Cada materia es un contenedor que agrupa por CONTENCIÓN su título, estado,
  // créditos y reuniones. El índice de reunión es global; por eso se lee todo
  // dentro del contenedor y nunca cruzando índices.
  for (const box of document.querySelectorAll('[id^="win0divSSR_SBJCT_LVL1_row$"]')) {
    if (!/^win0divSSR_SBJCT_LVL1_row\$\d+$/.test(box.id)) continue;

    // "ICC     ICC303   Program. Paralela y Concurr": subject, subject+catálogo y
    // título (truncado). El subject se repite dentro del código; se descarta para
    // que el canónico sea "ICC-303", el mismo que produce el catálogo.
    const label = strip(box.querySelector('[id^="DERIVED_SSR_FL_SSR_SCRTAB_DTLS$"]'));
    const m = label.match(/^([A-Z]{2,4})\s+\1?(\d{2,4}[A-Z]?)\s+(.*)$/);
    if (!m) continue;

    const sections = [];
    const meetRows = [...box.querySelectorAll('[id^="DERIVED_SSR_FL_SSR_SBJ_CAT_NBR$355$$"]')].filter((el) =>
      /\$355\$\$\d+$/.test(el.id)
    );
    for (const row of meetRows) {
      const i = row.id.match(/\$(\d+)$/)[1];
      const byId = (prefix) => strip(document.getElementById(`${prefix}$${i}`));
      sections.push({
        // "Lecture - 5822" → componente y class number.
        componentClass: strip(row),
        days: byId('DERIVED_SSR_FL_SSR_DAYS1'),
        times: byId('DERIVED_SSR_FL_SSR_DAYSTIMES1'),
        room: byId('DERIVED_SSR_FL_SSR_DRV_ROOM1'),
        dates: byId('DERIVED_SSR_FL_SSR_ST_END_DT1'),
      });
    }

    courses.push({
      subject: m[1],
      catalogNbr: m[2],
      title: m[3].trim() || null,
      // Enrolled / Dropped / Waiting — por materia.
      status: strip(box.querySelector('[id^="DERIVED_SSR_FL_SSR_DRV_STAT$392$$"]')) || null,
      units: strip(box.querySelector('[id^="STDNT_ENRL_SSV1_UNT_TAKEN$"]')) || null,
      grading: strip(box.querySelector('[id^="DERIVED_SSR_FL_SSR_GRD_BASIS_ENRL$"]')) || null,
      grade: strip(box.querySelector('[id^="STDNT_ENRL_SSV1_CRSE_GRADE_OFF$"]')) || null,
      sections,
    });
  }

  return { termLabel, courses };
}

// "Lecture - 5822" → { component: "Lecture", classNbr: "5822" }.
function splitComponentClass(raw) {
  const m = (raw ?? '').match(/^(.*?)\s*-\s*(\d+)\s*$/);
  if (m) return { component: m[1].trim() || null, classNbr: m[2] };
  return { component: null, classNbr: (raw ?? '').trim() || null };
}

// Convierte lo extraído en el contrato Zod del horario. Descarta las materias
// dadas de baja (siguen apareciendo en la pantalla) y agrupa las reuniones de un
// mismo class number en una sola sección (una LEC que se reúne dos días). `term`
// es el identificador ya resuelto (STRM conocido o etiqueta).
export function toSchedule(raw, { term }) {
  const courses = [];
  for (const c of raw.courses) {
    const status = normalizeEnrollStatus(c.status);
    // Una materia dada de baja no es tu horario: no entra.
    if (status === 'dropped') continue;

    // Agrupar reuniones por class number: cada class number es una sección (LEC,
    // PRA…) con sus reuniones; una sección puede reunirse varios días.
    const bySection = new Map();
    for (const s of c.sections) {
      const { component, classNbr } = splitComponentClass(s.componentClass);
      if (!classNbr) continue;
      if (!bySection.has(classNbr)) {
        const { start, end } = parseDateRange(s.dates);
        bySection.set(classNbr, {
          classNbr,
          section: null, // View My Classes no expone el número de sección.
          component: normalizeComponent(component),
          instructor: null, // ni el profesor en la vista principal.
          meetings: [],
          startDate: start,
          endDate: end,
        });
      }
      bySection.get(classNbr).meetings.push(...parseFluidMeeting(s.days, s.times, s.room));
    }

    const sections = [...bySection.values()];
    if (!sections.length) continue;

    courses.push({
      courseCode: `${c.subject}-${c.catalogNbr}`,
      subject: c.subject,
      catalogNbr: c.catalogNbr,
      title: c.title,
      status,
      units: c.units ? Number(c.units) : null,
      grading: c.grading || null,
      grade: c.grade || null,
      sections,
    });
  }

  return scrapedScheduleSchema.parse({
    term,
    termLabel: raw.termLabel ?? null,
    courses,
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

// Pura y testeable: elige, entre las filas del selector de ciclo, la del ciclo
// pedido. View My Classes lista los ciclos por su etiqueta ("Abril de 2026"), no
// por STRM. Sin ciclo pedido toma el primero (el que el portal pone arriba, el
// actual). Un ciclo pedido que no está en la lista es un error explícito: la
// pantalla solo trae ciclos actuales/próximos, así que pedir uno ausente (ej. un
// pasado) no debe caer en silencio en otro ciclo.
export function pickTermRow(rows, targetLabel) {
  if (!targetLabel) return rows[0] ?? null;
  const hit = rows.find((r) => r.label === targetLabel || r.label.includes(targetLabel));
  if (!hit) throw new Error(`El ciclo ${targetLabel} no está disponible en Mi Horario`);
  return hit;
}

// El horario abre en un selector de ciclo (grilla de links). Elegimos el pedido
// por etiqueta, o el primero (el actual). Con un solo ciclo el selector igual
// aparece; si por algún motivo no está, seguimos de largo (ya en un horario).
async function selectTerm(page, targetLabel, onStep) {
  const picker = await findFrame(page, 'a[id^="SSR_ENTRMCUR_VW_TERM_DESCR30$"]', { timeout: 5000 });
  if (!picker) return;

  const rows = await picker.evaluate(() =>
    [...document.querySelectorAll('a[id^="SSR_ENTRMCUR_VW_TERM_DESCR30$"]')]
      .filter((a) => /^SSR_ENTRMCUR_VW_TERM_DESCR30\$\d+$/.test(a.id))
      .map((a) => ({ id: a.id, label: a.textContent.replace(/\s+/g, ' ').trim() }))
  );

  const target = pickTermRow(rows, targetLabel);
  if (!target) return;

  onStep('abriendo el ciclo…');
  await picker.locator(`a[id="${target.id}"]`).first().click();
  await page.waitForTimeout(7000);
}

// La pantalla abre en vista de lista por defecto (SSR_VW_CLSCHD_OPT=L), que es la
// que parseamos. La forzamos igual por si el portal recuerda la de calendario.
async function ensureListView(page, onStep) {
  const frame = await findFrame(page, '[id="DERIVED_SSR_FL_SSR_VW_CLSCHD_OPT"]', { timeout: 4000 });
  if (!frame) return;
  const radio = frame.locator('[id="DERIVED_SSR_FL_SSR_VW_CLSCHD_OPT"]').first();
  try {
    if ((await radio.count()) && !(await radio.isChecked())) {
      onStep('cambiando a vista de lista…');
      await radio.check();
      await page.waitForTimeout(6000);
    }
  } catch {
    // control ausente o no chequeable en este layout; la lista es el default.
  }
}

// Lee el horario inscrito del portal y lo persiste. Devuelve lo guardado.
// targetTerm es la ETIQUETA del ciclo a sincronizar ("Abril de 2026"); sin ella,
// el ciclo que el portal ponga primero (el actual).
export async function syncSchedule(page, { userId, onStep = () => {}, targetTerm = null }) {
  try {
    onStep('abriendo Mi Horario…');
    // Crear el navigation collection Fluid antes de la hoja, o el portal la
    // rechaza con bIsCalledOutsideNavigationCollection.
    await page.goto(MANAGE_CLASSES_START_URL, { waitUntil: 'commit' });
    await page.waitForTimeout(6000);
    await page.goto(VIEW_MY_CLASSES_URL, { waitUntil: 'commit' });
    await page.waitForTimeout(6000);

    // Elegir el ciclo pedido (por etiqueta) antes de leer nada.
    await selectTerm(page, targetTerm, onStep);
    await ensureListView(page, onStep);

    const frame = await findFrame(page, '[id="ICStateNum"]');
    if (!frame) throw new Error('No se encontró el contenido del horario');

    onStep('leyendo materias inscritas…');
    const raw = await frame.evaluate(extractSchedule);
    if (!raw.termLabel) {
      throw new Error('No se pudo leer el ciclo del horario (¿cambió el layout de View My Classes?)');
    }

    // Verificación: si pedimos un ciclo y el portal mostró otro, no guardamos.
    // Mejor fallar fuerte que meter un ciclo donde se pidió otro.
    if (targetTerm && !raw.termLabel.includes(targetTerm) && raw.termLabel !== targetTerm) {
      throw new Error(
        `Se pidió el horario de ${targetTerm} pero View My Classes mostró ${raw.termLabel}; no se guardó nada.`
      );
    }

    // La clave del término: el STRM si `terms` ya lo conoce para esta etiqueta,
    // si no la etiqueta. Así coincide con el identificador que readTerms calcula.
    const term = codeForLabel(raw.termLabel) ?? raw.termLabel;
    const schedule = toSchedule(raw, { term });

    const saved = saveSchedule(userId, schedule);
    logSync({
      userId,
      kind: 'mySchedule',
      term,
      status: 'ok',
      detail: `${schedule.courses.length} materia(s)`,
      rows: saved,
    });
    return schedule;
  } catch (err) {
    logSync({ userId, kind: 'mySchedule', status: 'error', detail: err.message });
    throw err;
  }
}
