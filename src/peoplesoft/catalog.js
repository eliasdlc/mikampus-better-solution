import { CLASS_SEARCH_URL } from './constants.js';
import { mergeSection } from '../shared/sectionMerge.ts';
import { writeDiagnostic } from '../diagnostics.js';
import { db, logSync } from '../db.js';
import { scrapedSectionSchema, normalizeSeatStatus } from '../shared/schemas.ts';
import { parseMeetings } from '../shared/meetings.ts';
import { splitCourseCode, courseCodeToString, portalCatalogNbr } from '../shared/courseCode.ts';
import { CAMPUS_CODES, campusCodeSchema, campusFromSectionNumber, groupByCampus, orderByCampus } from '../shared/campus.ts';
import { LOCAL_USER_ID } from '../users.js';
import { knownSubjects } from './browseCatalog.js';

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

// Los valores que llegan acá YA pasaron por mergeSection: este statement no
// decide nada, solo escribe el resultado. La lógica de "lo vacío no pisa lo
// lleno" vive en shared/sectionMerge.ts, donde se puede probar sola.
//
// El campus es la excepción, y por eso su precedencia sí vive en el SQL: no es
// "lo lleno gana sobre lo vacío" sino una jerarquía de fuentes. Lo que dijo el
// portal ('portal') pisa cualquier cosa, una inferencia por número de sección
// nunca pisa lo que dijo el portal, y una escritura sin campus (una búsqueda
// sin filtrar, o el scraper de Mi Horario, que no sabe de campus) jamás borra
// lo que ya se sabía.
const upsertSectionStmt = db.prepare(`
  INSERT INTO sections (course_id, term, class_nbr, section, component, instructor, meetings,
                        instructor_source, meetings_source, campus, campus_source, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(term, class_nbr) DO UPDATE SET
    course_id = excluded.course_id,
    section = excluded.section,
    component = excluded.component,
    instructor = excluded.instructor,
    meetings = excluded.meetings,
    instructor_source = excluded.instructor_source,
    meetings_source = excluded.meetings_source,
    campus = CASE
      WHEN excluded.campus IS NULL THEN sections.campus
      WHEN sections.campus_source = 'portal' AND excluded.campus_source IS NOT 'portal' THEN sections.campus
      ELSE excluded.campus END,
    campus_source = CASE
      WHEN excluded.campus IS NULL THEN sections.campus_source
      WHEN sections.campus_source = 'portal' AND excluded.campus_source IS NOT 'portal' THEN sections.campus_source
      ELSE excluded.campus_source END,
    updated_at = datetime('now')
`);

