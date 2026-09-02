import { dayOf, isoToDayNumber } from './terms.ts';

// La etapa del ciclo y lo que se puede hacer en ella. Puro: sin DB, sin red y
// sin leer el reloj por dentro (la fecha entra como parámetro), así que cada
// transición se puede probar por lo que es, una tabla de casos.
//
// La regla que gobierna todo el módulo:
//
//   Una capacidad solo se apaga cuando existe una fecha real que dice que está
//   cerrada. No saber nunca apaga nada: advierte.
//
// Es "prohibido inventar datos" llevado a la UI. El día que mikampus se instala
// no hay una sola fecha cargada, y la app tiene que servir igual. Además el
// portal ya es la autoridad: si la ventana está cerrada, PeopleSoft rechaza y
// action_log guarda su respuesta literal. Acá no se reimplementa el reglamento,
// se anticipa lo que el portal va a decir.

// ── Vocabulario ─────────────────────────────────────────────────────────────

// Las etapas que el calendario de PUCMM nombra. Un evento es una VENTANA, no un
// instante ("del 4 al 8 hay modificación"), y por eso ambas fechas son
// opcionales: media ventana conocida ("sé que el retiro cierra el 15, no cuándo
// abrió") es un dato honesto y se guarda como tal.
//
// Los identificadores van en español porque no tienen equivalente limpio en
// inglés: "modificación de inscripción" no es add/drop y "retiro parcial" no es
// withdraw. El repo ya usa kebab-case español para razones de máquina.
export const TERM_EVENT_IDS = [
  'inscripcion-regular',
  'modificacion-inscripcion',
  'inscripcion-tardia',
  'retiro-parcial',
  'retiro-total',
  'notas',
] as const;
export type TermEventId = (typeof TERM_EVENT_IDS)[number];

// Cómo se nombra cada etapa dentro de un motivo legible.
export const TERM_EVENT_LABELS = {
  'inscripcion-regular': 'la inscripción',
  'modificacion-inscripcion': 'la modificación de inscripción',
  'inscripcion-tardia': 'la inscripción tardía',
  'retiro-parcial': 'el retiro parcial',
  'retiro-total': 'el retiro total',
  notas: 'la publicación de notas',
} as const satisfies Record<TermEventId, string>;

// Quién dijo la fecha. Es lo que permite que un scrape no pise una corrección
// hecha a mano y que un motivo pueda decir "según el calendario que cargaste":
// el estudiante tiene que poder desconfiar de su propio dato.
export const TERM_EVENT_SOURCES = ['portal', 'usuario'] as const;
export type TermEventSource = (typeof TERM_EVENT_SOURCES)[number];

export type TermEvent = {
  event: TermEventId;
  session: string;
  startsOn: string | null; // ISO "YYYY-MM-DD"
  endsOn: string | null;
  source: TermEventSource;
  sourceNote: string | null;
};

export const PHASE_IDS = [
  'pre-inscripcion',
  'inscripcion-regular',
  'modificacion-inscripcion',
  'inscripcion-tardia',
  'docencia',
  'retiro-parcial',
  'retiro-total',
  'notas',
  'ciclo-cerrado',
  'desconocida',
] as const;
export type PhaseId = (typeof PHASE_IDS)[number];

// Las capacidades que ninguna fecha puede apagar, y por qué cada una:
//
//   planear, recomendar   son cálculo local sobre datos que ya tenés. El ciclo
//                         puede estar cerrado hace un año y planear el próximo
//                         sigue siendo exactamente para lo que existe la app.
//   buscar-catalogo       leer no es actuar.
//   exportar-plan         cuando el carrito del portal se cierra, el plan no se
//                         muere: se convierte en la lista que llevás impresa a
//                         secretaría. Apagarlo sería apagar la salida de
//                         emergencia justo cuando hace falta.
//   sincronizar, ver-notas  traer y mirar TUS datos del portal no depende de
//                         ninguna etapa del calendario.
//
// Están fuera del cálculo por construcción, no por convención: `gatedCapabilities`
// solo puede devolver estados para GATED_CAPABILITY_IDS, y el tipo de esta
// lista no se cruza con el de aquella. Para apagar `planear` habría que mover
// su nombre de una lista a la otra a mano, que es exactamente la decisión que
// esta separación obliga a hacer explícita.
export const ALWAYS_ON_CAPABILITY_IDS = [
  'planear',
  'recomendar',
  'buscar-catalogo',
  'exportar-plan',
  'sincronizar',
  'ver-notas',
] as const;
export type AlwaysOnCapabilityId = (typeof ALWAYS_ON_CAPABILITY_IDS)[number];

