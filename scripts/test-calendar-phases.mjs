import assert from 'node:assert/strict';
import {
  matchCalendarEvent,
  calendarEventsForTerm,
  termAnchors,
  termCodeInTitle,
  preinscriptionFor,
} from '../src/shared/calendarPhases.ts';
import { resolveTermPhase } from '../src/shared/termPhase.ts';

// El puente entre el calendario público de PUCMM y las etapas del ciclo.
//
// Las filas de abajo son literales del calendario 2026-2027 tal como quedan en
// la tabla `academic_calendar`: títulos, fechas y todo. La prueba existe porque
// el modo de fallar de este módulo es silencioso — una regla que deja de
// matchear no rompe nada, simplemente devuelve una etapa menos, y la app vuelve
// a no apagar nunca ningún control sin que nadie se entere.

const CALENDARIO = [
  { id: 'e1', title: 'Fecha límite para Modificar preinscripción para el Ciclo 1930', startsOn: '2026-08-10', endsOn: '2026-08-10' },
  { id: 'e2', title: 'Inicio de Ciclo 1930', startsOn: '2026-08-17', endsOn: '2026-08-17' },
  { id: 'e3', title: 'Primer pago de matrícula estudiantes regulares (Formalización de la inscripción)', startsOn: '2026-08-25', endsOn: '2026-08-26' },
  { id: 'e4', title: 'Inicio de docencia', startsOn: '2026-09-01', endsOn: '2026-09-01' },
  { id: 'e5', title: 'Pago tardío de selección de asignaturas (Inscripciones tardías y de estudiantes con I/E)', startsOn: '2026-09-02', endsOn: '2026-09-02' },
  { id: 'e6', title: 'Modificación a la inscripción', startsOn: '2026-09-02', endsOn: '2026-09-03' },
  { id: 'e7', title: 'Día de Nuestra Señora de las Mercedes (Asueto)', startsOn: '2026-09-24', endsOn: '2026-09-24' },
  { id: 'e8', title: 'Fecha límite para retiro parcial', startsOn: '2026-11-06', endsOn: '2026-11-06' },
  { id: 'e9', title: 'Período de preinscripción para el Ciclo 1940', startsOn: '2026-11-11', endsOn: '2026-11-13' },
  { id: 'e10', title: 'Fecha límite para retiro total', startsOn: '2026-11-20', endsOn: '2026-11-20' },
  { id: 'e11', title: 'Inicio período de reporte de calificaciones finales', startsOn: '2026-12-01', endsOn: '2026-12-01' },
  { id: 'e12', title: 'Último día de docencia', startsOn: '2026-12-07', endsOn: '2026-12-07' },
  { id: 'e13', title: 'Fecha límite para solicitar revisión de calificaciones finales', startsOn: '2026-12-10', endsOn: '2026-12-10' },
  { id: 'e14', title: 'Inicio de Ciclo 1940', startsOn: '2026-12-15', endsOn: '2026-12-15' },
  { id: 'e15', title: 'Primer pago de matrícula estudiantes regulares (Formalización de la inscripción)', startsOn: '2026-12-16', endsOn: '2026-12-17' },
  { id: 'e16', title: 'Asueto navideño', startsOn: '2026-12-21', endsOn: '2027-01-03' },
];

const CICLO_1930 = { startDate: '2026-09-01', endDate: '2026-12-07' };

// ── Qué es una etapa y qué no ───────────────────────────────────────────────
// La mayoría del calendario son asuetos, pagos y graduaciones: no gobiernan
// ninguna capacidad y traducirlos sería inventar etapas.
assert.equal(matchCalendarEvent(CALENDARIO[6]), null, 'un asueto no es una etapa del ciclo');
assert.equal(matchCalendarEvent(CALENDARIO[15]), null, 'el asueto navideño tampoco');
assert.equal(matchCalendarEvent(CALENDARIO[8]), null, 'la preinscripción del próximo ciclo no es una etapa de ESTE ciclo');

// Una "fecha límite" aporta el cierre y NO la apertura: media ventana conocida
// es un dato honesto, y fingir que abrió el mismo día sería inventar.
const retiro = matchCalendarEvent(CALENDARIO[7]);
assert.equal(retiro.event, 'retiro-parcial');
assert.equal(retiro.startsOn, null, 'una fecha límite no publica cuándo abrió');
assert.equal(retiro.endsOn, '2026-11-06');

// La modificación es la única que el calendario publica como rango real.
const modificacion = matchCalendarEvent(CALENDARIO[5]);
assert.deepEqual(
  { event: modificacion.event, startsOn: modificacion.startsOn, endsOn: modificacion.endsOn },
  { event: 'modificacion-inscripcion', startsOn: '2026-09-02', endsOn: '2026-09-03' }
);

// ── Atribución de ciclo ─────────────────────────────────────────────────────
assert.equal(termCodeInTitle('Fecha límite para modificar preinscripción para el Ciclo 1940'), '1940');
assert.equal(termCodeInTitle('Modificación a la inscripción'), null, 'la mayoría de las filas no nombran ciclo');