// Los encuentros ya guardados viven como JSON en una columna de texto. Ojo con
// el nombre: `parseMeetings` (shared/meetings.ts) parsea el TEXTO del portal
// ("LuMi 8:00AM - 9:30AM"); esto lee lo que nosotros mismos serializamos. Una
// fila vieja o corrupta no puede tumbar un sync entero.
function storedMeetings(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const recordSeatsStmt = db.prepare(`
  INSERT INTO seats_snapshot (section_id, status, seats_open, seats_cap, wait_total, captured_at)
  VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
`);

// El class search NO devuelve el título de la materia (el recon lo confirmó:
// el header de cada grupo viene como "ICC     ICC321 - " con el título vacío).
// Los títulos los trae el Browse Catalog (browseCatalog.js), que escribe en
// esta misma tabla. La regla acá: un barrido de catálogo jamás puede pisar un
// título real con un placeholder. Si el título no llegó todavía, el código
// hace de título hasta que el sync de títulos lo complete.
function resolveTitle(courseCode, scrapedTitle) {
  if (scrapedTitle) return scrapedTitle;
  const known = db.prepare('SELECT title FROM courses WHERE code = ?').get(courseCode);
  return known?.title ?? courseCode;
}

// Materias cuyo título todavía es el placeholder — las que un backfill en
// segundo plano debería resolver.
export function coursesMissingTitle() {
  return db.prepare('SELECT code FROM courses WHERE title = code ORDER BY code').all().map((r) => r.code);
}

// Guarda una sección validada (course + section + snapshot de cupo) en una
// transacción. `s` ya pasó por scrapedSectionSchema.
export function saveSection(s, { source = 'class-search' } = {}) {
  const title = resolveTitle(s.courseCode, s.title);
  upsertCourseStmt.run(s.courseCode, s.subject, s.catalogNbr, title, s.career, s.credits);
  const courseId = db.prepare('SELECT id FROM courses WHERE code = ?').get(s.courseCode).id;

  // La correlación es por STRM + class number, que es la UNIQUE de la tabla.
  // Nunca por código de materia ni por sección: dos grupos de la misma materia
  // se intercambiarían profesor y aula.
  const existing = db
    .prepare(
      `SELECT section, component, instructor, meetings,
              instructor_source AS instructorSource, meetings_source AS meetingsSource
       FROM sections WHERE term = ? AND class_nbr = ?`
    )
    .get(s.term, s.classNbr);

  const { fields, conflicts } = mergeSection(
    existing
      ? {
          section: existing.section,
          component: existing.component,
          instructor: existing.instructor,
          meetings: storedMeetings(existing.meetings),
          instructorSource: existing.instructorSource,
          meetingsSource: existing.meetingsSource,
        }
      : null,
    { section: s.section, component: s.component, instructor: s.instructor, meetings: s.meetings ?? [] },
    source
  );

  upsertSectionStmt.run(
    courseId,
    s.term,
    s.classNbr,
    fields.section,
    fields.component,
    fields.instructor,
    JSON.stringify(fields.meetings),
    fields.instructorSource,
    fields.meetingsSource,
    // El campus no pasa por mergeSection: su precedencia no es por vacío sino
    // por fuente, y se resuelve en el SQL de arriba. Sin campus explícito se
    // manda null, que es lo que deja intacto lo que ya se sabía.
    s.campus ?? null,
    s.campus ? s.campusSource ?? 'portal' : null
  );

  // Una discrepancia no se resuelve en silencio ni rompe el sync: queda escrita
  // para que se pueda ver por qué dos pantallas del portal dicen cosas distintas.
  for (const conflict of conflicts) {
    writeDiagnostic(
      'section-merge',
      `${s.term}/${s.classNbr} ${conflict.field}: se conservó "${conflict.kept}" (${conflict.from}) sobre "${conflict.rejected}" (${conflict.over})`
    );
  }

  const sectionId = db.prepare('SELECT id FROM sections WHERE term = ? AND class_nbr = ?').get(s.term, s.classNbr).id;
  if (s.seats) {
    recordSeatsStmt.run(
      sectionId,
      s.seats.status,
      s.seats.open,
      s.seats.capacity,
      s.seats.waitTotal,
      s.seats.capturedAt ?? null
    );
  }
  return sectionId;
}

// El Class Search no publica créditos: de 907 materias del catálogo real, 900
// llegan con credits en null. Eso deja sin sentido todo lo que se mide en
// créditos —la carga máxima del recomendador, el total de un plan, el "X cr"
// del buscador— justo donde el estudiante decide.
//
// El plan académico oficial SÍ los trae, y es la fuente más autoritativa que
// existe (los emite la Dirección del Registro). Se copian al catálogo una vez
// al arrancar, y solo donde falta el dato: nunca se pisa un crédito que el
// portal haya llegado a informar.
const fillCreditsStmt = db.prepare(`
  UPDATE courses SET credits = ?, updated_at = datetime('now')
  WHERE code = ? AND credits IS NULL
`);

// Lo mismo pasa con los títulos, por otra vía: el Class Search deja el nombre
// vacío y resolveTitle (arriba) pone el código como marcador hasta que el
// Browse Catalog lo complete. Mientras eso no corra, el plan recomendado dice
// "ICC-471" donde debería decir "Gestión de Proyectos". La condición
// `title = code` es exactamente ese marcador: nunca pisa un nombre real.
const fillTitleStmt = db.prepare(`
  UPDATE courses SET title = ?, updated_at = datetime('now')
  WHERE code = ? AND title = code
`);

export function applyPlanFacts(plan) {
  if (!plan?.courses) return { credits: 0, titles: 0 };
  let credits = 0;
  let titles = 0;
  for (const rule of Object.values(plan.courses)) {
    if (rule.units != null && Number.isFinite(rule.units)) {
      credits += fillCreditsStmt.run(rule.units, rule.code).changes;
    }
    if (rule.title) titles += fillTitleStmt.run(rule.title, rule.code).changes;
  }
  return { credits, titles };
}

// ── Historia de cupo ───────────────────────────────────────────────────────
// La serie que el watcher y el catálogo vienen escribiendo desde el principio.
// Se lee acotada por ventana y por sección: son las secciones que le importan a
// alguien ahora mismo (su carrito), no el catálogo entero.
export function seatHistory(term, classNbrs, { windowHours = 24 } = {}) {
  if (!classNbrs?.length) return new Map();
  const placeholders = classNbrs.map(() => '?').join(', ');
  const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();
  const rows = db
    .prepare(
      `SELECT s.class_nbr AS classNbr, snap.status, snap.seats_open AS seatsOpen,
              snap.seats_cap AS seatsCap, snap.captured_at AS capturedAt
       FROM sections s
       JOIN seats_snapshot snap ON snap.section_id = s.id
       WHERE s.term = ? AND s.class_nbr IN (${placeholders}) AND snap.captured_at >= ?
       ORDER BY s.class_nbr, snap.captured_at`
    )
    .all(term, ...classNbrs, since);

  const byClass = new Map();
  for (const row of rows) {
    if (!byClass.has(row.classNbr)) byClass.set(row.classNbr, []);
    byClass.get(row.classNbr).push({
      status: row.status,
      seatsOpen: row.seatsOpen,
      seatsCap: row.seatsCap,
      capturedAt: row.capturedAt,
    });
  }
  return byClass;
}

// ── Campus del estudiante ──────────────────────────────────────────────────
// Vive acá y no con el resto del perfil porque el catálogo es su único
// consumidor: ninguna pantalla del portal publica en qué campus estudiás, así
// que nada lo scrapea y nadie más lo escribe. Sin elegir queda null, y entonces
// el catálogo no reordena nada: proponerlo es del onboarding, no de esta capa.
export function readHomeCampus(userId = LOCAL_USER_ID) {
  return db.prepare('SELECT home_campus FROM profile WHERE user_id = ?').get(userId)?.home_campus ?? null;
}

// Valida contra el vocabulario del portal antes de escribir: SQLite no puede
// hacerlo (no admite CHECK en una columna agregada), así que la garantía de que
// `campus` es uno de los tres códigos vive exactamente acá. null es un valor
// legítimo: significa "todavía no elegí".
export function setHomeCampus(userId, campus) {
  const parsed = campus === null || campus === undefined ? { success: true, data: null } : campusCodeSchema.safeParse(campus);
  if (!parsed.success) throw new Error(`Campus desconocido: elegí uno de ${CAMPUS_CODES.join(', ')}`);
  const value = parsed.data;
  const updated = db
    .prepare("UPDATE profile SET home_campus = ?, updated_at = datetime('now') WHERE user_id = ?")
    .run(value, userId);
  if (!updated.changes) {
    db.prepare('INSERT INTO profile (user_id, home_campus) VALUES (?, ?)').run(userId, value);
  }
  return value;
}

// ── Capa de lectura (GET /api/catalog) ─────────────────────────────────────
// Sirve el catálogo cacheado desde disco en <10ms. Agrupa secciones por materia
// y adjunta el último snapshot de cupo de cada una con su timestamp.
//
// El orden por campus se resuelve acá, no en cada pantalla: la lista plana ya
// viene con las secciones del campus del perfil primero, y al lado viaja la
// misma lista partida en grupos con su encabezado. Cada sección conserva su
// campo crudo (campus + campusSource) para que una pantalla pueda presentarlo
// de otra forma sin tener que deshacer este orden.
export function readCatalog(term, { homeCampus = readHomeCampus() } = {}) {
  const sections = db
    .prepare(
      `SELECT s.id, s.course_id, s.term, s.class_nbr, s.section, s.component, s.instructor, s.meetings,
              s.campus, s.campus_source,
              c.code, c.subject, c.catalog_nbr, c.title, c.career, c.credits
       FROM sections s JOIN courses c ON c.id = s.course_id
       ${term ? 'WHERE s.term = ?' : ''}
       ORDER BY c.code, s.section, s.class_nbr`
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
      term: row.term,
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
      campus: row.campus ?? null,
      campusSource: row.campus_source ?? null,
    });
  }

  const courses = [...byCourse.values()].map((course) => ({
    ...course,
    sections: orderByCampus(course.sections, homeCampus),
    campusGroups: groupByCampus(course.sections, homeCampus).map(({ items, ...group }) => ({
      ...group,
      sections: items,
    })),
  }));

  return {
    term: term ?? null,
    generatedAt: new Date().toISOString(),
    homeCampus,
    courses,
  };
}

