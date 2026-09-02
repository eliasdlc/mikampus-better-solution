// Verifica la lógica pura del WeeklyGrid: que dos clases a la misma hora se
// repartan la columna en vez de taparse, que los choques se detecten, que un
// choque temprano no adelgace un bloque de la tarde, que la ventana horaria
// salga de los bloques sin dejar ninguno fuera, y que el color se reparta sobre
// las materias visibles.
import assert from 'node:assert/strict';
import {
  FALLBACK_WINDOW,
  MIN_WINDOW_HOURS,
  hasCollisions,
  layoutDay,
  paletteFor,
  timeWindow,
  toBlocks,
  toGridLine,
} from '../web/src/lib/grid.ts';

const block = (id, start, end, title = id) => ({
  id,
  code: 'ICC-100',
  title,
  classNbr: id,
  section: '101',
  component: 'LEC',
  room: null,
  instructor: null,
  day: 'Mo',
  start,
  end,
});

// Sin choques: todos en un carril, a ancho completo.
{
  const placed = layoutDay([block('a', '07:00', '09:00'), block('b', '10:00', '12:00')]);
  assert.deepEqual(placed.map((p) => p.lanes), [1, 1], 'sin choque, ancho completo');
  assert.deepEqual(placed.map((p) => p.conflictsWith), [[], []]);
}

// Bordes que se tocan (una termina 09:00, la otra empieza 09:00) NO es choque.
{
  const placed = layoutDay([block('a', '07:00', '09:00'), block('b', '09:00', '11:00')]);
  assert.deepEqual(placed.map((p) => p.lanes), [1, 1], 'tocarse no es solaparse');
  assert.deepEqual(placed.map((p) => p.conflictsWith), [[], []]);
}

// Choque real: dos carriles, y cada uno sabe contra qué choca.
{
  const placed = layoutDay([block('a', '10:00', '13:00', 'Estructuras'), block('b', '12:00', '14:00', 'Bases')]);
  assert.deepEqual(placed.map((p) => p.lane), [0, 1], 'se reparten la columna');
  assert.deepEqual(placed.map((p) => p.lanes), [2, 2]);
  assert.deepEqual(placed[0].conflictsWith, ['Bases']);
  assert.deepEqual(placed[1].conflictsWith, ['Estructuras']);
}

// Un choque a la mañana no puede adelgazar un bloque suelto de la tarde.
{
  const placed = layoutDay([
    block('a', '07:00', '09:00'),
    block('b', '08:00', '10:00'),
    block('tarde', '18:00', '20:00'),
  ]);
  const tarde = placed.find((p) => p.id === 'tarde');
  assert.equal(tarde.lanes, 1, 'el bloque de la tarde va a ancho completo');
  assert.equal(placed.find((p) => p.id === 'a').lanes, 2);
}

// Cadena de choques: a-b chocan y b-c chocan, pero a-c no. La propiedad que
// importa no es cuántos carriles salen, sino que dos bloques que se solapan
// NUNCA compartan carril (si lo hicieran, se taparían en pantalla). Acá c
// puede reusar el carril de a justamente porque no se solapan.
{
  const placed = layoutDay([
    block('a', '08:00', '10:00'),
    block('b', '09:00', '11:00'),
    block('c', '10:30', '12:00'),
  ]);
  const min = (id) => placed.find((p) => p.id === id);
  assert.equal(min('a').lane, 0);
  assert.equal(min('b').lane, 1, 'b choca con a → otro carril');
  assert.equal(min('c').lane, 0, 'c no choca con a → reusa su carril');

  for (const x of placed) {
    for (const y of placed) {
      if (x.id === y.id) continue;
      const solapan = x.start < y.end && y.start < x.end;
      if (solapan) assert.notEqual(x.lane, y.lane, `${x.id} y ${y.id} se solapan: no pueden compartir carril`);
    }
  }
}

