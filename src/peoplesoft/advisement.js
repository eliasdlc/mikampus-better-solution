import { db, logSync } from '../db.js';
import { splitCourseCode, courseCodeToString } from '../shared/courseCode.ts';
import { knownSubjects } from './browseCatalog.js';

// My Academic Requirements — el informe de avance de carrera (el mismo que la
// Dirección del Registro emite como PDF "Reporte Orientación Académica").
//
// Es la fuente de QUÉ materias le importan al estudiante. Sin esto habría que
// mantener a mano la lista de subjects de su pensum, que envejece en silencio
// cada vez que la universidad cambia el plan, renombra una materia o agrega
// una electiva. Con esto, el pensum se re-lee del portal como todo lo demás.
//
// Confirmado contra HTML real (fixtures/recon-advisement.html):
//   1. Se llega por My Academics → "View my advisement report"
//      (a#DERIVED_SSSACA2_SS_DEG_PROG_LINK). El informe se genera al vuelo y
//      tarda: hay que esperarlo de verdad, no con el timeout de una nav normal.
//   2. Cada curso es una fila SAA_ACRSE_AVLVW ("Available Course View"), y
//      lista tanto lo cursado como lo que falta.
//   3. OJO, al revés que en el class search: acá el elemento ES el $span$
//      (existe CRSE_NAME$span$12 pero NO CRSE_NAME$12). Para CRSE_DESCR
//      existen los dos y valen lo mismo. El índice arranca en 12, no en 0.
//   4. Acá el `alt` del icono de estado SÍ viene lleno ("Taken"), a diferencia
//      del class search donde había que leer el nombre del gif. Igual se leen
//      los dos: el alt es el dato y el gif la red de seguridad.
//   5. Una fila sin icono de estado es una materia PENDIENTE (ni cursada ni en
//      curso ni planificada) — que es justo la que interesa para inscribirse.
//   6. El informe abre con los bloques YA SATISFECHOS colapsados, y lo colapsado
//      no está en el DOM: sin expandir, el pensum sale incompleto (faltaban las
//      electivas de humanidades ya aprobadas, y con ellas 9 de los 17 subjects).
//      Por eso se pulsa "Expand All" antes de leer.

export const ADVISEMENT_LINK = 'DERIVED_SSSACA2_SS_DEG_PROG_LINK';
export const EXPAND_ALL_LINK = 'DERIVED_SAA_DPR_SSS_EXPAND_ALL';

export const MY_ACAD_URL =
  'https://micampus.pucmm.edu.do/psc/cs92pro/EMPLOYEE/SA/c/SA_LEARNER_SERVICES.SSS_MY_ACAD.GBL?Page=SSS_MY_ACAD&Action=U';

// Corre dentro del browser vía evaluate(): no puede cerrar sobre nada del
// módulo. Devuelve las filas en crudo; interpretarlas es trabajo de node
// (parseAdvisement), que es como se prueba contra el fixture sin portal.
export function extractAdvisement() {
  const strip = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);

  const rows = [];
  for (const el of document.querySelectorAll('[id^="CRSE_NAME$span$"]')) {
    const i = el.id.split('$').pop();
    const img = document.querySelector(`[id="win0divCRSE_STAT$${i}"] img`);
    rows.push({
      rawName: strip(el),
      title: strip(document.getElementById(`CRSE_DESCR$${i}`)),
      units: strip(document.getElementById(`CRSE_UNITS$${i}`)),
      when: strip(document.getElementById(`CRSE_WHEN$${i}`)) || null,
      grade: strip(document.getElementById(`SAA_ACRSE_AVLVW_CRSE_GRADE_OFF$${i}`)) || null,
      statusAlt: img ? img.getAttribute('alt') : null,
      statusSrc: img ? img.getAttribute('src') : null,
    });
  }

  return {
    plan: strip(document.querySelector('[id^="DERIVED_SAA_DPR_DESCR254A"]')),
    generatedAt: (document.body.textContent.match(/generated on ([\d/]+\s+[\d:]+[AP]M)/i) ?? [])[1] ?? null,
    rows,
  };
}