// ── Scraper ────────────────────────────────────────────────────────────────
// Recon hecho contra HTML real (screenshots/recon-catalog-ICC3.html, ver
// src/recon-catalog.js). Lo que confirmó, y que manda en el diseño de acá:
//
//   1. El portal corta en 50 secciones por búsqueda ("Your search will exceed
//      the maximum limit of 50 sections") y no pagina: hay que trocear la
//      consulta hasta que cada trozo entre. De ahí el barrido recursivo.
//   2. En PUCMM el catalog_nbr incluye el subject ("ICC321"), así que buscar
//      catalog_nbr *contains* "ICC" trae el subject entero y "ICC3" trae los
//      ICC3xx. Ese prefijo es la palanca para trocear.
//   3. Los resultados se agrupan por materia en un div GROUPBOX2$N que envuelve
//      sus secciones; el número de sección NO se puede sacar de la fila (la
//      fila solo dice "101-LEC"), sale del header del grupo.
//   4. El header no trae título ni créditos → title va null. El título sale de
//      la otra pantalla del catálogo (browseCatalog.js); las dos se unen por el
//      código canónico, de ahí que ambas usen shared/courseCode.ts.
//
// Sigue siendo caro: cada trozo es una navegación completa (~20s). Es un sync
// de fondo, no algo que dispare la UI (riesgo #2 del plan) → throttle.
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

