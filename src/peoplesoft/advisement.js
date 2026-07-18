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

// ── Parser v2: el árbol de requisitos ──────────────────────────────────────
//
// parseAdvisement (arriba) aplana el informe a una lista de materias y tira los
// encabezados de grupo. Eso perdía la estructura que el portal SÍ da y que la
// app necesita: el informe organiza todo como un árbol
//
//   Pénsum 2020 (raíz)
//     └ Año N Período M            (período; Satisfied / Not Satisfied)
//         ├ Cursos Obligatorios    (las que hay que cursar sí o sí)
//         └ Electiva de X          (un slot: elegís 1 de una lista de candidatas)
//
// El anidamiento NO está en la contención del DOM (los GROUPBOX son casi todos
// hermanos), sino en la PROFUNDIDAD del header dentro del documento: contra el
// fixture real la raíz vive a 45 ancestros, los períodos a 54 y los subgrupos a
// 72. Los números absolutos dependen del pénsum; lo que importa es el orden
// relativo, así que el árbol se arma con una pila por profundidad, no con
// umbrales fijos.
//
// Semántica de electivas (la clave del punto 3 del plan): una electiva
// SATISFECHA el portal la pinta colapsada — sus candidatas ni entran al DOM —,
// mientras que una PENDIENTE viene expandida con su header y su lista de
// candidatas. O sea el propio informe ya oculta las candidatas de lo que ya
// elegiste; solo hay que respetarlo y no inflar el pénsum con ellas.

// Corre en el browser (evaluate): camina el documento en orden y emite un
// registro por cada cosa que importa, con su profundidad. Interpretarlos y
// armar el árbol es trabajo de node (parseAdvisementTree), que es como se
// prueba contra el fixture sin portal.
export function extractAdvisementTree() {
  const strip = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const depthOf = (el) => {
    let d = 0;
    for (let p = el.parentElement; p; p = p.parentElement) d++;
    return d;
  };

  const records = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let node;
  while ((node = walker.nextNode())) {
    // Header de grupo: <strong>Satisfied/Not Satisfied</strong> LABEL
    if (node.tagName === 'STRONG' && /atisfied/i.test(node.textContent)) {
      const span = node.closest('span') || node.parentElement;
      const strongTxt = strip(node);
      const label = strip(span).replace(strongTxt, '').trim();
      records.push({ type: 'header', depth: depthOf(node), satisfied: !/Not/i.test(strongTxt), label });
      continue;
    }
    // Contadores del grupo: <ul><li>Units: … required, … taken, … needed</li>…
    if (node.tagName === 'UL' && /required/i.test(node.textContent)) {
      records.push({ type: 'counters', depth: depthOf(node), text: strip(node) });
      continue;
    }
    // Fila de curso (misma trampa invertida que parseAdvisement: el elemento ES
    // el $span$). El estado/nota/término se leen por id como en extractAdvisement.
    if (node.tagName === 'SPAN' && node.id && node.id.startsWith('CRSE_NAME$span$')) {
      const i = node.id.split('$').pop();
      const img = document.querySelector(`[id="win0divCRSE_STAT$${i}"] img`);
      records.push({
        type: 'course',
        depth: depthOf(node),
        rawName: strip(node),
        title: strip(document.getElementById(`CRSE_DESCR$${i}`)) || null,
        units: strip(document.getElementById(`CRSE_UNITS$${i}`)) || null,
        when: strip(document.getElementById(`CRSE_WHEN$${i}`)) || null,
        grade: strip(document.getElementById(`SAA_ACRSE_AVLVW_CRSE_GRADE_OFF$${i}`)) || null,
        statusAlt: img ? img.getAttribute('alt') : null,
        statusSrc: img ? img.getAttribute('src') : null,
      });
      continue;
    }
    // Slot de electiva COLAPSADO (= satisfecho): el link de expandir de un
    // GROUPBOX3. No tiene header ni candidatas en el DOM; capturamos el slot
    // para poder mostrarlo satisfecho, sin candidatas.
    if (
      node.tagName === 'A' &&
      node.id &&
      /^DERIVED_SAA_DPR_GROUPBOX3\$\d+$/.test(node.id) &&
      node.getAttribute('aria-expanded') === 'false'
    ) {
      const label = strip(node.parentElement);
      if (/Electiva/i.test(label)) {
        records.push({ type: 'electiva-collapsed', depth: depthOf(node), label });
      }
    }
  }

  return {
    plan: strip(document.querySelector('[id^="DERIVED_SAA_DPR_DESCR254A"]')) || null,
    generatedAt: (document.body.textContent.match(/generated on ([\d/]+\s+[\d:]+[AP]M)/i) ?? [])[1] ?? null,
    records,
  };
}