// Una sección "MoWe 10:00-13:00" produce un bloque por día.
{
  const blocks = toBlocks([
    {
      id: 1,
      code: 'ICC-233',
      subject: 'ICC',
      catalogNbr: '233',
      title: 'Seg. en TI',
      status: 'enrolled',
      units: 4,
      grading: null,
      grade: null,
      sections: [
        {
          id: 10,
          classNbr: '5225',
          section: '101',
          component: 'LEC',
          instructor: 'Dorville',
          startDate: null,
          endDate: null,
          meetings: [{ days: ['Mo', 'We'], start: '10:00', end: '13:00', room: 'A-201' }],
        },
        // Sección sin horario asignado (TBA): no puede dibujarse.
        {
          id: 11,
          classNbr: '5226',
          section: '171',
          component: 'PRA',
          instructor: null,
          startDate: null,
          endDate: null,
          meetings: [{ days: ['Th'], start: null, end: null, room: null }],
        },
      ],
    },
  ]);
  assert.equal(blocks.length, 2, 'MoWe → dos bloques; la TBA no genera bloque');
  assert.deepEqual(blocks.map((b) => b.day), ['Mo', 'We']);
  assert.equal(blocks[0].room, 'A-201');
}

// El grid arranca a las 7:00 en la fila 2 (la 1 es la cabecera de días).
{
  assert.equal(toGridLine('07:00', 7, 15), 2, '7:00 es la primera fila del cuerpo');
  assert.equal(toGridLine('08:00', 7, 15), 6, 'una hora = 4 slots de 15min');
  assert.equal(toGridLine('22:00', 7, 15), 62, '22:00 es la línea de cierre');
}

// hasCollisions: la señal sí/no que usa /inscripcion, sobre Block[] sin colocar.
// El carrito arma bloques con sectionToBlocks (Block, no PlacedBlock), así que
// esta señal no puede depender de conflictsWith —el bug que dejaba /inscripcion
// en blanco al leer .length de undefined.
{
  assert.equal(hasCollisions([]), false, 'carrito vacío no choca');
  assert.equal(
    hasCollisions([block('a', '07:00', '09:00'), block('b', '10:00', '12:00')]),
    false,
    'mismo día sin solaparse no choca'
  );
  assert.equal(
    hasCollisions([block('a', '10:00', '13:00'), block('b', '12:00', '14:00')]),
    true,
    'mismo día solapados sí chocan'
  );
  assert.equal(
    hasCollisions([{ ...block('a', '10:00', '12:00'), day: 'Mo' }, { ...block('b', '10:00', '12:00'), day: 'Tu' }]),
    false,
    'misma hora en días distintos no choca'
  );
  assert.equal(
    hasCollisions([block('a', '10:00', '13:00'), { ...block('g', '12:00', '14:00'), ghost: true }]),
    false,
    'un fantasma (preview) no cuenta como choque'
  );
}

// ── timeWindow ─────────────────────────────────────────────────────────────
// La ventana ya no es 7:00-22:00 fija: sale de los bloques. Lo que se protege
// acá es que siga siendo una grilla legible (un mínimo de horas) sin dejar
// nunca un bloque fuera, que era el modo de fallar de la versión fija.

// Una sola clase corta no puede devolver una tira de una hora.
{
  const w = timeWindow([block('a', '10:00', '11:00')]);
  assert.deepEqual(w, { startHour: 10, endHour: 16 }, 'una clase de una hora rellena hacia abajo');
  assert.equal(w.endHour - w.startHour, MIN_WINDOW_HOURS, 'la ventana nunca baja del mínimo');
}

// Una clase de noche tiene que caber: con el rango fijo un bloque fuera de
// 7:00-22:00 simplemente no se dibujaba.
{
  const w = timeWindow([block('noche', '21:00', '22:00')]);
  assert.ok(w.startHour <= 21 && w.endHour >= 22, 'la clase de las 21:00 cae dentro de la ventana');
  assert.deepEqual(w, { startHour: 16, endHour: 22 }, 'sin espacio abajo, la ventana crece hacia arriba');
}

// El relleno tiene topes: no inventa horas después de las 22 ni antes de las 6.
{
  const tarde = timeWindow([block('noche', '21:00', '22:00')], { minHours: 20 });
  assert.deepEqual(tarde, { startHour: 6, endHour: 22 }, 'el relleno se detiene en 6 y en 22');
  const manana = timeWindow([block('a', '08:00', '09:00')], { minHours: 20 });
  assert.deepEqual(manana, { startHour: 6, endHour: 22 }, 'crece abajo primero y arriba después');
  assert.ok(manana.endHour - manana.startHour < 20, 'los topes ganan sobre el mínimo pedido');
}

