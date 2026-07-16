import { BROWSE_CATALOG_URL } from './constants.js';
import { db, logSync } from '../db.js';
import { splitCourseCode } from '../shared/courseCode.ts';

// Browse Course Catalog — la fuente del diccionario código→título.
//
// El Class Search (catalog.js) da secciones, cupos y horarios, pero su header
// de grupo trae el título vacío ("ICC     ICC321 - "). Esta pantalla, hermana
// suya en la misma carpeta del portal, da lo contrario: títulos y la lista de
// subjects, pero nada de secciones. Se unen por el código de la materia.
//
// Confirmado contra HTML real (fixtures/recon-browse-ICC-expanded.html):
//   1. Los subjects viven bajo pestañas por letra inicial; cada uno es un
//      <a id="DERIVED_SSS_BCC_GROUP_BOX_1$147$$N"> con label "ICC - ICC"
//      (PUCMM no llenó la descripción del subject: repite el código).
//   2. Los cursos de un subject solo existen en el DOM tras expandirlo por
//      AJAX. Ahí aparecen CRSE_NBR$N ("ICC223") y CRSE_TITLE$N ("Bases de
//      Datos") — una fila por materia.
//   3. Esta pantalla NO tiene el límite de 50 del Class Search: lista materias,
//      no secciones. Un subject = una expansión, sin trocear.
//
// Es catálogo, no cupo: cambia una vez por término. Sync de fondo, cacheable
// para siempre; nada de esto debe colgar de una petición de la UI.

const upsertCourseTitleStmt = db.prepare(`
  INSERT INTO courses (code, subject, catalog_nbr, title, updated_at)
  VALUES (?, ?, ?, ?, datetime('now'))
  ON CONFLICT(code) DO UPDATE SET
    title = excluded.title,
    updated_at = datetime('now')
`);

// Escribe solo el título: nunca pisa career/credits/secciones, que son del
// Class Search. Las dos fuentes escriben en `courses` sin pisarse.
export function saveCourseTitles(courses) {
  let saved = 0;
  for (const c of courses) {
    if (!c.title) continue;
    upsertCourseTitleStmt.run(`${c.subject}-${c.catalogNbr}`, c.subject, c.catalogNbr, c.title);
    saved++;
  }
  return saved;
}

const upsertSubjectStmt = db.prepare(`
  INSERT INTO subjects (code, description, updated_at)
  VALUES (?, ?, datetime('now'))
  ON CONFLICT(code) DO UPDATE SET
    description = excluded.description,
    updated_at = datetime('now')
`);

export function saveSubjects(subjects) {
  for (const s of subjects) upsertSubjectStmt.run(s.code, s.description ?? null);
  return subjects.length;
}

export function knownSubjects() {
  return db.prepare('SELECT code FROM subjects ORDER BY code').all().map((r) => r.code);
}