assert.deepEqual(
  termAnchors(CALENDARIO),
  [
    { code: '1930', startsOn: '2026-08-17' },
    { code: '1940', startsOn: '2026-12-15' },
  ],
  'el calendario publica el arranque de cada ciclo y eso delimita el tramo'
);

const del1930 = calendarEventsForTerm(CALENDARIO, { termCode: '1930', termWindow: CICLO_1930 });
const porEtapa = Object.fromEntries(del1930.map((hit) => [hit.event, hit]));

// El caso que obliga a usar los anclajes: la formalización del 1930 es el 25 de
// agosto y la docencia arranca el 1 de septiembre. Atribuir por la ventana del
// término dejaría fuera justo la fecha que cierra la inscripción.
assert.equal(porEtapa['inscripcion-regular']?.endsOn, '2026-08-26', 'la inscripción cierra antes de que empiece la docencia');
assert.equal(porEtapa['inscripcion-tardia']?.endsOn, '2026-09-02');
assert.equal(porEtapa['retiro-parcial']?.endsOn, '2026-11-06');
assert.equal(porEtapa['retiro-total']?.endsOn, '2026-11-20');

// Dos filas distintas del calendario forman UNA ventana de notas.
assert.equal(porEtapa['notas']?.startsOn, '2026-12-01');
assert.equal(porEtapa['notas']?.endsOn, '2026-12-10');

// La formalización del 1940 cae después del ancla del 1940: no es de este ciclo
// aunque su título sea idéntico al del 1930.
assert.equal(
  del1930.filter((hit) => hit.event === 'inscripcion-regular').length,
  1,
  'la formalización del próximo ciclo no se mezcla con la de este'
);
const del1940 = calendarEventsForTerm(CALENDARIO, { termCode: '1940', termWindow: { startDate: null, endDate: null } });
assert.equal(
  del1940.find((hit) => hit.event === 'inscripcion-regular')?.endsOn,
  '2026-12-17',
  'y sí es del ciclo que arranca el 15 de diciembre'
);

// ── El efecto sobre las etapas ──────────────────────────────────────────────
// Es el punto entero del módulo: sin él, term_events queda vacía y ninguna
// capacidad se apaga jamás.
const eventos = del1930.map((hit) => ({
  event: hit.event,
  session: 'Regular Academic Session',
  startsOn: hit.startsOn,
  endsOn: hit.endsOn,
  source: 'calendario',
  sourceNote: hit.title,
}));

const enModificacion = resolveTermPhase(eventos, CICLO_1930, new Date(2026, 8, 3));
assert.equal(enModificacion.phase, 'modificacion-inscripcion');
assert.equal(enModificacion.confidence, 'fechada');
assert.deepEqual(enModificacion.missing, [], 'las seis etapas dejan de estar sin fecha');

const enDocencia = resolveTermPhase(eventos, CICLO_1930, new Date(2026, 8, 4));
// Un plazo de retiro que vence en noviembre no puede titular la etapa desde
// septiembre: el título ubica en el tiempo y una fecha límite no ubica.
assert.equal(enDocencia.phase, 'docencia', 'al día siguiente de la modificación se está en docencia, no en retiro');
assert.equal(enDocencia.capabilities.inscribir.state, 'cerrada', 'y la inscripción sí queda cerrada');
assert.match(enDocencia.capabilities.inscribir.reason, /calendario académico de PUCMM/, 'diciendo de dónde salió la fecha');
assert.equal(enDocencia.capabilities['dar-de-baja'].state, 'habilitada', 'el retiro parcial sigue abierto hasta noviembre');

const trasRetiroParcial = resolveTermPhase(eventos, CICLO_1930, new Date(2026, 10, 7));
assert.equal(trasRetiroParcial.capabilities['dar-de-baja'].state, 'cerrada');
assert.equal(trasRetiroParcial.capabilities['retiro-total'].state, 'habilitada', 'el retiro total todavía no vence');

const enNotas = resolveTermPhase(eventos, CICLO_1930, new Date(2026, 11, 5));
assert.equal(enNotas.phase, 'notas');

// Sin calendario en disco no se apaga nada: es la promesa que este módulo no
// puede romper el día que la instalación es nueva.
const sinFechas = resolveTermPhase([], CICLO_1930, new Date(2026, 8, 4));
assert.equal(sinFechas.capabilities.inscribir.state, 'advertida', 'no saber advierte, nunca apaga');

// La preinscripción no es una etapa (no gobierna ninguna capacidad) pero es la
// fecha que contesta "¿cuándo voy a poder armar el próximo ciclo?" mientras la
// oferta no exista.
assert.equal(preinscriptionFor(CALENDARIO, '1940')?.startsOn, '2026-11-11');
assert.equal(preinscriptionFor(CALENDARIO, '1940')?.endsOn, '2026-11-13');
assert.equal(preinscriptionFor(CALENDARIO, '1930'), null, 'la del 1930 ya no está publicada y no se inventa');
assert.equal(preinscriptionFor(CALENDARIO, null), null);

console.log('✓ calendario PUCMM → etapas: qué es etapa, de qué ciclo es cada fecha, y qué se cierra en cada una');
