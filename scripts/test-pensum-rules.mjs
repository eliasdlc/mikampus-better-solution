import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parsePensumPlan, canonical, toLines } from '../src/shared/pensumRules.ts';
import { toDownloadUrl, sharePointLinks } from './sync-pensum-rules.mjs';

// El parser del plan académico oficial. El fixture es sintético y reproduce la
// geometría real del reporte del Registro: dos columnas de requisitos cuyo
// significado SOLO se distingue por la posición X.

const LEFT = 20;
const PREREQ = 336; // columna "RequisitosPrevios"
const COREQ = 495; // columna "RequisitosAdicionales"

// El PDF emite Y creciente hacia arriba, así que las líneas bajan restando.
let y = 700;
const items = [];
const line = (parts) => {
  for (const [x, text] of parts) items.push({ page: 1, x, y, text });
  y -= 12;
};

line([[LEFT, 'DIRECCIÓN DEL REGISTRO'], [400, 'Fecha: 03/12/2024']]);
line([[LEFT, 'PLAN ACADÉMICO: ICC-2020 - CARRERA DE INGENIERÍA EN CIENCIAS DE LA COMPUTACIÓN']]);
line([[LEFT, 'ICC-2020AÑO1PERÍODO1']]);
line([[LEFT, 'CURSOSOBLIGATORIOS']]);
// Un solo código, en la columna de ADICIONALES: es co-requisito, no previo.
line([[LEFT, '017095 ICC101 Introducción a la Algoritmia 2 3 3'], [COREQ, 'MAT119']]);
line([[LEFT, '009205 MAT119 Precálculo 3 2 4']]);
line([[LEFT, 'Total Unidades: 20']]);
line([[LEFT, 'ICC-2020AÑO1PERÍODO3']]);
line([[LEFT, 'CURSOSOBLIGATORIOS']]);
// Un solo código, en la columna de PREVIOS: mismo texto plano, sentido opuesto.
line([[LEFT, '017143 ICC133 Funds. de Sist. Computacionales 3 3 4'], [PREREQ, 'ICC103']]);
// Las dos columnas a la vez, y un laboratorio de CERO unidades.
line([[LEFT, '005958 FIS139 Mecánica Newtoniana 4 0 4'], [PREREQ, 'MAT129'], [COREQ, '1FIS139']]);
line([[LEFT, '005959 1FIS139 Lab. FIS-139 0 2 0'], [PREREQ, 'MAT129'], [COREQ, 'FIS139']]);
// Nombre que envuelve a la línea siguiente, con requisitos que también envuelven.
line([[LEFT, '017181 ICC352 Programación Web 3 3 4'], [PREREQ, '1ITT102, ICC104, ICC223,']]);
line([[PREREQ, 'ITT102, ITT112']]);
line([[LEFT, '017184 ICC303 Programación Paralela y 3 3 4'], [PREREQ, 'ICC104, ICC331']]);
line([[LEFT, 'Concurrente']]);
line([[LEFT, '*ICC-E01-TELECTIVADEINTELIGENCIAARTIFICIAL. CURSOSMÍNIMOS:1,UNIDADESMÍNIMASREQUERIDAS:4']]);
line([[LEFT, '017197 ICC320 Deep Learning 3 3 4'], [PREREQ, 'ICC362, MAT229']]);
line([[LEFT, 'Total Unidades: 19']]);
line([[LEFT, 'Total General de Unidades: 212']]);
line([[LEFT, 'FIL-363 sólopuedensercursadasluegodehaberaprobadoel70%deloscréditosdeestepénsum.']]);

const plan = parsePensumPlan(items);

// ── Identidad del plan ──────────────────────────────────────────────────────
assert.equal(plan.plan, 'ICC-2020');
assert.equal(plan.career, 'INGENIERÍA EN CIENCIAS DE LA COMPUTACIÓN');
assert.equal(plan.issuedAt, '2024-12-03');
assert.equal(plan.totalUnits, 212);

// ── Lo que el texto plano no puede distinguir ───────────────────────────────
// Las dos filas siguientes son idénticas en texto plano ("... 3 CÓDIGO") y
// significan cosas opuestas. Si el parser dejara de mirar la X, ICC-101 pasaría
// a exigir MAT-119 aprobada de antemano — y nadie podría cursarla en su primer
// período, que es justo donde el plan la pone.
assert.deepEqual(plan.courses['ICC-101'].prereqs, []);
assert.deepEqual(plan.courses['ICC-101'].coreqs, ['MAT-119']);
assert.deepEqual(plan.courses['ICC-133'].prereqs, ['ICC-103']);
assert.deepEqual(plan.courses['ICC-133'].coreqs, []);

// ── Teoría y laboratorio, co-requisitos mutuos ──────────────────────────────
assert.deepEqual(plan.courses['FIS-139'].prereqs, ['MAT-129']);
assert.deepEqual(plan.courses['FIS-139'].coreqs, ['FIS-1FIS139']);
assert.deepEqual(plan.courses['FIS-1FIS139'].coreqs, ['FIS-139']);
// Cero unidades es un dato REAL, no un dato faltante: es lo que hacía que los
// laboratorios se cayeran del plan recomendado.
assert.equal(plan.courses['FIS-1FIS139'].units, 0);
assert.equal(plan.courses['FIS-139'].units, 4);

