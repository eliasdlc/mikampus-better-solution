// Verifica el posicionamiento del WeeklyGrid: que dos clases a la misma hora
// se repartan la columna en vez de taparse, que los choques se detecten, y que
// un choque temprano no adelgace un bloque de la tarde.
import assert from 'node:assert/strict';
import { layoutDay, toBlocks, toGridLine } from '../web/src/lib/grid.ts';

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

console.log('✓ Layout del WeeklyGrid OK (carriles, choques, bordes, TBA).');
