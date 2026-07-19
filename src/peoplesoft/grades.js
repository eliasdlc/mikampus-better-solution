import { db, logSync } from '../db.js';
import { splitCourseCode, courseCodeToString } from '../shared/courseCode.ts';
import { summarizeGrades, termSortKey } from '../shared/gpa.ts';
import { knownSubjects } from './browseCatalog.js';
import { scrapedCourseHistorySchema } from '../shared/schemas.ts';

// Notas e índice académico, leídos de My Course History.
//
// Confirmado contra HTML real (fixtures/recon-course-history.html y
// recon-grades-past.html):
//
//   1. Course History lista TODO el histórico —52 materias, 10 términos— con
//      código, título, término, nota, créditos y estado, en UNA pantalla. Es
//      la fuente: recorrer View My Grades término por término serían 10 cargas
//      para los mismos datos.
//   2. No se llega por URL. Adivinar el componente (SS_MY_CRSEHIST.GBL)
//      devuelve "You are not authorized for this page": el acceso es el
//      dropdown "Academics" del Centro del Alumnado, opción 2050 + botón GO.
//   3. El estado sale del alt del icono: Taken / In Progress / Transferred.
//      Sin nota y "In Progress" = cursando ahora.
//   4. El índice NO se scrapea de acá: Course History no trae grade points.
//      Se calcula con shared/gpa.ts, que reproduce exactamente los totales que
//      el portal publica (ver test-grades-parser.mjs).

export const STUDENT_CENTER_URL =
  'https://micampus.pucmm.edu.do/psp/cs92pro/EMPLOYEE/SA/c/SA_LEARNER_SERVICES.SSS_STUDENT_CENTER.GBL?Page=SSS_STUDENT_CENTER&Action=U';

export const MORE_ACADEMICS_SELECT = 'DERIVED_SSS_SCL_SSS_MORE_ACADEMICS';
export const COURSE_HISTORY_OPTION = '2050';

// View My Grades: no da las notas de todos los términos (abre en el que está
// en curso), pero sí publica los totales que la universidad calcula. Se leen
// para contrastarlos con los nuestros — ver checkAgainstPortal.
export const GRADES_URL =
  'https://micampus.pucmm.edu.do/psp/cs92pro/EMPLOYEE/SA/c/SA_LEARNER_SERVICES.SSR_SSENRL_GRADE.GBL?FolderPath=PORTAL_ROOT_OBJECT.CO_EMPLOYEE_SELF_SERVICE.HCCC_ENROLLMENT.HC_SSR_SSENRL_GRADE_GBL&IsFolder=false&IgnoreParamTempl=FolderPath%2cIsFolder';

// Corre dentro del browser vía evaluate(): no puede cerrar sobre nada del
// módulo. Devuelve filas crudas; interpretarlas es trabajo de node, que es lo
// que permite probar el parser contra el fixture sin portal.
export function extractCourseHistory() {
  const strip = (el) => (el ? el.textContent.replace(/\s+/g, ' ').replace(/ /g, ' ').trim() : null);

  const rows = [];
  // Regex exacto de id: `[id^="CRSE_NAME$"]` también atraparía los wrappers
  // CRSE_NAME$span$N y duplicaría cada fila (la trampa del class search).
  for (const el of document.querySelectorAll('[id]')) {
    const m = el.id.match(/^CRSE_NAME\$(\d+)$/);
    if (!m) continue;
    const i = m[1];
    const img = document.querySelector(`[id="win0divCRSE_STATUS$${i}"] img`);
    rows.push({
      rawName: strip(el),
      title: strip(document.getElementById(`CRSE_LINK$span$${i}`)) || strip(document.getElementById(`CRSE_LINK$${i}`)),
      term: strip(document.getElementById(`CRSE_TERM$${i}`)),
      grade: strip(document.getElementById(`CRSE_GRADE$${i}`)) || null,
      units: strip(document.getElementById(`CRSE_UNITS$${i}`)),
      statusAlt: img ? img.getAttribute('alt') : null,
      statusSrc: img ? img.getAttribute('src') : null,
    });
  }
  return { rows };
}

function normalizeStatus({ statusAlt, statusSrc }) {
  const hay = `${statusAlt ?? ''} ${statusSrc ?? ''}`.toUpperCase();
  if (/IN.?PROGRESS|ENROLLED/.test(hay)) return 'in_progress';
  if (/TRANSFER/.test(hay)) return 'transferred';
  return 'taken';
}