// Extrae la grilla de resultados. Se ejecuta dentro del browser vía evaluate(),
// así que no puede cerrar sobre nada del módulo: todo lo que necesita va acá
// dentro. A cambio se puede correr contra un HTML volcado sin tocar el portal
// (scripts/test-catalog-parser.mjs) — que es como se validó.
export function extractSearchResults() {
  const strip = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

  const courses = [];
  for (const anchor of document.querySelectorAll('a[id^="SSR_CLSRSLT_WRK_GROUPBOX2$"]')) {
    // "ICC     ICC321 - Título": subject, código y (a veces) título. El código
    // se devuelve crudo — partirlo es trabajo de splitCourseCode, en node, con
    // la misma regla que usa el Browse Catalog. La regex de antes exigía
    // dígitos ahí y descartaba en silencio materias reales como "ICC 1ICC473 -".
    const label = strip(anchor.parentElement);
    const m = label.match(/^([A-Z]{2,4})\s+(\S+)\s*-\s*(.*)$/);
    if (!m) continue;

    const container = anchor.closest('div[id^="win0divSSR_CLSRSLT_WRK_GROUPBOX2$"]');
    const sections = [];
    if (container) {
      // Filtrar por id exacto: el selector por prefijo también agarra el
      // <span id="MTG_CLASS_NBR$span$N"> que envuelve al link y duplicaría
      // cada fila. Mismo patrón para cualquier otro campo con wrapper $span$.
      const rows = [...container.querySelectorAll('[id^="MTG_CLASS_NBR$"]')].filter((el) =>
        /^MTG_CLASS_NBR\$\d+$/.test(el.id)
      );
      for (const row of rows) {
        const i = row.id.split('$')[1];
        const statusImg = document.querySelector(`[id="win0divDERIVED_CLSRCH_SSR_STATUS_LONG$${i}"] img`);
        // El estado del cupo solo existe como icono; el alt viene vacío, así
        // que el dato real es el nombre del gif (PS_CS_STATUS_OPEN_ICN_1.gif).
        const statusSrc = statusImg ? statusImg.getAttribute('src') ?? '' : '';
        const statusMatch = statusSrc.match(/STATUS_(OPEN|CLOSED|WAITLIST)/i);
        sections.push({
          classNbr: strip(row),
          // "101-LEC Ordinaria" → sección 101, componente LEC.
          classNameCell: strip(document.getElementById(`MTG_CLASSNAME$${i}`)),
          dayTime: strip(document.getElementById(`MTG_DAYTIME$${i}`)),
          room: strip(document.getElementById(`MTG_ROOM$${i}`)),
          instructor: strip(document.getElementById(`MTG_INSTR$${i}`)),
          status: statusMatch ? statusMatch[1] : null,
        });
      }
    }

    courses.push({
      subjectFromHeader: m[1],
      rawNbr: m[2],
      titleFromPortal: m[3].trim() || null,
      sections,
    });
  }

  return {
    exceeds: /exceed the maximum limit/i.test(document.body.textContent ?? ''),
    courses,
  };
}