// Sin bloques no hay nada de dónde derivar: franja lectiva declarada, no inventada.
{
  const w = timeWindow([]);
  assert.deepEqual(w, FALLBACK_WINDOW, 'sin bloques, la ventana de respaldo');
  assert.ok(w.endHour - w.startHour >= MIN_WINDOW_HOURS, 'el respaldo ya cumple el mínimo');
}

// Un bloque que termina en punto no arrastra la hora siguiente entera.
{
  assert.deepEqual(
    timeWindow([block('a', '08:00', '12:00')], { minHours: 4 }),
    { startHour: 8, endHour: 12 },
    '12:00 cierra en 12, no en 13'
  );
  assert.deepEqual(
    timeWindow([block('a', '08:00', '12:01')], { minHours: 4 }),
    { startHour: 8, endHour: 13 },
    'un minuto pasado sí necesita la hora siguiente'
  );
}

// La ventana es del conjunto, no de un día: el primer inicio y el último fin
// mandan aunque estén en columnas distintas.
{
  const w = timeWindow([
    { ...block('a', '08:00', '10:00'), day: 'Mo' },
    { ...block('b', '18:00', '20:00'), day: 'Fr' },
  ]);
  assert.deepEqual(w, { startHour: 8, endHour: 20 }, 'toma el mínimo y el máximo de toda la semana');
}

// ── paletteFor ─────────────────────────────────────────────────────────────
// El reparto es sobre las materias VISIBLES, no sobre las 907 del catálogo en
// 14 tonos: en pantalla no puede haber dos materias con el mismo hue.

const conCodigo = (code, id, start, end) => ({ ...block(id, start, end, code), code });

// Un tono distinto por materia visible.
{
  const palette = paletteFor([
    conCodigo('ICC-104', 'a', '08:00', '10:00'),
    conCodigo('ICC-331', 'b', '10:00', '12:00'),
    conCodigo('ICC-342', 'c', '12:00', '14:00'),
    conCodigo('ICC-371', 'd', '14:00', '16:00'),
  ]);
  assert.equal(palette.size, 4, 'una entrada por materia');
  assert.equal(new Set(palette.values()).size, 4, 'cuatro materias, cuatro tonos');
  for (const hue of palette.values()) assert.ok(hue >= 0 && hue < 360, 'el tono es un ángulo válido');
}

// Dos secciones de la misma materia comparten tono: el color identifica materia.
{
  const palette = paletteFor([
    conCodigo('ICC-233', 'lec', '08:00', '10:00'),
    conCodigo('ICC-233', 'pra', '10:00', '12:00'),
    conCodigo('MAT-201', 'mat', '12:00', '14:00'),
  ]);
  assert.equal(palette.size, 2, 'teórica y práctica de la misma materia son un solo tono');
}

// Estable ante el orden de entrada: el mismo conjunto da el mismo mapa venga
// como venga, para que reordenar el carrito no repinte la semana.
{
  const codigos = ['MAT-201', 'ICC-104', 'FIS-110', 'ICC-331'];
  const directo = paletteFor(codigos.map((code, i) => conCodigo(code, `d${i}`, '08:00', '09:00')));
  const alReves = paletteFor([...codigos].reverse().map((code, i) => conCodigo(code, `r${i}`, '08:00', '09:00')));
  assert.deepEqual(directo, alReves, 'el mismo conjunto en otro orden da el mismo mapa');
}

// Una sola materia: no hay división por cero ni tono fuera de rango.
{
  const palette = paletteFor([conCodigo('ICC-104', 'a', '08:00', '10:00')]);
  assert.equal(palette.size, 1);
  assert.equal(palette.get('ICC-104'), 0, 'la única materia arranca el círculo');
}

// Sin bloques, mapa vacío (el caso del carrito recién abierto).
{
  assert.equal(paletteFor([]).size, 0, 'sin bloques no hay tonos');
}

// Más materias que los 14 tonos del hash global: siguen saliendo todas distintas.
{
  const blocks = Array.from({ length: 20 }, (_, i) =>
    conCodigo(`ICC-${100 + i}`, `x${i}`, '08:00', '09:00')
  );
  const palette = paletteFor(blocks);
  assert.equal(new Set(palette.values()).size, 20, '20 materias visibles, 20 tonos');
}

console.log(
  '✓ Layout del WeeklyGrid OK (carriles, choques, bordes, TBA, hasCollisions, ventana horaria, paleta por conjunto visible).'
);
