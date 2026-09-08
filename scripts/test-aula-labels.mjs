// Lo que la pantalla Aula le dice al estudiante. Son funciones puras: se
// verifican sin montar React, que es donde estas frases se vuelven mentira.
import assert from 'node:assert/strict';
import { whenLabel, feedLabel, gradeLabel, decodeGrade, moduleMeta, moduleKind } from '../web/src/lib/aula.ts';
import { splitCourseTitle } from '../src/shared/pva.ts';

const ahora = new Date(2026, 8, 7, 9, 0); // lunes 7 de septiembre de 2026
const en = (d, h, m = 0) => new Date(2026, 8, 7 + d, h, m).toISOString();

// ── Cuándo ──
// La forma más corta que sigue siendo exacta. "En 3 días" obliga a hacer la
// cuenta para saber si es antes o después de la clase del jueves.
assert.equal(whenLabel(en(0, 23, 59), ahora), 'hoy 11:59p', 'la hora sola obliga a suponer de qué día');
assert.equal(whenLabel(en(1, 8, 0), ahora), 'mañana 8:00a');
assert.equal(whenLabel(en(3, 12, 0), ahora), 'jue 12:00p', 'dentro de la semana, con el día');
assert.equal(whenLabel(en(-1, 10, 0), ahora), 'ayer');
assert.equal(whenLabel(en(-4, 10, 0), ahora), '3/9', 'hacia atrás la fecha: "jue" se leería como el jueves que viene');
assert.equal(whenLabel(en(20, 10, 0), ahora), '27/9', 'más lejos, con la fecha');
assert.equal(whenLabel('no es una fecha', ahora), '', 'una fecha rota no rompe la fila');

// ── Qué dice una fila del feed ──
const vence = (submitted) => ({ id: 'x', kind: 'vence', courseId: 1, courseShortname: 'ICC-233', title: 'Práctica 4', detail: null, at: en(3, 23, 59), submitted, url: null });
assert.deepEqual(feedLabel(vence(false)), { texto: 'Sin entregar', tono: 'urgente' });
assert.deepEqual(feedLabel(vence(true)), { texto: 'Entregada', tono: 'hecho' });
// El caso que decide todo: null NO es false.
assert.equal(feedLabel(vence(null)).texto, 'Estado sin consultar');
assert.equal(feedLabel(vence(null)).tono, 'pendiente', 'lo que no se sabe no se pinta como urgente');
assert.equal(feedLabel({ ...vence(null), kind: 'nota_publicada' }).texto, 'Nota publicada');
assert.equal(feedLabel({ ...vence(null), kind: 'anuncio' }).texto, 'Anuncio del profesor');

// ── El nombre de una materia ──
// La PVA repite el código adentro del nombre largo. Mostrar el shortname como
// si fuera el nombre es esconder el único dato que la persona reconoce.
assert.deepEqual(splitCourseTitle('CSTI-1930-5227 - Inteligencia de Negocios', 'CSTI-1930-5227'), {
  code: 'CSTI-1930-5227',
  name: 'Inteligencia de Negocios',
});
assert.equal(splitCourseTitle('CSTI-1900-4789 - Lab. ITT-102', 'CSTI-1900-4789').name, 'Lab. ITT-102', 'un guion en el nombre no se come');
assert.equal(
  splitCourseTitle('Materia sin código adelante', 'OTRO').name,
  'Materia sin código adelante',
  'sin el patrón se devuelve el nombre entero: recortar a ciegas es peor que mostrar de más'
);
assert.equal(splitCourseTitle('CSTI-1910-5488', 'CSTI-1910-5488').name, 'CSTI-1910-5488', 'y nunca queda vacío');

// ── El libro de una materia ──
// Las tres ausencias se dicen distinto, porque son distintas.
const libro = (extra) => ({ checked: true, hidden: false, reason: null, total: null, gradedItems: 0, gradableItems: 0, ...extra });
assert.equal(gradeLabel(libro({ hidden: true, reason: 'x' })), 'Libro oculto por el profesor');
assert.equal(gradeLabel(libro({ checked: false })), 'Todavía no se consultó el libro de esta materia', 'nunca leído no es vacío');
assert.equal(gradeLabel(libro()), 'Sin nota publicada todavía', 'leído y sin nota tampoco es un cero');
assert.equal(gradeLabel(libro({ total: '85.50', gradedItems: 2, gradableItems: 6 })), 'Nota del aula 85.50 · 2 de 6 items calificados');

// Moodle formatea sus notas para HTML y las manda con las entidades adentro.
assert.equal(decodeGrade('85,00&nbsp;/&nbsp;100,00'), '85,00 / 100,00');
assert.equal(decodeGrade('0&ndash;100'), '0-100');

// ── La segunda línea de un módulo ──
const modulo = (extra) => ({
  cmid: 1, modname: 'resource', name: 'Guía', url: null, inlineOnly: false,
  completion: 'sin_seguimiento', dueAt: null, assignment: null, files: [], links: [], ...extra,
});
const archivo = (over) => ({ fileId: 1, filename: 'g.pdf', mimetype: 'application/pdf', downloaded: true, indexed: true, ...over });

assert.equal(moduleMeta(modulo({ files: [archivo()] })), 'se puede buscar por dentro');
assert.equal(moduleMeta(modulo({ files: [archivo({ indexed: false })] })), 'bajado, sin texto que buscar');
assert.equal(moduleMeta(modulo({ files: [archivo({ downloaded: false, indexed: false })] })), 'sin bajar todavía');
assert.equal(moduleMeta(modulo({ files: [archivo(), archivo({ fileId: 2 })] })), '2 archivos · se puede buscar por dentro');
assert.equal(
  moduleMeta(modulo({ modname: 'url', links: [{ name: 'Video', url: 'https://youtube.com/x', host: 'youtube.com' }] })),
  'Enlace externo · youtube.com'
);
assert.equal(moduleMeta(modulo({ modname: 'forum' })), 'Foro', 'sin nada que decir, el tipo en palabras');

const tarea = (assignment) => modulo({ modname: 'assign', assignment: { assignmentId: 1, status: null, submitted: null, graded: false, gradeText: null, isLate: false, isOverdue: false, ...assignment } });
assert.equal(moduleMeta(tarea({ submitted: false })), 'Sin entregar');
assert.equal(moduleMeta(tarea({ submitted: false, isOverdue: true })), 'Venció y no está entregada');
assert.equal(moduleMeta(tarea({ submitted: true, status: 'submitted' })), 'Entregada · sin calificar');
assert.equal(moduleMeta(tarea({ submitted: true, isLate: true })), 'Entregada tarde · sin calificar');
assert.equal(moduleMeta(tarea({ submitted: true, graded: true, gradeText: '92.00000' })), 'Calificada · 92.00000');
assert.equal(moduleMeta(tarea({})), 'Estado sin consultar', 'y acá también: null no es false');

assert.equal(moduleKind('assign'), 'Tarea');
assert.equal(moduleKind('h5pactivity'), 'h5pactivity', 'un modname que no conocemos se muestra tal cual, no se inventa');

console.log('✓ pantalla Aula: cuándo en la forma más corta exacta, y "no se sabe" nunca se pinta como "sin entregar"');
