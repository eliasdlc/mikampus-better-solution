// La etapa del ciclo y el mapa de capacidades. Es una función pura a la que la
// fecha entra como parámetro, así que cada transición se prueba por lo que es:
// una tabla de casos, un día antes y un día después de cada borde.
//
// Lo que esta tabla protege, en orden de importancia:
//   1. planear y recomendar no se apagan JAMÁS, en ninguna etapa.
//   2. una capacidad solo se cierra cuando hay una fecha real que lo dice;
//      no saber advierte.
//   3. toda capacidad cerrada trae motivo legible, con la fecha adentro.
import assert from 'node:assert/strict';
import {
  ALWAYS_ON_CAPABILITY_IDS,
  GATED_CAPABILITY_IDS,
  PHASE_IDS,
  resolveTermPhase,
} from '../src/shared/termPhase.ts';

// El ciclo real de Elias: Septiembre de 2026, con las fechas que el portal sí
// publica (MTG_DATES del horario inscrito).
const TERM = { startDate: '2026-09-01', endDate: '2026-12-07' };
const SIN_FECHAS_DE_CICLO = { startDate: null, endDate: null };

// La ventana que el portal publica en Enrollment Dates, tal cual el recon.
const INSCRIPCION = ev('inscripcion-regular', '2026-07-16', '2026-09-03', 'portal');
const MODIFICACION = ev('modificacion-inscripcion', '2026-09-04', '2026-09-08');
const TARDIA = ev('inscripcion-tardia', '2026-09-09', '2026-09-11');
const RETIRO_PARCIAL = ev('retiro-parcial', '2026-10-01', '2026-10-15');
const RETIRO_TOTAL = ev('retiro-total', '2026-10-16', '2026-11-05');
const NOTAS = ev('notas', '2026-12-08', '2026-12-18');

function ev(event, startsOn, endsOn, source = 'usuario') {
  return { event, session: 'Regular Academic Session', startsOn, endsOn, source, sourceNote: null };
}

// Mediodía local: la aritmética es de días de calendario, y así ninguna zona
// horaria puede correr un caso al día anterior.
const on = (iso) => new Date(`${iso}T12:00:00`);

const state = (result, capability) => result.capabilities[capability].state;