async function findFrame(page, selector, { timeout = 10000 } = {}) {
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

// Los extractores corren dentro del browser vía evaluate(), así que no pueden
// cerrar sobre nada del módulo. A cambio se prueban contra el HTML volcado sin
// tocar el portal (scripts/test-browse-parser.mjs).
export function extractSubjects() {
  const subjects = [];
  for (const a of document.querySelectorAll('a[id^="DERIVED_SSS_BCC_GROUP_BOX"]')) {
    const label = a.textContent.replace(/\s+/g, ' ').trim();
    // "ICC - ICC" o "ICC - Ingeniería..." → el código es lo de antes del guion.
    const m = label.match(/^([A-Z0-9-]{1,6})\s+-\s+(.*)$/);
    if (!m) continue;
    if (!subjects.some((s) => s.code === m[1])) {
      subjects.push({ code: m[1], description: m[2].trim() });
    }
  }
  return subjects;
}

// Devuelve las filas en crudo (el código tal cual lo pinta el portal). Partir
// el código en subject + número es trabajo de splitCourseCode, en node: correr
// acá dentro obligaría a duplicar esa regla en el browser, y es justamente la
// que tiene que ser idéntica a la del Class Search.
export function extractCourses() {
  // Filtrar por id exacto: el prefijo también agarra el wrapper
  // <span id="CRSE_NBR$span$N"> y duplicaría cada fila. Misma trampa que en
  // el Class Search con MTG_CLASS_NBR$span$N.
  const cells = (prefix) =>
    [...document.querySelectorAll(`[id^="${prefix}$"]`)]
      .filter((el) => new RegExp(`^${prefix}\\$\\d+$`).test(el.id))
      .map((el) => [el.id.split('$')[1], el.textContent.replace(/\s+/g, ' ').trim()]);

  const titles = new Map(cells('CRSE_TITLE'));
  return cells('CRSE_NBR')
    .map(([i, rawNbr]) => ({ rawNbr, title: titles.get(i) ?? null }))
    .filter((row) => row.rawNbr && row.title);
}

export function parseCourseRows(rows, { subject, knownSubjects }) {
  const courses = [];
  for (const row of rows) {
    const code = splitCourseCode(row.rawNbr, { subjectHint: subject, knownSubjects });
    // Sin código no hay llave para unir con las secciones: mejor perder el
    // título que inventarse un código que no empate con el Class Search.
    if (!code) continue;
    courses.push({ ...code, title: row.title });
  }
  return courses;
}

async function openBrowseCatalog(page) {
  await page.goto(BROWSE_CATALOG_URL, { waitUntil: 'commit' });
  await page.waitForTimeout(6000);
  return findFrame(page, '[id="ICStateNum"]');
}

// Un subject vive bajo la pestaña de su letra inicial; la landing abre en "A".
async function openLetter(page, letter) {
  const frame = await findFrame(page, 'a[id^="DERIVED_SSS_BCC_SSR_ALPHANUM"]');
  const tab = frame.locator('a[id^="DERIVED_SSS_BCC_SSR_ALPHANUM"]').filter({ hasText: new RegExp(`^${letter}$`) });
  if ((await tab.count()) === 0) return frame; // ya estamos en esa letra
  await tab.first().click();
  await page.waitForTimeout(6000);
  return findFrame(page, '[id="ICStateNum"]');
}

// Recorre las pestañas de letra y devuelve todos los subjects del catálogo.
// Esto es lo que reemplaza cualquier lista de materias hardcodeada.
export async function fetchSubjects(page, { throttleMs = 1500 } = {}) {
  await openBrowseCatalog(page);
  const found = new Map();
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const frame = await openLetter(page, letter);
    for (const s of await frame.evaluate(extractSubjects)) {
      // La pestaña muestra solo los subjects de esa letra, pero filtramos por
      // las dudas: un subject solo cuenta bajo su inicial.
      if (s.code.startsWith(letter)) found.set(s.code, s);
    }
    await page.waitForTimeout(throttleMs);
  }
  const subjects = [...found.values()];
  saveSubjects(subjects);
  logSync({ kind: 'subjects', term: null, status: 'ok', detail: `${subjects.length} subjects`, rows: subjects.length });
  return subjects;
}

// Expande un subject y persiste los títulos de todas sus materias.
export async function syncSubjectTitles(page, { subject, alreadyOpen = false } = {}) {
  if (!alreadyOpen) await openBrowseCatalog(page);
  let frame = await openLetter(page, subject[0]);

  const link = frame.locator('a[id^="DERIVED_SSS_BCC_GROUP_BOX"]').filter({ hasText: new RegExp(`^${subject} - `) });
  if ((await link.count()) === 0) {
    logSync({ kind: 'titles', term: null, status: 'error', detail: `subject ${subject} no existe`, rows: 0 });
    return { saved: 0, courses: [] };
  }
  await link.first().click();
  await page.waitForTimeout(7000);

  frame = await findFrame(page, '[id="ICStateNum"]');
  const rows = await frame.evaluate(extractCourses);
  const courses = parseCourseRows(rows, { subject, knownSubjects: knownSubjects() });
  const saved = saveCourseTitles(courses);
  logSync({ kind: 'titles', term: null, status: 'ok', detail: subject, rows: saved });
  return { saved, courses };
}