// "Units: 212.00 required, 131.00 taken, 81.00 needed  Courses: 64 required…
//  GPA: 2.0 required, 2.8 actual" → números. Algunos grupos no traen la línea
// de GPA; ausente = null, no cero.
function parseCounters(text) {
  const segment = (key, stops) => {
    const re = new RegExp(`${key}:(.*?)(?:${[...stops, '$'].join('|')})`, 'i');
    return (text.match(re) || [])[1] || '';
  };
  const pick = (seg, word) => {
    const m = seg.match(new RegExp(`([\\d.]+)\\s+${word}`, 'i'));
    return m ? Number.parseFloat(m[1]) : null;
  };
  const units = segment('Units', ['Courses:', 'GPA:']);
  const cursos = segment('Courses', ['GPA:']);
  const gpa = segment('GPA', []);
  return {
    unitsRequired: pick(units, 'required'),
    unitsTaken: pick(units, 'taken'),
    unitsNeeded: pick(units, 'needed'),
    coursesRequired: pick(cursos, 'required'),
    coursesTaken: pick(cursos, 'taken'),
    coursesNeeded: pick(cursos, 'needed'),
    gpaActual: pick(gpa, 'actual'),
  };
}

function classifyGroup(label, hasParent) {
  if (!hasParent) return 'root';
  if (/Año\s+\d+\s+Período\s+\d+/i.test(label)) return 'periodo';
  if (/Electiva/i.test(label)) return 'electiva';
  if (/Obligatori/i.test(label)) return 'obligatorios';
  return 'grupo';
}

// Una fila de curso del informe → materia con código canónico. Misma regla que
// parseAdvisement, extraída para que el árbol y la lista plana coincidan.
function parseCourseRow(row, subjects) {
  const m = (row.rawName ?? '').match(/^([A-Z0-9-]{1,6})\s+(\S+)$/);
  if (!m) return null;
  const code = splitCourseCode(m[2], { subjectHint: m[1], knownSubjects: subjects });
  if (!code) return null;
  const units = Number.parseFloat(row.units);
  return {
    code: courseCodeToString(code),
    subject: code.subject,
    catalogNbr: code.catalogNbr,
    title: row.title || null,
    units: Number.isFinite(units) ? units : null,
    status: normalizeStatus(row),
    takenTerm: row.when || null,
    grade: row.grade || null,
  };
}

const EMPTY_COUNTERS = {
  unitsRequired: null, unitsTaken: null, unitsNeeded: null,
  coursesRequired: null, coursesTaken: null, coursesNeeded: null, gpaActual: null,
};