// ── Continuaciones de línea ─────────────────────────────────────────────────
// Los requisitos que no cupieron en la fila vuelven a su materia, no se pierden
// ni se le pegan a la siguiente.
assert.deepEqual(plan.courses['ICC-352'].prereqs, [
  'ITT-1ITT102', 'ICC-104', 'ICC-223', 'ITT-102', 'ITT-112',
]);
// El nombre partido se rearma.
assert.equal(plan.courses['ICC-303'].title, 'Programación Paralela y Concurrente');
assert.deepEqual(plan.courses['ICC-303'].prereqs, ['ICC-104', 'ICC-331']);

// ── Períodos y bloques ──────────────────────────────────────────────────────
assert.deepEqual(plan.periods, [
  { year: 1, period: 1, totalUnits: 20 },
  { year: 1, period: 3, totalUnits: 19 },
]);
assert.equal(plan.courses['FIS-139'].year, 1);
assert.equal(plan.courses['FIS-139'].period, 3);
assert.equal(plan.courses['FIS-139'].electiveOf, null);
assert.match(plan.courses['ICC-320'].electiveOf, /INTELIGENCIAARTIFICIAL/);

// ── Reglas en prosa ─────────────────────────────────────────────────────────
assert.equal(plan.gates.length, 1);
assert.equal(plan.gates[0].code, 'FIL-363');
assert.equal(plan.gates[0].minApprovedRatio, 0.7);

// ── Canonicalización ────────────────────────────────────────────────────────
// El prefijo 1 marca OTRA materia (el laboratorio), no una variante: perderlo
// fusionaría cada lab con su teoría.
assert.equal(canonical('ICC101'), 'ICC-101');
assert.equal(canonical('1FIS139'), 'FIS-1FIS139');
assert.equal(canonical('1ICC473'), 'ICC-1ICC473');
assert.equal(canonical('1CN112'), 'CN-1CN112');
assert.equal(canonical('MAT119,'), 'MAT-119');

// ── Robustez del agrupado por línea ─────────────────────────────────────────
// El PDF no garantiza orden de emisión de los fragmentos.
const shuffled = [...items].reverse();
assert.deepEqual(parsePensumPlan(shuffled).courses['FIS-139'], plan.courses['FIS-139']);
// Fragmentos con décimas de diferencia en Y son la misma fila.
const jittered = items.map((i, n) => ({ ...i, y: i.y + (n % 2 ? 0.3 : -0.2) }));
assert.equal(parsePensumPlan(jittered).courses['ICC-101'].coreqs.length, 1);
assert.ok(toLines(items).length > 10);

// ── El archivo versionado sigue cuadrando con el plan oficial ───────────────
// No es una tautología: es la red que avisa si alguien edita el JSON a mano o
// si una regeneración sale mal. Los números salen del PDF del Registro.
const icc = JSON.parse(await readFile(new URL('../src/shared/pensum/icc-2020.json', import.meta.url), 'utf8'));
assert.equal(icc.plan, 'ICC-2020');
assert.equal(icc.totalUnits, 212);
assert.equal(icc.periods.length, 12);
assert.equal(Object.keys(icc.courses).length, 107);
assert.deepEqual(icc.courses['FIS-219'].prereqs, ['FIS-1FIS139', 'FIS-139']);
assert.deepEqual(icc.courses['FIS-219'].coreqs, ['FIS-1FIS219', 'MAT-219']);
assert.deepEqual(icc.courses['ICC-343'].prereqs, ['ICC-342', 'ICC-352']);
assert.deepEqual(icc.courses['ICC-1ICC473'].prereqs, ['ICC-1ICC472']);
assert.equal(icc.courses['ITT-102'].prereqs.length, 0);
assert.deepEqual(icc.courses['ITT-102'].coreqs, ['ITT-1ITT102']);
// La memoria de recodificaciones sobrevive a regenerar el archivo.
assert.deepEqual(icc.aliases['MAT-110'], ['ESG-105']);

// ── Localización de la fuente ───────────────────────────────────────────────
// El PDF vive en un OneDrive personal: el enlace de visor da 403 y hay que
// derivar el de descarga del mismo token.
assert.equal(
  toDownloadUrl('https://contoso-my.sharepoint.com/:b:/g/personal/alguien_pucmm_edu_do/ABC123?e=xyz'),
  'https://contoso-my.sharepoint.com/personal/alguien_pucmm_edu_do/_layouts/15/download.aspx?share=ABC123'
);
assert.equal(toDownloadUrl('https://pucmm.edu.do/algo.pdf'), null);
assert.deepEqual(
  sharePointLinks(
    '<a href="https://x-my.sharepoint.com/:b:/g/personal/u/T1?e=1">pensum</a>' +
      '<a href="https://x-my.sharepoint.com/:b:/g/personal/u/T2">diagrama</a>' +
      '<a href="https://pucmm.edu.do/otro.pdf">otro</a>'
  ),
  ['https://x-my.sharepoint.com/:b:/g/personal/u/T1?e=1', 'https://x-my.sharepoint.com/:b:/g/personal/u/T2']
);

console.log('✓ plan académico: columnas de requisitos por posición, labs de 0 unidades, continuaciones y compuertas');
