// El ritmo de cupo: la serie temporal que mikampus ya guardaba y nunca leía.
// Lo que se prueba es que describe HECHOS OBSERVADOS y no predice nada.
import assert from 'node:assert/strict';

const { seatTrend, describeTrend } = await import('../src/shared/seatTrend.ts');

const AHORA = new Date('2026-08-09T18:00:00Z');
const hace = (horas, seatsOpen, status = seatsOpen > 0 ? 'open' : 'closed') => ({
  status,
  seatsOpen,
  seatsCap: 30,
  capturedAt: new Date(AHORA.getTime() - horas * 3_600_000).toISOString(),
});

// ── Sin datos, sin invención ───────────────────────────────────────────────
assert.equal(seatTrend([], { now: AHORA }).direction, 'unknown');
assert.equal(describeTrend(seatTrend([], { now: AHORA })), null);

// Una sola observación no es un ritmo.
const unaSola = seatTrend([hace(1, 5)], { now: AHORA });
assert.equal(unaSola.samples, 1);
assert.equal(unaSola.change, null, 'con una muestra no hay cambio que reportar');
assert.equal(describeTrend(unaSola), null, 'y no se dice nada');

// ── Llenándose ─────────────────────────────────────────────────────────────
const llenando = seatTrend([hace(4, 12), hace(3, 9), hace(2, 6), hace(0.5, 3)], { now: AHORA });
assert.equal(llenando.direction, 'filling');
assert.equal(llenando.change, -9, 'perdió nueve asientos en la ventana');
assert.ok(llenando.perHour < 0, 'el ritmo es negativo');
assert.match(describeTrend(llenando), /perdió 9 cupos/);
assert.match(describeTrend(llenando), /últimas 4 h|última hora/);

// ── Abriendo ───────────────────────────────────────────────────────────────
const abriendo = seatTrend([hace(3, 0, 'closed'), hace(1, 2)], { now: AHORA });
assert.equal(abriendo.direction, 'opening');
assert.equal(abriendo.change, 2);
assert.equal(abriendo.reopenedAt, hace(1, 2).capturedAt, 'se registra cuándo reabrió');
assert.match(describeTrend(abriendo), /abrió 2 cupos/);

// ── Estable: perder un asiento en ocho horas NO es "llenándose" ────────────
const ruido = seatTrend([hace(8, 10), hace(0.5, 9)], { now: AHORA });
assert.equal(ruido.direction, 'stable', 'un asiento en ocho horas es ruido, no tendencia');
assert.match(describeTrend(ruido), /sin cambios/);

// ── Se cerró: el instante observado, no uno inferido ───────────────────────
const cerrada = seatTrend([hace(5, 4), hace(3, 1), hace(2, 0, 'closed'), hace(0.5, 0, 'closed')], { now: AHORA });
assert.equal(cerrada.closedAt, hace(2, 0, 'closed').capturedAt, 'el cierre es el momento en que se observó');
assert.equal(cerrada.direction, 'filling');

// Un ciclo cerrar → abrir → cerrar reporta las DOS transiciones más recientes.
const vaiven = seatTrend([hace(6, 2), hace(5, 0, 'closed'), hace(3, 1), hace(1, 0, 'closed')], { now: AHORA });
assert.equal(vaiven.reopenedAt, hace(3, 1).capturedAt);
assert.equal(vaiven.closedAt, hace(1, 0, 'closed').capturedAt, 'gana el cierre más reciente');

// ── La ventana acota, pero el último dato nunca se pierde ──────────────────
const vieja = seatTrend([hace(100, 20), hace(96, 18)], { now: AHORA, windowHours: 24 });
assert.equal(vieja.change, null, 'fuera de la ventana no se calcula ritmo');
assert.ok(vieja.latest, 'pero se conserva la última observación conocida');
assert.equal(vieja.latest.seatsOpen, 18, '"el último dato es viejo" también es información');

// Datos sin seatsOpen (el portal a veces solo dice abierto/cerrado).
const soloEstado = seatTrend(
  [
    { status: 'open', seatsOpen: null, seatsCap: null, capturedAt: hace(3, 1).capturedAt },
    { status: 'closed', seatsOpen: null, seatsCap: null, capturedAt: hace(1, 0).capturedAt },
  ],
  { now: AHORA }
);
assert.equal(soloEstado.change, null, 'sin conteo no se inventa un cambio numérico');
assert.ok(soloEstado.closedAt, 'pero la transición de estado sí se observa');

// El orden de entrada no importa: se ordena por instante, no por posición.
const desordenado = seatTrend([hace(0.5, 3), hace(4, 12), hace(2, 6)], { now: AHORA });
assert.equal(desordenado.change, -9, 'llegar desordenado no cambia el resultado');

console.log('✓ ritmo de cupo: describe lo observado (cuántos, en cuánto tiempo, cuándo cerró) sin predecir nada');