// Las que sí dependen del calendario, porque cada una termina en una pantalla
// de PeopleSoft que puede rechazar la acción.
export const GATED_CAPABILITY_IDS = [
  'mandar-al-carrito',
  'inscribir',
  'programar-inscripcion',
  'vigilar-cupo',
  'dar-de-baja',
  'retiro-total',
] as const;
export type GatedCapabilityId = (typeof GATED_CAPABILITY_IDS)[number];

export type CapabilityId = AlwaysOnCapabilityId | GatedCapabilityId;

// 'advertida' es un control que FUNCIONA y avisa; 'cerrada' es un control
// apagado, y siempre con motivo legible y, si se conoce, la fecha en que
// vuelve. Un control apagado sin motivo visible es una app que no explica.
export type CapabilityState =
  | { state: 'habilitada' }
  | { state: 'advertida'; reason: string }
  | { state: 'cerrada'; reason: string; reopensOn: string | null };

export type PhaseResolution = {
  phase: PhaseId;
  confidence: 'fechada' | 'inferida' | 'desconocida';
  since: string | null;
  until: string | null;
  daysLeft: number | null;
  open: TermEventId[]; // TODAS las ventanas que contienen a hoy, no solo la del título
  next: { event: TermEventId; startsOn: string; daysUntil: number } | null;
  missing: TermEventId[]; // eventos sin fecha: lo que la UI puede ofrecer cargar
  capabilities: Record<CapabilityId, CapabilityState>;
};

// ── Fechas legibles ─────────────────────────────────────────────────────────

const MONTHS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