// Arma el árbol de requisitos a partir de los registros ordenados. Devuelve
// grupos planos (con parentId por posición), sus cursos, y el perfil que sale
// de la raíz. `position` es el orden del documento: la verdad sobre la
// secuencia aunque otro pénsum renombre las etiquetas (§14).
export function parseAdvisementTree(raw, { knownSubjects: subjects = [] } = {}) {
  const groups = [];
  const stack = [];
  let currentGroup = null;
  let pos = 0;

  for (const rec of raw.records) {
    if (rec.type === 'header') {
      while (stack.length && stack[stack.length - 1].depth >= rec.depth) stack.pop();
      const parent = stack[stack.length - 1] || null;
      const kind = classifyGroup(rec.label, Boolean(parent));
      const ym = rec.label.match(/Año\s+(\d+)\s+Período\s+(\d+)/i);
      const group = {
        position: pos++,
        depth: rec.depth,
        kind,
        label: rec.label,
        satisfied: rec.satisfied,
        year: ym ? Number(ym[1]) : null,
        period: ym ? Number(ym[2]) : null,
        counters: null,
        collapsed: false,
        parent,
        courses: [],
      };
      groups.push(group);
      stack.push(group);
      currentGroup = group;
    } else if (rec.type === 'counters') {
      if (currentGroup && !currentGroup.counters) currentGroup.counters = parseCounters(rec.text);
    } else if (rec.type === 'course') {
      if (!currentGroup) continue;
      const parsed = parseCourseRow(rec, subjects);
      if (parsed) currentGroup.courses.push({ ...parsed, isCandidate: currentGroup.kind === 'electiva' });
    } else if (rec.type === 'electiva-collapsed') {
      // Slot satisfecho: cuelga del período abierto, sin candidatas.
      let periodo = null;
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].kind === 'periodo') { periodo = stack[k]; break; }
      }
      groups.push({
        position: pos++,
        depth: (periodo ? periodo.depth : 0) + 2,
        kind: 'electiva',
        label: rec.label,
        satisfied: true,
        year: periodo ? periodo.year : null,
        period: periodo ? periodo.period : null,
        counters: null,
        collapsed: true,
        parent: periodo || stack[stack.length - 1] || null,
        courses: [],
      });
    }
  }

  const flatGroups = groups.map((g) => ({
    id: g.position,
    parentId: g.parent ? g.parent.position : null,
    kind: g.kind,
    label: g.label,
    satisfied: g.satisfied,
    year: g.year,
    period: g.period,
    position: g.position,
    collapsed: g.collapsed,
    ...(g.counters || EMPTY_COUNTERS),
  }));

  const flatCourses = [];
  for (const g of groups) {
    for (const c of g.courses) flatCourses.push({ groupId: g.position, ...c });
  }

  return { profile: profileFromTree(groups), groups: flatGroups, courses: flatCourses };
}

// El perfil sale de la raíz: "Pénsum No. 2020 de INGENIERÍA EN CIENCIAS DE LA
// COMPUTACIÓN" → número de pénsum + carrera. La cohorte (primer término con
// notas) la aporta grades, no el informe: se llena en el save.
function profileFromTree(groups) {
  const root = groups.find((g) => g.kind === 'root');
  if (!root) return null;
  const m = root.label.match(/Pénsum\s+No\.?\s*(\S+)\s+de\s+(.+)/i);
  return {
    career: m ? m[2].trim() : null,
    pensumNo: m ? m[1].trim() : null,
    planLabel: root.label,
  };
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

// El informe lista la misma materia en varios bloques de requisito, así que el
// pensum trae duplicados por código (en la corrida del 16/7: 98 filas → 84
// materias). Colapsarlos con "el último gana" es peligroso: una materia ya
// aprobada puede reaparecer como candidata de una electiva y ahí viene SIN
// icono de estado, o sea pending. Si esa copia pisa a la aprobada, la app te
// manda a inscribir algo que ya cursaste — y de paso borra la nota. Entre
// duplicados gana el estado más avanzado, no el último.
const STATUS_PRECEDENCE = ['pending', 'planned', 'in_progress', 'taken'];

export function mergeDuplicateCourses(courses) {
  const byCode = new Map();
  for (const course of courses) {
    const seen = byCode.get(course.code);
    if (!seen) {
      byCode.set(course.code, { ...course });
      continue;
    }
    if (STATUS_PRECEDENCE.indexOf(course.status) > STATUS_PRECEDENCE.indexOf(seen.status)) {
      seen.status = course.status;
    }
    // La nota y el término los aporta el bloque que la cursó; la copia
    // candidata los trae vacíos y no puede borrarlos.
    seen.grade ??= course.grade;
    seen.takenTerm ??= course.takenTerm;
    seen.units ??= course.units;
    seen.title ??= course.title;
  }
  return [...byCode.values()];
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
  const merged = mergeDuplicateCourses(courses);
  for (const c of merged) {
    upsertPensumStmt.run(c.code, c.subject, c.catalogNbr, c.units, c.status, c.takenTerm, c.grade);
  }
  return merged;
}

export function readPensum() {
  return db.prepare('SELECT * FROM pensum ORDER BY code').all();
}

// Lo que falta cursar: la lista corta que de verdad importa al inscribirse.
export function pendingCourses() {
  return db.prepare("SELECT code FROM pensum WHERE status = 'pending' ORDER BY code").all().map((r) => r.code);
}