export function parseCourseHistory(rows, { knownSubjects: subjects = [] } = {}) {
  const courses = [];
  for (const row of rows) {
    // "ICC ICC302" → subject del listado + código crudo. La misma regla que el
    // class search, el browse catalog y el advisement: el código canónico tiene
    // que salir idéntico de las cuatro pantallas o no se pueden cruzar.
    const m = (row.rawName ?? '').match(/^([A-Z0-9-]{1,6})\s+(\S+)$/);
    if (!m) continue;
    const code = splitCourseCode(m[2], { subjectHint: m[1], knownSubjects: subjects });
    if (!code) continue;

    const units = Number.parseFloat(row.units);
    courses.push({
      code: courseCodeToString(code),
      subject: code.subject,
      catalogNbr: code.catalogNbr,
      title: row.title || null,
      term: row.term || null,
      grade: row.grade || null,
      units: Number.isFinite(units) ? units : null,
      status: normalizeStatus(row),
    });
  }
  return scrapedCourseHistorySchema.parse({ courses }).courses;
}

// ── Los totales que publica el portal ───────────────────────────────────────
// La tabla "Term Statistics" de View My Grades, con dos columnas: el término
// (STATS_ENRL) y el acumulado (STATS_CUMS).
//
// No se puede leer por índice fijo. Las filas se corren según lo que exista:
// "In Progress" solo aparece si hay créditos en curso, así que "= GPA" cae en
// el índice 13 en el término en curso y en el 12 en uno cerrado. Leer
// STATS_CUMS$13 a ciegas devuelve el número de otra fila.
export function extractGradeStats() {
  const strip = (el) => (el ? el.textContent.replace(/\s+/g, ' ').replace(/ /g, ' ').trim() : '');

  const rows = [];
  for (const el of document.querySelectorAll('[id]')) {
    const m = el.id.match(/^DERIVED_SSS_GRD_DESCR1\$(\d+)$/);
    if (!m) continue;
    const i = m[1];
    rows.push({
      label: strip(el),
      enrl: strip(document.getElementById(`STATS_ENRL$${i}`)),
      cums: strip(document.getElementById(`STATS_CUMS$${i}`)),
    });
  }

  // El término titula el bloque ("Class Grades - Enero de 2026"). Acá el
  // encabezado es .PSGROUPBOXLABEL — .PAGROUPDIVIDER es de otras pantallas.
  const heading = [...document.querySelectorAll('.PSGROUPBOXLABEL')]
    .map((e) => e.textContent.replace(/\s+/g, ' ').replace(/ /g, ' ').trim())
    .find((t) => /class grades/i.test(t));

  return { termLabel: (heading ?? '').replace(/^class grades\s*-\s*/i, '') || null, rows };
}

const num = (raw) => {
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
};

// "Taken" y "Passed" aparecen DOS veces: una bajo "Units Toward GPA:" y otra
// bajo "Units Not for GPA:". Emparejar por etiqueta suelta mezcla las dos y
// mete al índice créditos que la universidad no cuenta. La sección se arrastra
// mientras se recorren las filas en orden.
export function parseGradeStats({ termLabel, rows }) {
  const term = {};
  const cumulative = {};
  let section = null;

  const put = (key, row) => {
    term[key] = num(row.enrl);
    cumulative[key] = num(row.cums);
  };

  for (const row of rows) {
    const label = row.label.toLowerCase().replace(/\s+/g, ' ').trim();
    // Los encabezados de sección llevan dos puntos; "/ Units Taken Toward GPA"
    // no, y por eso no se confunde con el encabezado "Units Toward GPA:".
    if (/^units toward gpa:$/.test(label)) {
      section = 'gpa';
      continue;
    }
    if (/^units not for gpa:$/.test(label)) {
      section = 'notForGpa';
      continue;
    }
    if (/^gpa calculation$/.test(label)) {
      section = 'calc';
      continue;
    }

    if (section === 'gpa') {
      if (label === 'taken') put('unitsTowardGpa', row);
      else if (label === 'passed') put('unitsPassed', row);
      else if (label === 'in progress') put('unitsInProgress', row);
    } else if (section === 'calc') {
      if (label === 'total grade points') put('gradePoints', row);
      else if (label === '= gpa') put('gpa', row);
    }
  }

  return { termLabel: termLabel ?? null, term, cumulative };
}

// El índice de mikampus se calcula; el del portal se lee. Si no coinciden, la
// universidad cambió una regla (la escala, qué nota cuenta, cómo trata una
// repetida) y todo lo que dependa del cálculo —el what-if incluido— está
// mintiendo. Mejor decirlo que mostrar un número plausible y falso.
//
// Los créditos y los puntos tienen que dar EXACTO. El índice se compara con
// tolerancia porque el portal lo publica con un decimal de precisión: dice
// 2.800 donde 402/143 da 2.8112.
export function checkAgainstPortal(computed, portalCumulative) {
  const mismatches = [];
  for (const key of ['unitsTowardGpa', 'gradePoints', 'unitsPassed']) {
    const mine = computed[key];
    const theirs = portalCumulative[key];
    if (theirs === null || theirs === undefined) continue;
    if (Math.abs(mine - theirs) > 0.001) mismatches.push(`${key}: mikampus ${mine} vs portal ${theirs}`);
  }
  if (computed.gpa !== null && portalCumulative.gpa !== null && portalCumulative.gpa !== undefined) {
    if (Math.abs(computed.gpa - portalCumulative.gpa) > 0.05) {
      mismatches.push(`gpa: mikampus ${computed.gpa.toFixed(3)} vs portal ${portalCumulative.gpa}`);
    }
  }
  return mismatches;
}

