import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import {
  extractAdvisement,
  parseAdvisement,
  subjectsFromAdvisement,
  mergeDuplicateCourses,
} from '../src/peoplesoft/advisement.js';

// Corre el parser del advisement report contra HTML real volcado del portal,
// sin tocarlo. Misma red que los otros parsers: si PeopleSoft cambia los IDs,
// esto falla antes que un sync en vivo.
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(await readFile('fixtures/recon-advisement.html', 'utf8'));

const raw = await page.evaluate(extractAdvisement);
assert.equal(raw.rows.length, 63, '63 filas de curso en el informe');

// La trampa invertida: acá el elemento ES el $span$ (no existe CRSE_NAME$12).
// Si alguien "arregla" el selector copiando el patrón del class search, esto
// se va a cero y el test lo canta.
assert.ok(
  raw.rows.every((r) => r.rawName),
  'toda fila trae el código; el selector $span$ es el correcto acá'
);

const courses = parseAdvisement(raw.rows, { knownSubjects: ['ICC', 'FIS', 'MAT', 'ILE', 'ITT', 'GFA', 'FIL'] });
assert.equal(courses.length, 63, 'las 63 filas parsean');

const byCode = new Map(courses.map((c) => [c.code, c]));

// El patrón de laboratorio, que en este pensum aparece seis veces: la teoría y
// su lab son materias distintas y no pueden colapsar en el mismo código.
const teoria = byCode.get('FIS-139');
const lab = byCode.get('FIS-1FIS139');
assert.ok(teoria && lab, 'FIS139 y 1FIS139 conviven como códigos distintos');
assert.equal(teoria.title, 'Mecánica Newtoniana');
assert.equal(lab.title, 'Lab. FIS-139');

// El estado sale del alt del icono (acá SÍ viene lleno, al revés que el class
// search) y una fila sin icono es una materia pendiente.
assert.equal(lab.status, 'taken', 'el lab está cursado');
assert.equal(lab.grade, 'S');
assert.equal(lab.takenTerm, 'Enero de 2025');
assert.equal(teoria.status, 'pending', 'sin icono de estado = pendiente');
assert.equal(teoria.grade, null, 'una materia pendiente no tiene nota');

const estados = {};
for (const c of courses) estados[c.status] = (estados[c.status] ?? 0) + 1;
assert.ok(estados.taken > 0 && estados.pending > 0, 'el informe mezcla cursadas y pendientes');

// Lo que hace que esto valga: los subjects salen del portal, no de una lista
// escrita a mano.
const subjects = subjectsFromAdvisement(courses);
assert.ok(subjects.includes('ICC') && subjects.includes('FIS'), 'los subjects del pensum salen del informe');
assert.ok(
  subjects.every((s) => /^[A-Z0-9-]{1,6}$/.test(s)),
  'todo subject es un código corto, sin basura del DOM'
);

// El informe repite materias entre bloques de requisito. La copia que aparece
// como candidata de una electiva viene sin icono (= pending) y sin nota: si
// pisa a la aprobada, la app te manda a inscribir algo ya cursado.
const merged = mergeDuplicateCourses([
  { code: 'ICC-201', subject: 'ICC', catalogNbr: '201', title: 'Programación', units: 4,
    status: 'taken', takenTerm: 'Enero de 2025', grade: 'A' },
  { code: 'ICC-201', subject: 'ICC', catalogNbr: '201', title: null, units: null,
    status: 'pending', takenTerm: null, grade: null },
]);
assert.equal(merged.length, 1, 'el duplicado colapsa en un solo código');
assert.equal(merged[0].status, 'taken', 'gana el estado más avanzado, no el último leído');
assert.equal(merged[0].grade, 'A', 'la copia pendiente no borra la nota');
assert.equal(merged[0].takenTerm, 'Enero de 2025', 'ni el término cursado');

// El orden inverso tiene que dar lo mismo: la precedencia no puede depender de
// en qué bloque del informe apareció primero.
const invertido = mergeDuplicateCourses([
  { code: 'ICC-201', subject: 'ICC', catalogNbr: '201', title: null, units: null,
    status: 'pending', takenTerm: null, grade: null },
  { code: 'ICC-201', subject: 'ICC', catalogNbr: '201', title: 'Programación', units: 4,
    status: 'taken', takenTerm: 'Enero de 2025', grade: 'A' },
]);
assert.equal(invertido[0].status, 'taken', 'la precedencia no depende del orden');
assert.equal(invertido[0].grade, 'A');

// Una materia que de verdad falta sigue pendiente: la precedencia no puede
// "aprobar" nada por su cuenta.
const solaPendiente = mergeDuplicateCourses([
  { code: 'MAT-101', subject: 'MAT', catalogNbr: '101', title: 'Cálculo', units: 4,
    status: 'pending', takenTerm: null, grade: null },
]);
assert.equal(solaPendiente[0].status, 'pending', 'sin duplicado no cambia nada');

// El pensum real: 98 filas → 84 materias, y las 40 aprobadas sobreviven enteras.
const dedup = mergeDuplicateCourses(courses);
assert.ok(dedup.length <= courses.length, 'deduplicar nunca inventa materias');
assert.equal(
  dedup.filter((c) => c.status === 'taken').length,
  courses.filter((c) => c.status === 'taken').length,
  'ninguna materia aprobada se pierde al colapsar duplicados'
);

await browser.close();
console.log(
  `✓ advisement: ${courses.length} materias del pensum, ${subjects.length} subjects (${JSON.stringify(estados)})`
);
console.log(`✓ duplicados del informe: ${courses.length} filas → ${dedup.length} materias, aprobadas intactas`);