// Corre UNA búsqueda (un trozo del barrido) y devuelve lo extraído en crudo.
async function searchByPrefix(page, { term, career, prefix, campus = null }) {
  await page.goto(CLASS_SEARCH_URL, { waitUntil: 'commit' });
  await page.waitForTimeout(5000);

  let frame = await findFrame(page, 'select[name="CLASS_SRCH_WRK2_STRM$35$"]');
  await frame.selectOption('select[name="CLASS_SRCH_WRK2_STRM$35$"]', term);
  await page.waitForTimeout(4000);

  frame = await findFrame(page, 'select[name="SSR_CLSRCH_WRK_ACAD_CAREER$2"]');
  await frame.selectOption('select[name="SSR_CLSRCH_WRK_ACAD_CAREER$2"]', career);
  await page.waitForTimeout(4000);

  // El campus se setea SIEMPRE, incluso a "todos" (''): PeopleSoft retiene el
  // estado del formulario entre navegaciones dentro de la misma sesión, así
  // que un campus elegido para trocear un código pegajoso filtraría en
  // silencio todos los trozos siguientes.
  frame = await findFrame(page, 'select[name="SSR_CLSRCH_WRK_CAMPUS$0"]');
  await frame.selectOption('select[name="SSR_CLSRCH_WRK_CAMPUS$0"]', campus ?? '');
  await page.waitForTimeout(3000);

  // "C" = contains. Con el prefijo en catalog_nbr, no en el campo subject.
  frame = await findFrame(page, 'select[name="SSR_CLSRCH_WRK_SSR_EXACT_MATCH1$1"]');
  await frame.selectOption('select[name="SSR_CLSRCH_WRK_SSR_EXACT_MATCH1$1"]', 'C');
  await page.waitForTimeout(1000);

  frame = await findFrame(page, 'input[name="SSR_CLSRCH_WRK_CATALOG_NBR$1"]');
  await frame.fill('input[name="SSR_CLSRCH_WRK_CATALOG_NBR$1"]', prefix);
  await page.waitForTimeout(1000);

  // Sin esto solo devuelve secciones con cupo — el catálogo las quiere todas.
  frame = await findFrame(page, '[id="SSR_CLSRCH_WRK_SSR_OPEN_ONLY$3"]');
  const openOnly = frame.locator('[id="SSR_CLSRCH_WRK_SSR_OPEN_ONLY$3"]');
  if (await openOnly.isChecked()) {
    await openOnly.uncheck();
    await page.waitForTimeout(3000);
  }

  frame = await findFrame(page, 'input[value="Search"]');
  await frame.click('input[value="Search"]');
  await page.waitForTimeout(8000);

  frame = await findFrame(page, '[id="ICStateNum"]');
  return frame.evaluate(extractSearchResults);
}