// Las notas agrupadas por término, del más reciente al más viejo, con el
// índice de cada uno. Es lo que dibuja el tab Notas y el sparkline.
export function termSummaries(courses) {
  const byTerm = new Map();
  for (const c of courses) {
    if (!c.term) continue;
    if (!byTerm.has(c.term)) byTerm.set(c.term, []);
    byTerm.get(c.term).push(c);
  }

  const terms = [...byTerm.entries()].map(([term, termCourses]) => ({
    term,
    sortKey: termSortKey(term),
    courses: termCourses,
    ...summarizeGrades(termCourses),
  }));

  // Del más reciente al más viejo. Los que no parsean van al final en vez de
  // ensuciar el orden de los que sí.
  return terms.sort((a, b) => {
    if (a.sortKey === null) return 1;
    if (b.sortKey === null) return -1;
    return b.sortKey.localeCompare(a.sortKey);
  });
}

async function findFrame(page, selector, { timeout = 30000 } = {}) {
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

// El histórico completo del estudiante. Dos cargas: Course History trae las
// materias con su nota, y View My Grades los totales del portal para
// contrastar los nuestros. userId dice de quién es la sesión que scrapea — el
// rastro en sync_log es personal.
export async function fetchGrades(page, { userId }) {
  await page.goto(STUDENT_CENTER_URL, { waitUntil: 'commit' });
  await page.waitForTimeout(7000);

  let frame = await findFrame(page, `[id="${MORE_ACADEMICS_SELECT}"]`);
  await frame.locator(`[id="${MORE_ACADEMICS_SELECT}"]`).selectOption(COURSE_HISTORY_OPTION);
  // El dropdown no navega solo: hay un botón GO al lado.
  await frame.locator('[id^="DERIVED_SSS_SCL_SSS_GO"]').first().click();
  await page.waitForTimeout(9000);

  frame = await findFrame(page, '[id^="CRSE_NAME$"]');
  const raw = await frame.evaluate(extractCourseHistory);
  const courses = parseCourseHistory(raw.rows, { knownSubjects: knownSubjects() });
  const summary = summarizeGrades(courses);

  await page.goto(GRADES_URL, { waitUntil: 'commit' });
  await page.waitForTimeout(7000);
  frame = await findFrame(page, '[id^="DERIVED_SSS_GRD_DESCR1$"]');
  const portal = parseGradeStats(await frame.evaluate(extractGradeStats));

  const mismatches = checkAgainstPortal(summary, portal.cumulative);
  logSync({
    userId,
    kind: 'grades',
    term: null,
    status: mismatches.length ? 'error' : 'ok',
    detail: mismatches.length ? `el índice no cuadra con el portal — ${mismatches.join('; ')}` : 'course history',
    rows: courses.length,
  });

  return { courses, terms: termSummaries(courses), summary, portal, mismatches };
}

const insertGradeStmt = db.prepare(`
  INSERT INTO grades (user_id, term, course_code, subject, catalog_nbr, title, grade, credits, status, captured_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
`);

// El histórico de UN usuario se reemplaza entero en cada sync: el portal es la
// verdad, y las notas cambian de valor (una materia en curso pasa a calificada)
// en vez de solo agregarse. Un upsert por código tampoco serviría — una materia
// repetida existe dos veces, con términos distintos.
export function saveGrades(userId, courses) {
  db.prepare('DELETE FROM grades WHERE user_id = ?').run(userId);
  for (const c of courses) {
    insertGradeStmt.run(userId, c.term, c.code, c.subject, c.catalogNbr, c.title, c.grade, c.units, c.status);
  }
  return courses;
}

// Nota publicada desde el último sync: antes no había calificación para esa
// materia/término y ahora sí. Un histórico vacío es onboarding, no 46 noticias.
export function diffPublishedGrades(previous, incoming) {
  if (!previous.length) return [];
  const known = new Map(previous.map((course) => [`${course.term ?? ''}\0${course.code}`, course]));
  return incoming.filter((course) => {
    if (!course.grade) return false;
    const old = known.get(`${course.term ?? ''}\0${course.code}`);
    return !old || !old.grade;
  });
}

export function readGrades(userId) {
  return db
    .prepare(
      `SELECT term, course_code AS code, subject, catalog_nbr AS catalogNbr,
              title, grade, credits AS units, status
       FROM grades WHERE user_id = ?`
    )
    .all(userId);
}