// "Taken" / "In Progress" / "Planned" salen del alt; el gif
// (PS_CS_CREDIT_TAKEN_ICN_1.gif) confirma. Sin icono = pendiente.
function normalizeStatus({ statusAlt, statusSrc }) {
  const hay = `${statusAlt ?? ''} ${statusSrc ?? ''}`.toUpperCase();
  if (/IN.?PROGRESS|ENROLL/.test(hay)) return 'in_progress';
  if (/PLANNED|PLAN_/.test(hay)) return 'planned';
  if (/TAKEN|CREDIT/.test(hay)) return 'taken';
  return 'pending';
}

export function parseAdvisement(rows, { knownSubjects: subjects = [] } = {}) {
  const courses = [];
  for (const row of rows) {
    // "FIS 1FIS139" → subject del informe + código crudo. La misma regla que el
    // class search y el browse catalog: el código canónico tiene que salir
    // idéntico de las tres pantallas o no se pueden cruzar.
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
      units: Number.isFinite(units) ? units : null,
      status: normalizeStatus(row),
      takenTerm: row.when || null,
      grade: row.grade || null,
    });
  }
  return courses;
}

// Los subjects del pensum, que es lo que decide qué barrer del catálogo.
export function subjectsFromAdvisement(courses) {
  return [...new Set(courses.map((c) => c.subject))].sort();
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

// Abre el informe y devuelve el pensum del estudiante con su estado.
export async function fetchAdvisement(page) {
  await page.goto(MY_ACAD_URL, { waitUntil: 'commit' });
  await page.waitForTimeout(7000);

  let frame = await findFrame(page, `[id="${ADVISEMENT_LINK}"]`);
  await frame.locator(`[id="${ADVISEMENT_LINK}"]`).first().click();
  // El informe se recalcula del lado del servidor; 15s no es paranoia.
  await page.waitForTimeout(15000);

  // Sin esto el pensum sale a medias: lo satisfecho abre colapsado y no existe
  // en el DOM. Es una sola llamada que rearma el informe entero → es lenta.
  frame = await findFrame(page, `[id="${EXPAND_ALL_LINK}"]`);
  await frame.locator(`[id="${EXPAND_ALL_LINK}"]`).first().click();
  await page.waitForTimeout(12000);

  frame = await findFrame(page, '[id^="CRSE_NAME$span$"]');
  const raw = await frame.evaluate(extractAdvisement);
  const courses = parseAdvisement(raw.rows, { knownSubjects: knownSubjects() });

  logSync({ kind: 'advisement', term: null, status: 'ok', detail: raw.plan ?? 'pensum', rows: courses.length });
  return { ...raw, courses, subjects: subjectsFromAdvisement(courses) };
}

// Guarda el pensum: qué materias exige la carrera y en qué va el estudiante.
// Sin `title` acá — el título es del catálogo (browseCatalog) y esta tabla no
// tiene por qué competir con él.
const upsertPensumStmt = db.prepare(`
  INSERT INTO pensum (code, subject, catalog_nbr, units, status, taken_term, grade, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(code) DO UPDATE SET
    units = excluded.units,
    status = excluded.status,
    taken_term = excluded.taken_term,
    grade = excluded.grade,
    updated_at = datetime('now')
`);

export function savePensum(courses) {
  for (const c of courses) {
    upsertPensumStmt.run(c.code, c.subject, c.catalogNbr, c.units, c.status, c.takenTerm, c.grade);
  }
  return courses.length;
}

export function readPensum() {
  return db.prepare('SELECT * FROM pensum ORDER BY code').all();
}

// Lo que falta cursar: la lista corta que de verdad importa al inscribirse.
export function pendingCourses() {
  return db.prepare("SELECT code FROM pensum WHERE status = 'pending' ORDER BY code").all().map((r) => r.code);
}