// Convierte lo extraído en filas validadas y las persiste.
//
// `campus` es el filtro con que se pidió la búsqueda: si la búsqueda lo llevaba,
// el portal mismo está diciendo a qué campus pertenece cada fila que devolvió, y
// se guarda como dato del portal. Sin filtro, la única pista es el número de
// sección, que se guarda marcado como inferencia (ver campusFromSectionNumber).
function persist(courses, { term, career, campus = null }) {
  let saved = 0;
  const subjects = knownSubjects();
  for (const course of courses) {
    const code = splitCourseCode(course.rawNbr, {
      subjectHint: course.subjectFromHeader,
      knownSubjects: subjects,
    });
    if (!code) {
      // Sin código no hay con qué unir esta materia a su título ni al carrito.
      console.warn(`Materia sin código legible, descartada: "${course.subjectFromHeader} ${course.rawNbr}"`);
      continue;
    }
    for (const s of course.sections) {
      // "101-LEC Ordinaria" → section "101", component "LEC".
      const cell = s.classNameCell.match(/^(\S+?)-(\S+)/);
      const parsed = scrapedSectionSchema.safeParse({
        courseCode: courseCodeToString(code),
        subject: code.subject,
        catalogNbr: code.catalogNbr,
        title: course.titleFromPortal,
        career,
        term,
        classNbr: s.classNbr,
        section: cell ? cell[1] : s.classNameCell || null,
        component: cell ? cell[2] : null,
        instructor: s.instructor || null,
        campus: campus ?? campusFromSectionNumber(cell ? cell[1] : null),
        campusSource: campus ? 'portal' : 'seccion',
        meetings: parseMeetings(s.dayTime, s.room),
        seats: s.status
          ? { status: normalizeSeatStatus(s.status), open: null, capacity: null, waitTotal: null }
          : null,
      });
      if (parsed.success) {
        saveSection(parsed.data);
        saved++;
      } else {
        // Zod gritando acá = selector roto, no dato raro. Que se vea.
        console.warn(`Sección descartada (${courseCodeToString(code)} / ${s.classNbr}):`,
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '));
      }
    }
  }
  return saved;
}

/**
 * El árbol de búsquedas de un barrido, sin navegador: el campus es el PRIMER
 * eje y el prefijo el segundo.
 *
 * Antes el campus era el último recurso, cuando ya no quedaban dígitos que
 * agregar. Invertirlo cambia tres cosas:
 *
 *   1. El campus deja de inferirse: cada fila la devolvió una búsqueda filtrada
 *      por campus, así que el dato lo dice el portal.
 *   2. Cada consulta trae la mitad de las secciones, así que la mayoría de los
 *      subjects deja de exceder el límite de 50 y de subdividirse: en el ciclo
 *      medido, ICC pasa de 11 navegaciones a 3.
 *   3. Desaparece el modo de falla que dejaba materias "sin trocear": un código
 *      completo que excedía ya no tenía ningún eje más que probar, y ahora el
 *      campus se aplicó antes de llegar ahí.
 *
 * El costo es el piso: un subject que hoy entra en una sola búsqueda pasa a
 * costar tres.
 *
 * `search` y `save` son la única parte que toca el portal y el disco: separarlas
 * es lo que permite probar el árbol de decisiones sin abrir Chromium.
 */
export async function sweepSubject({ subject, campuses = CAMPUS_CODES, maxDepth = 3 }, { search, save }) {
  const searches = [];
  const skipped = [];
  let saved = 0;

  const walk = async (prefix, depth, campus) => {
    searches.push({ prefix, campus });
    const { exceeds, courses } = await search({ prefix, campus });
    if (!exceeds) {
      saved += await save(courses, campus);
      return;
    }
    if (depth >= maxDepth) {
      // Sin dígitos que agregar y ya filtrado por campus, no queda eje: se
      // reporta con el campus adentro para que se pueda mirar a mano.
      skipped.push(`${prefix}@${campus}`);
      return;
    }
    for (let digit = 0; digit <= 9; digit++) {
      await walk(`${prefix}${digit}`, depth + 1, campus);
    }
  };

  for (const campus of campuses) {
    await walk(subject, 0, campus);
  }

  return { saved, skipped, searches };
}

// Barre un subject (ej. "ICC") de un término/carrera y persiste sus secciones,
// campus por campus. El throttle vive en la búsqueda misma: es un sync de fondo
// contra un portal ajeno, no algo que dispare la UI.
export async function syncCatalogSubject(page, { term, career, subject, throttleMs = 1500, maxDepth = 3 }) {
  let first = true;
  const { saved, skipped } = await sweepSubject(
    { subject, maxDepth },
    {
      search: async ({ prefix, campus }) => {
        if (!first) await page.waitForTimeout(throttleMs);
        first = false;
        return searchByPrefix(page, { term, career, prefix, campus });
      },
      save: (courses, campus) => persist(courses, { term, career, campus }),
    }
  );

  const detail = skipped.length ? `${subject} (sin trocear: ${skipped.join(', ')})` : subject;
  logSync({ kind: 'catalog', term, status: skipped.length ? 'error' : 'ok', detail, rows: saved });
  return { saved, skipped };
}

// Consulta una sola materia exacta para el watcher compartido. A diferencia
// del barrido por subject, acá el presupuesto importa: cada materia vigilada
// debe costar una sola navegación, no un árbol entero de prefijos. El filtro
// posterior es deliberado: PeopleSoft trata el campo como "contains", aun
// cuando se le pase el código completo.
export async function syncCatalogCourse(page, { term, career, courseCode, userId = LOCAL_USER_ID, campus = readHomeCampus(userId) }) {
  // El carrito puede llegar antes que un sync de catálogo completo. El código
  // canónico ya trae la partición necesaria para consultar el portal, así que
  // no dejamos al watcher ciego solo porque todavía no exista la fila courses.
  const fromDb = db.prepare('SELECT subject, catalog_nbr FROM courses WHERE code = ?').get(courseCode);
  const parsed = String(courseCode).match(/^([A-Z]{2,4})-(.+)$/);
  const course = fromDb ?? (parsed ? { subject: parsed[1], catalog_nbr: parsed[2] } : null);
  if (!course) throw new Error(`El código de materia vigilada no es válido: ${courseCode}`);

  // Con campus elegido, el watcher sigue costando UNA navegación (la misma de
  // siempre) y además vuelve con el campus dicho por el portal. Sin campus
  // elegido no se pagan tres búsquedas por materia vigilada: se consulta sin
  // filtrar y el campus queda inferido o ausente.
  const prefix = portalCatalogNbr({ subject: course.subject, catalogNbr: course.catalog_nbr });
  const { exceeds, courses } = await searchByPrefix(page, { term, career, prefix, campus });
  if (exceeds) {
    throw new Error(`La búsqueda de ${courseCode} excedió el límite del portal; hace falta un selector más preciso`);
  }

  const subjects = knownSubjects();
  const exact = courses.filter((row) => {
    const code = splitCourseCode(row.rawNbr, { subjectHint: row.subjectFromHeader, knownSubjects: subjects });
    return code && courseCodeToString(code) === courseCode;
  });
  const saved = persist(exact, { term, career, campus });
  logSync({ kind: 'watcher', term, status: 'ok', detail: courseCode, rows: saved });
  return { saved };
}