// ── La tabla ────────────────────────────────────────────────────────────────
// Cada caso dice qué día es, qué se sabe del ciclo, y qué etapa sale.
const CASES = [
  {
    name: 'sin una sola fecha: no se sabe, y no se apaga nada por no saber',
    today: '2026-09-01',
    term: SIN_FECHAS_DE_CICLO,
    events: [],
    phase: 'desconocida',
    confidence: 'desconocida',
    expect: (r) => {
      assert.equal(state(r, 'inscribir'), 'advertida', 'no saber advierte, nunca cierra');
      assert.equal(state(r, 'mandar-al-carrito'), 'habilitada');
      assert.equal(state(r, 'dar-de-baja'), 'advertida');
      assert.equal(state(r, 'vigilar-cupo'), 'habilitada');
      // La única excepción, y es de seguridad: sin fecha de cierre no hay hasta
      // cuándo guardar la credencial cifrada, y el servidor se niega igual.
      assert.equal(state(r, 'programar-inscripcion'), 'cerrada');
      assert.deepEqual(r.missing.length, 6, 'los seis eventos figuran como faltantes para que la UI los ofrezca');
      assert.equal(r.daysLeft, null);
    },
  },
  {
    name: 'antes de que el ciclo empiece, con sus fechas del portal',
    today: '2026-08-20',
    term: TERM,
    events: [],
    phase: 'pre-inscripcion',
    confidence: 'inferida',
    expect: (r) => {
      assert.equal(r.until, '2026-09-01');
      assert.equal(r.daysLeft, 12);
    },
  },
  {
    name: 'la ventana de inscripción del portal, abierta',
    today: '2026-08-01',
    term: TERM,
    events: [INSCRIPCION],
    phase: 'inscripcion-regular',
    confidence: 'fechada',
    expect: (r) => {
      assert.deepEqual(r.open, ['inscripcion-regular']);
      assert.equal(r.daysLeft, 33);
      assert.equal(state(r, 'inscribir'), 'habilitada');
      assert.equal(state(r, 'mandar-al-carrito'), 'habilitada');
      assert.equal(state(r, 'programar-inscripcion'), 'habilitada');
    },
  },
  {
    name: 'el último día de la ventana todavía cuenta como abierto',
    today: '2026-09-03',
    term: TERM,
    events: [INSCRIPCION],
    phase: 'inscripcion-regular',
    confidence: 'fechada',
    expect: (r) => {
      assert.equal(r.daysLeft, 0, 'el día del cierre queda dentro');
      assert.equal(state(r, 'inscribir'), 'habilitada');
    },
  },
  {
    name: 'al día siguiente cierra, y abre la modificación',
    today: '2026-09-04',
    term: TERM,
    events: [INSCRIPCION, MODIFICACION],
    phase: 'modificacion-inscripcion',
    confidence: 'fechada',
    expect: (r) => {
      assert.deepEqual(r.open, ['modificacion-inscripcion']);
      // Inscribir no se apaga: la modificación es una ventana de inscripción, y
      // si el portal rechaza, lo dice el portal.
      assert.equal(state(r, 'inscribir'), 'advertida');
      assert.equal(state(r, 'mandar-al-carrito'), 'advertida');
      // Programar sí: la credencial cifrada vive hasta el cierre de Enrollment
      // Dates, y esa fecha ya pasó.
      const schedule = r.capabilities['programar-inscripcion'];
      assert.equal(schedule.state, 'cerrada');
      assert.match(schedule.reason, /3 de septiembre de 2026/);
      assert.equal(schedule.reopensOn, null);
    },
  },
  {
    name: 'inscripción tardía: funciona, pero avisa del recargo',
    today: '2026-09-10',
    term: TERM,
    events: [INSCRIPCION, MODIFICACION, TARDIA],
    phase: 'inscripcion-tardia',
    confidence: 'fechada',
    expect: (r) => {
      assert.equal(state(r, 'inscribir'), 'advertida');
      assert.match(r.capabilities.inscribir.reason, /recargo/);
    },
  },
  {
    name: 'docencia: la inscripción cerró de verdad, con fecha',
    today: '2026-09-15',
    term: TERM,
    events: [INSCRIPCION, MODIFICACION, TARDIA, RETIRO_PARCIAL],
    phase: 'docencia',
    confidence: 'inferida',
    expect: (r) => {
      assert.deepEqual(r.open, []);
      const enroll = r.capabilities.inscribir;
      assert.equal(enroll.state, 'cerrada');
      // La fecha del motivo es la última oportunidad real (el cierre de la
      // tardía), no la de la ventana regular: decir el 3 sería adelantar el
      // cierre tres días sobre lo que el calendario dice.
      assert.match(enroll.reason, /cerró el 11 de septiembre de 2026/);
      assert.equal(enroll.reopensOn, null);
      // El carrito no se apaga: nadie probó que el portal lo rechace, y el plan
      // sigue sirviendo para llevarlo impreso a secretaría.
      assert.equal(state(r, 'mandar-al-carrito'), 'advertida');
      assert.equal(state(r, 'vigilar-cupo'), 'advertida', 'vigilar nunca se cierra: sirve para el próximo ciclo');
      assert.equal(state(r, 'dar-de-baja'), 'advertida', 'el retiro todavía no abre, pero dar de baja no está prohibido');
      assert.deepEqual(r.next, { event: 'retiro-parcial', startsOn: '2026-10-01', daysUntil: 16 });
    },
  },
  {
    name: 'retiro parcial abierto',
    today: '2026-10-05',
    term: TERM,
    events: [INSCRIPCION, RETIRO_PARCIAL],
    phase: 'retiro-parcial',
    confidence: 'fechada',
    expect: (r) => {
      assert.equal(state(r, 'dar-de-baja'), 'habilitada');
    },
  },
  {
    name: 'retiro parcial vencido: cerrado, y el motivo dice de quién es la fecha',
    today: '2026-10-20',
    term: TERM,
    events: [INSCRIPCION, RETIRO_PARCIAL, RETIRO_TOTAL],
    phase: 'retiro-total',
    confidence: 'fechada',
    expect: (r) => {
      const drop = r.capabilities['dar-de-baja'];
      assert.equal(drop.state, 'cerrada');
      assert.match(drop.reason, /venció el 15 de octubre de 2026/);
      assert.match(drop.reason, /según el calendario que cargaste/, 'una fecha tipeada nunca se presenta como dato del portal');
      assert.equal(state(r, 'retiro-total'), 'habilitada');
    },
  },
  {
    name: 'notas publicadas',
    today: '2026-12-10',
    term: TERM,
    events: [INSCRIPCION, NOTAS],
    phase: 'notas',
    confidence: 'fechada',
    expect: (r) => {
      assert.equal(state(r, 'ver-notas'), 'habilitada');
      assert.equal(state(r, 'inscribir'), 'cerrada');
    },
  },
  {
    name: 'el ciclo terminó y no hay ninguna ventana abierta',
    today: '2026-12-20',
    term: TERM,
    events: [INSCRIPCION],
    phase: 'ciclo-cerrado',
    confidence: 'inferida',
    expect: (r) => {
      assert.equal(r.since, '2026-12-07');
      assert.equal(state(r, 'ver-notas'), 'habilitada', 'un ciclo cerrado es justo cuando se miran las notas');
    },
  },
  {
    name: 'dos ventanas abiertas a la vez: el título es una, las capacidades son las dos',
    today: '2026-10-05',
    term: TERM,
    events: [ev('modificacion-inscripcion', '2026-10-01', '2026-10-10'), RETIRO_PARCIAL],
    phase: 'modificacion-inscripcion',
    confidence: 'fechada',
    expect: (r) => {
      assert.deepEqual(r.open, ['modificacion-inscripcion', 'retiro-parcial']);
      assert.equal(state(r, 'dar-de-baja'), 'habilitada', 'la capacidad sale de su ventana, no del título de la etapa');
    },
  },
  {
    name: 'media ventana conocida: solo sé cuándo cierra el retiro',
    today: '2026-09-20',
    term: TERM,
    events: [INSCRIPCION, ev('retiro-parcial', null, '2026-10-15')],
    phase: 'retiro-parcial',
    confidence: 'fechada',
    expect: (r) => {
      assert.equal(r.since, null, 'no se inventa la fecha de apertura que falta');
      assert.equal(state(r, 'dar-de-baja'), 'habilitada', 'con la apertura desconocida y el cierre por venir, sigue abierta');
    },
  },
  {
    name: 'sin fechas del ciclo, un evento futuro igual ubica el ciclo',
    today: '2026-07-01',
    term: SIN_FECHAS_DE_CICLO,
    events: [INSCRIPCION],
    phase: 'pre-inscripcion',
    confidence: 'inferida',
    expect: (r) => {
      assert.equal(r.next.event, 'inscripcion-regular');
      assert.equal(r.next.daysUntil, 15);
      assert.equal(state(r, 'programar-inscripcion'), 'habilitada', 'la ventana existe y cierra en el futuro');
    },
  },
];