// "2026-09-03" → "3 de septiembre de 2026". Los motivos los lee una persona, y
// una fecha ISO en medio de una frase es una fecha que hay que traducir.
function readableDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${Number(m[3])} de ${MONTHS[Number(m[2]) - 1]} de ${m[1]}`;
}

// Una fecha del estudiante nunca se presenta con la misma autoridad que una del
// portal: si el control está apagado por algo que él mismo tipeó, tiene que
// poder dudar de su propio dato.
function attributed(iso: string, source: TermEventSource): string {
  const date = readableDate(iso);
  return source === 'usuario' ? `${date}, según el calendario que cargaste` : date;
}

// ── Estado de cada ventana ──────────────────────────────────────────────────

type WindowState = 'abierta' | 'futura' | 'vencida' | 'desconocida';

type DateWindow = {
  startsOn: string | null;
  endsOn: string | null;
  source: TermEventSource;
};

type EventWindow = DateWindow & {
  event: TermEventId;
  state: WindowState;
};

// Varias sesiones pueden traer el mismo evento del mismo ciclo (una sesión
// regular y una de ocho semanas). Para decidir una etapa se toma la ventana más
// ancha, y una fecha desconocida ensancha: la app no puede decir "cerrado"
// mientras alguna sesión siga abierta. La procedencia se degrada a 'usuario' si
// alguna de las dos lo es, porque el motivo tiene que advertir por la parte
// menos autoritativa del dato.
function widen(a: DateWindow | undefined, b: DateWindow): DateWindow {
  if (!a) return b;
  const earliest = (x: string | null, y: string | null) => (x === null || y === null ? null : x < y ? x : y);
  const latest = (x: string | null, y: string | null) => (x === null || y === null ? null : x > y ? x : y);
  return {
    startsOn: earliest(a.startsOn, b.startsOn),
    endsOn: latest(a.endsOn, b.endsOn),
    source: a.source === 'usuario' || b.source === 'usuario' ? 'usuario' : 'portal',
  };
}

// El estado de una ventana contra hoy. Las dos ramas permisivas son
// deliberadas: con solo la fecha de cierre conocida y hoy antes de ella, la
// ventana cuenta como abierta, y con solo la de apertura ya pasada, también.
// Ignorar la mitad que falta para declarar algo cerrado sería apagar por no
// saber, que es justo lo que este módulo no hace.
function stateOf(window: { startsOn: string | null; endsOn: string | null }, todayNum: number): WindowState {
  const start = window.startsOn ? isoToDayNumber(window.startsOn) : null;
  const end = window.endsOn ? isoToDayNumber(window.endsOn) : null;
  if (start === null && end === null) return 'desconocida';
  if (start !== null && todayNum < start) return 'futura';
  if (end !== null && todayNum > end) return 'vencida';
  return 'abierta';
}

// ── El resolutor ────────────────────────────────────────────────────────────

// Cuando varias ventanas están abiertas a la vez (en PUCMM se solapan de
// verdad: modificación corre sobre docencia, notas sobre el final de docencia),
// esta precedencia decide únicamente el TÍTULO. Las capacidades no se derivan
// de él: se derivan de las ventanas abiertas, que es donde está la información.
const PHASE_PRECEDENCE: readonly TermEventId[] = [
  'inscripcion-tardia',
  'modificacion-inscripcion',
  'retiro-total',
  'retiro-parcial',
  'inscripcion-regular',
  'notas',
];

const ENROLLMENT_EVENTS: readonly TermEventId[] = [
  'inscripcion-regular',
  'modificacion-inscripcion',
  'inscripcion-tardia',
];

const HABILITADA: CapabilityState = { state: 'habilitada' };

/**
 * Resuelve la etapa de un ciclo y lo que se puede hacer en ella.
 *
 * `events` son las ventanas conocidas de UN ciclo (las que el portal publicó
 * más las que el estudiante cargó). `term` son las fechas del ciclo mismo, que
 * sí vienen del portal y permiten inferir docencia y cierre sin que nadie tipee
 * nada. `today` entra como parámetro y nunca se lee del sistema acá dentro.
 */
export function resolveTermPhase(
  events: readonly TermEvent[],
  term: { startDate: string | null; endDate: string | null },
  today: Date
): PhaseResolution {
  const todayNum = dayOf(today);

  const windows = new Map<TermEventId, EventWindow>();
  for (const event of events) {
    const merged = widen(windows.get(event.event), {
      startsOn: event.startsOn,
      endsOn: event.endsOn,
      source: event.source,
    });
    windows.set(event.event, { ...merged, event: event.event, state: stateOf(merged, todayNum) });
  }

  const at = (id: TermEventId): EventWindow =>
    windows.get(id) ?? { event: id, startsOn: null, endsOn: null, source: 'portal', state: 'desconocida' };

  const open = TERM_EVENT_IDS.filter((id) => at(id).state === 'abierta');
  const missing = TERM_EVENT_IDS.filter((id) => !windows.has(id));

  // El próximo evento que empieza: el de fecha de apertura más temprana entre
  // las que todavía no llegaron.
  const upcoming = TERM_EVENT_IDS
    .map((id) => at(id))
    .filter((w): w is EventWindow & { startsOn: string } => w.state === 'futura' && w.startsOn !== null)
    .sort((a, b) => a.startsOn.localeCompare(b.startsOn));
  const nextWindow = upcoming[0] ?? null;
  const next = nextWindow
    ? {
        event: nextWindow.event,
        startsOn: nextWindow.startsOn,
        daysUntil: (isoToDayNumber(nextWindow.startsOn) ?? todayNum) - todayNum,
      }
    : null;

  const { phase, confidence, since, until } = titleOf(open, at, term, todayNum, upcoming.length > 0);
  const untilDay = until ? isoToDayNumber(until) : null;

  return {
    phase,
    confidence,
    since,
    until,
    daysLeft: untilDay === null ? null : untilDay - todayNum,
    open,
    next,
    missing,
    capabilities: {
      // Las estructuralmente inapagables, escritas como literal para que el
      // compilador no deje agregar una capacidad sin decidir de qué lado cae.
      planear: HABILITADA,
      recomendar: HABILITADA,
      'buscar-catalogo': HABILITADA,
      'exportar-plan': HABILITADA,
      sincronizar: HABILITADA,
      'ver-notas': HABILITADA,
      ...gatedCapabilities(at),
    },
  };
}

// El título de la etapa. Con una ventana abierta el título es fechado; sin
// ninguna se infiere de las fechas del ciclo, que también son del portal (una
// inferencia sobre un dato real, no un invento); sin nada de eso, 'desconocida'.
function titleOf(
  open: readonly TermEventId[],
  at: (id: TermEventId) => EventWindow,
  term: { startDate: string | null; endDate: string | null },
  todayNum: number,
  hasUpcoming: boolean
): { phase: PhaseId; confidence: PhaseResolution['confidence']; since: string | null; until: string | null } {
  const leading = PHASE_PRECEDENCE.find((id) => open.includes(id));
  if (leading) {
    const window = at(leading);
    return { phase: leading, confidence: 'fechada', since: window.startsOn, until: window.endsOn };
  }

  const termStart = term.startDate ? isoToDayNumber(term.startDate) : null;
  const termEnd = term.endDate ? isoToDayNumber(term.endDate) : null;

  if (termStart !== null && todayNum < termStart) {
    return { phase: 'pre-inscripcion', confidence: 'inferida', since: null, until: term.startDate };
  }
  if (termEnd !== null && todayNum > termEnd) {
    return { phase: 'ciclo-cerrado', confidence: 'inferida', since: term.endDate, until: null };
  }
  if (termStart !== null || termEnd !== null) {
    return { phase: 'docencia', confidence: 'inferida', since: term.startDate, until: term.endDate };
  }
  // Sin fechas del ciclo, un evento que todavía no llegó igual ubica: si lo
  // único que sabemos del ciclo está en el futuro, no empezó.
  if (hasUpcoming) return { phase: 'pre-inscripcion', confidence: 'inferida', since: null, until: null };
  return { phase: 'desconocida', confidence: 'desconocida', since: null, until: null };
}

// El estado de las capacidades que sí dependen del calendario. Se derivan de
// las VENTANAS, nunca del título: durante docencia puede estar abierta la
// modificación, y decidir por etiqueta perdería esa información.
function gatedCapabilities(at: (id: TermEventId) => EventWindow): Record<GatedCapabilityId, CapabilityState> {
  const enrollment = ENROLLMENT_EVENTS.map(at);
  const openEnrollment = enrollment.filter((w) => w.state === 'abierta');
  const futureEnrollment = enrollment.filter((w) => w.state === 'futura');
  const expiredEnrollment = enrollment.filter((w) => w.state === 'vencida');
  // "La inscripción está cerrada" solo si alguna ventana venció y ninguna otra
  // está abierta ni por venir. Con todo desconocido, no está cerrada: es que no
  // sabemos.
  const enrollmentClosed =
    expiredEnrollment.length > 0 && openEnrollment.length === 0 && futureEnrollment.length === 0;
  const lastEnrollmentEnd = expiredEnrollment
    .filter((w): w is EventWindow & { endsOn: string } => w.endsOn !== null)
    .sort((a, b) => b.endsOn.localeCompare(a.endsOn))[0];
  const reopensOn = futureEnrollment.map((w) => w.startsOn).filter((d): d is string => d !== null).sort()[0] ?? null;

  return {
    // El carrito nunca se apaga: mandar una materia al carrito con la ventana
    // cerrada puede fallar en el portal, pero eso lo dice el portal. Lo que la
    // app sabe con certeza es que el plan sigue siendo tuyo y exportable.
    'mandar-al-carrito': enrollmentCartState(openEnrollment, enrollmentClosed, lastEnrollmentEnd),
    inscribir: enrollState(openEnrollment, enrollmentClosed, lastEnrollmentEnd, reopensOn),
    'programar-inscripcion': scheduleState(at('inscripcion-regular'), reopensOn),
    // Un cupo se libera cuando se libera, y vigilar durante docencia es
    // exactamente el caso de uso de cara al próximo ciclo: nunca se cierra.
    'vigilar-cupo': enrollmentClosed
      ? {
          state: 'advertida',
          reason: `La inscripción de este ciclo cerró${
            lastEnrollmentEnd ? ` el ${attributed(lastEnrollmentEnd.endsOn, lastEnrollmentEnd.source)}` : ''
          }. Vigilar un cupo sirve para el próximo ciclo o para una modificación.`,
        }
      : HABILITADA,
    'dar-de-baja': windowState(at('retiro-parcial'), {
      future: (date) => `El retiro parcial empieza el ${date}. Antes de esa fecha, dar de baja depende de la ventana de inscripción.`,
      expired: (date) => `El retiro parcial de este ciclo venció el ${date}.`,
      unknown: 'No sé hasta cuándo se puede dar de baja en este ciclo. Cargá esa fecha del calendario académico.',
    }),
    // mikampus no ejecuta un retiro total (es presencial): esta capacidad
    // gobierna una tarjeta informativa con la fecha límite, nunca un botón.
    'retiro-total': windowState(at('retiro-total'), {
      future: (date) => `El retiro total abre el ${date}. Se hace en secretaría, no desde acá.`,
      expired: (date) => `El plazo de retiro total de este ciclo venció el ${date}.`,
      unknown: 'No sé hasta cuándo se puede retirar el ciclo completo. Cargá esa fecha del calendario académico.',
    }),
  };
}

function enrollmentCartState(
  openEnrollment: readonly EventWindow[],
  enrollmentClosed: boolean,
  lastEnd: (EventWindow & { endsOn: string }) | undefined
): CapabilityState {
  if (openEnrollment.some((w) => w.event === 'inscripcion-regular')) return HABILITADA;
  if (openEnrollment.length > 0) {
    return {
      state: 'advertida',
      reason: `Estás en ${TERM_EVENT_LABELS[openEnrollment[0].event]}: el carrito del portal puede estar cerrado. Tu plan se guarda y se exporta igual.`,
    };
  }
  if (enrollmentClosed) {
    return {
      state: 'advertida',
      reason: `La inscripción cerró${lastEnd ? ` el ${attributed(lastEnd.endsOn, lastEnd.source)}` : ''}. El carrito sirve para armar tu lista, pero el portal ya no inscribe.`,
    };
  }
  return HABILITADA;
}

function enrollState(
  openEnrollment: readonly EventWindow[],
  enrollmentClosed: boolean,
  lastEnd: (EventWindow & { endsOn: string }) | undefined,
  reopensOn: string | null
): CapabilityState {
  const regular = openEnrollment.find((w) => w.event === 'inscripcion-regular');
  if (regular) return HABILITADA;
  const late = openEnrollment.find((w) => w.event === 'inscripcion-tardia');
  if (late) return { state: 'advertida', reason: 'Estás en inscripción tardía: el portal puede aplicar recargo.' };
  if (openEnrollment.length > 0) {
    return {
      state: 'advertida',
      reason: `Estás en ${TERM_EVENT_LABELS[openEnrollment[0].event]}: el portal puede rechazar la inscripción de una materia nueva.`,
    };
  }
  if (enrollmentClosed) {
    return {
      state: 'cerrada',
      reason: `La inscripción de este ciclo cerró${lastEnd ? ` el ${attributed(lastEnd.endsOn, lastEnd.source)}` : ''}.`,
      reopensOn,
    };
  }
  return {
    state: 'advertida',
    reason: reopensOn
      ? `La inscripción abre el ${readableDate(reopensOn)}: hasta entonces el portal puede rechazarla.`
      : 'No sé en qué etapa está el ciclo. Cargá el calendario académico o actualizá tu ventana de inscripción.',
  };
}

// La única capacidad donde no saber SÍ apaga, y la razón no es el reglamento:
// programar una inscripción desatendida guarda tu credencial cifrada en disco
// hasta el cierre de la ventana. Sin esa fecha no hay hasta cuándo. Mira
// exactamente la misma ventana que el servidor (la de Enrollment Dates, no la
// modificación ni la tardía) porque es la fila de la que sale el vencimiento de
// la credencial en unattendedExpiry: prometer acá lo que allá se niega sería
// peor que negarlo. Es frontera de seguridad, no una regla de calendario, y por
// eso es la excepción declarada a "no saber nunca apaga nada".
function scheduleState(regular: EventWindow, reopensOn: string | null): CapabilityState {
  if (regular.state === 'vencida' && regular.endsOn) {
    return {
      state: 'cerrada',
      reason: `La ventana de inscripción cerró el ${attributed(regular.endsOn, regular.source)}: no hay hasta cuándo guardar la credencial.`,
      reopensOn,
    };
  }
  if (regular.endsOn && regular.state !== 'desconocida') return HABILITADA;
  return {
    state: 'cerrada',
    reason: 'Falta la ventana de inscripción del portal: la credencial cifrada solo se guarda hasta que esa fecha cierre.',
    reopensOn: null,
  };
}

// El patrón común de una capacidad gobernada por una sola ventana: abierta
// habilita, vencida cierra con su fecha, futura y desconocida advierten.
function windowState(
  window: EventWindow,
  reasons: { future: (date: string) => string; expired: (date: string) => string; unknown: string }
): CapabilityState {
  if (window.state === 'abierta') return HABILITADA;
  if (window.state === 'vencida' && window.endsOn) {
    return { state: 'cerrada', reason: reasons.expired(attributed(window.endsOn, window.source)), reopensOn: null };
  }
  if (window.state === 'futura' && window.startsOn) {
    return { state: 'advertida', reason: reasons.future(attributed(window.startsOn, window.source)) };
  }
  return { state: 'advertida', reason: reasons.unknown };
}
