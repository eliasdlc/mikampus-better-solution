// La aritmética del Dashboard (plan §5.1): qué hay hoy y cuál es la próxima
// clase. Es lo primero que ve el usuario al abrir la app, así que equivocarse
// acá se nota antes que en ningún otro lado.
import assert from 'node:assert/strict';
import { agendaFor, dayCodeOf, nextClass, dayTimeline, weekTimeline, nextThing } from '../src/shared/agenda.ts';

const B = (day, start, end, id) => ({ day, start, end, id });

// Un jueves con dos clases y un lunes suelto, para probar la vuelta de semana.
const blocks = [
  B('Th', '18:00', '21:00', 'tarde'),
  B('Th', '10:00', '13:00', 'manana'),
  B('Mo', '08:00', '10:00', 'lunes'),
  B('Sa', '10:00', '13:00', 'sabado'),
];

// 2026-07-16 es jueves. El mes de Date es 0-based.
const jueves = (h, m = 0) => new Date(2026, 6, 16, h, m);
assert.equal(dayCodeOf(jueves(9)), 'Th');
assert.equal(dayCodeOf(new Date(2026, 6, 19)), 'Su', 'domingo es el día 0 de getDay pero el último de la semana');

// El día sale ordenado por reloj, no en el orden en que llegaron los bloques.
assert.deepEqual(
  agendaFor(blocks, jueves(9)).map((b) => b.id),
  ['manana', 'tarde']
);
assert.deepEqual(agendaFor(blocks, new Date(2026, 6, 17)).map((b) => b.id), [], 'un viernes sin clases es un día vacío');

// Antes de empezar el día: la próxima es la primera.
assert.equal(nextClass(blocks, jueves(7)).block.id, 'manana');
assert.equal(nextClass(blocks, jueves(7)).ongoing, false);
assert.equal(nextClass(blocks, jueves(7)).at.getHours(), 10, 'la hora de inicio viaja como fecha real, no como string');

// En curso: la clase que estás teniendo gana, aunque ya haya empezado.
const enCurso = nextClass(blocks, jueves(11));
assert.equal(enCurso.block.id, 'manana');
assert.equal(enCurso.ongoing, true);

// El borde exacto del final: a las 13:00 la clase de la mañana ya terminó.
assert.equal(nextClass(blocks, jueves(13)).block.id, 'tarde');
assert.equal(nextClass(blocks, jueves(12, 59)).block.id, 'manana');

// El borde exacto del inicio: a las 18:00 la de la tarde está en curso.
assert.equal(nextClass(blocks, jueves(18)).ongoing, true);

// Terminado el jueves, la próxima es el sábado (no el lunes: la semana no
// arranca de nuevo, sigue hacia adelante).
const finDeJueves = nextClass(blocks, jueves(22));
assert.equal(finDeJueves.block.id, 'sabado');
assert.equal(finDeJueves.at.getDate(), 18, 'sábado 18 de julio de 2026');

// La vuelta de semana: un sábado por la noche, la próxima es el lunes.
const sabadoDeNoche = nextClass(blocks, new Date(2026, 6, 18, 22));
assert.equal(sabadoDeNoche.block.id, 'lunes');
assert.equal(sabadoDeNoche.at.getDate(), 20, 'lunes 20, dando la vuelta a la semana');

// Una sola clase por semana se encuentra desde cualquier momento: es el caso
// que necesita la vuelta completa.
const soloLunes = [B('Mo', '08:00', '10:00', 'lunes')];
assert.equal(nextClass(soloLunes, new Date(2026, 6, 20, 10, 1)).at.getDate(), 27, 'el lunes siguiente, 7 días después');
assert.equal(nextClass(soloLunes, jueves(9)).block.id, 'lunes');

// Sin horario no hay próxima clase, y buscarla no cuelga.
assert.equal(nextClass([], jueves(9)), null);

// ── Una sola semana: clases y entregas ────────────────────────────────────
//
// Una clase es un bloque con principio y fin; una entrega es un instante. Lo
// que se prueba acá es que convivan ordenadas y que el día de una entrega se
// resuelva en hora local: en Santo Domingo, una entrega de las 11:59 pm es del
// día siguiente en UTC, y ese es justo el día en que ya no se puede entregar.

// Jueves 16 de julio de 2026, 11:59 pm hora local.
const entregaTarde = { at: Math.floor(new Date(2026, 6, 16, 23, 59).getTime() / 1000), id: 'assign:1', title: 'Informe final' };
const entregaManana = { at: Math.floor(new Date(2026, 6, 16, 10, 0).getTime() / 1000), id: 'assign:2', title: 'Quiz' };

const dia = dayTimeline(blocks, [entregaTarde, entregaManana], jueves(9));
assert.deepEqual(
  dia.map((entry) => (entry.kind === 'class' ? `clase:${entry.block.id}` : `entrega:${entry.deadline.id}`)),
  ['clase:manana', 'entrega:assign:2', 'clase:tarde', 'entrega:assign:1'],
  'clases y entregas conviven en orden de reloj, y a la misma hora la clase va primero'
);
assert.equal(dia[1].endsAt, null, 'una entrega no ocupa espacio: no tiene fin');

// La entrega de las 11:59 pm es de ESE jueves, no del viernes.
assert.equal(dayTimeline(blocks, [entregaTarde], new Date(2026, 6, 17)).length, 0, 'el viernes no hereda la entrega del jueves');
assert.equal(
  dayTimeline([], [entregaTarde], jueves(9)).length,
  1,
  'la entrega de las 11:59 pm cae en su propio día, no en el siguiente por UTC'
);

// La semana: siete días, cada uno con lo suyo.
const semana = weekTimeline(blocks, [entregaTarde], new Date(2026, 6, 13), 7);
assert.equal(semana.length, 7);
assert.deepEqual(
  semana.filter((day) => day.entries.length).map((day) => day.date.getDate()),
  [13, 16, 18],
  'lunes con clase, jueves con dos clases y una entrega, sábado con clase'
);

// ── Qué sigue: puede ser una entrega ──
// Decir "tu próxima clase es el lunes" cuando hay una entrega esta noche es
// contestar otra pregunta.
// A las 21:30 ya terminó la clase de la tarde: lo próximo es la entrega de las
// 11:59 pm, no la clase del sábado.
const conEntrega = nextThing(blocks, [entregaTarde], jueves(21, 30));
assert.equal(conEntrega.kind, 'deadline');
assert.equal(conEntrega.deadline.id, 'assign:1');

const conClase = nextThing(blocks, [entregaTarde], jueves(9));
assert.equal(conClase.kind, 'class', 'la clase de las 10 llega antes que la entrega de las 11:59 pm');

// Una clase en curso gana: es lo que estás teniendo.
const enClase = nextThing(blocks, [entregaTarde], jueves(11));
assert.equal(enClase.kind, 'class');
assert.equal(enClase.ongoing, true);

// Lo ya entregado no vuelve a pedir atención.
const entregada = { ...entregaTarde, submitted: true };
assert.equal(nextThing([], [entregada], jueves(21, 30)), null, 'una entrega hecha no es lo próximo que hay que hacer');
assert.equal(
  nextThing([], [{ ...entregaTarde, submitted: null }], jueves(21, 30)).kind,
  'deadline',
  'y "no se sabe" no es "ya está"'
);

console.log('✓ agenda del día y próxima clase (bordes de hora, vuelta de semana, horario vacío)');