const seen = new Set();
for (const testCase of CASES) {
  const result = resolveTermPhase(testCase.events, testCase.term, on(testCase.today));
  seen.add(result.phase);

  assert.equal(result.phase, testCase.phase, `${testCase.name}: etapa`);
  assert.equal(result.confidence, testCase.confidence, `${testCase.name}: confianza`);

  // ── La regla dura: planear y recomendar no se apagan nunca ────────────────
  for (const capability of ALWAYS_ON_CAPABILITY_IDS) {
    assert.equal(
      result.capabilities[capability].state,
      'habilitada',
      `${testCase.name}: ${capability} no se puede apagar en ninguna etapa`
    );
  }

  // Toda capacidad cerrada explica por qué, y toda advertencia también: un
  // control apagado sin motivo al lado es una pantalla que no se entiende.
  for (const capability of GATED_CAPABILITY_IDS) {
    const value = result.capabilities[capability];
    if (value.state === 'habilitada') continue;
    assert.ok(value.reason && value.reason.length > 10, `${testCase.name}: ${capability} sin motivo legible`);
    assert.doesNotMatch(value.reason, /\d{4}-\d{2}-\d{2}/, `${testCase.name}: ${capability} muestra una fecha ISO cruda`);
    if (value.state === 'cerrada') assert.ok('reopensOn' in value, `${testCase.name}: ${capability} sin reopensOn`);
  }

  testCase.expect(result);
}

// La tabla cubre todas las etapas que el modelo puede producir. Si alguien
// agrega una etapa nueva, este assert la deja sin caso y falla.
assert.deepEqual([...PHASE_IDS].filter((phase) => !seen.has(phase)), [], 'hay etapas sin un caso en la tabla');

// La fecha entra como parámetro: la misma entrada da el mismo resultado siempre.
const twice = [on('2026-09-15'), on('2026-09-15')].map((today) =>
  JSON.stringify(resolveTermPhase([INSCRIPCION, RETIRO_PARCIAL], TERM, today))
);
assert.equal(twice[0], twice[1], 'el resolutor no lee el reloj del sistema por dentro');

console.log(`✓ fases del ciclo: ${CASES.length} casos, ${PHASE_IDS.length} etapas cubiertas, planear y recomendar siempre encendidos`);
