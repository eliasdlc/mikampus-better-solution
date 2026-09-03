import type { TermEventId } from './termPhase.ts';

// El puente entre el calendario público de PUCMM y las etapas del ciclo.
//
// Por qué hace falta: mikampus ya guardaba las 57 fechas oficiales del año, y
// al mismo tiempo declaraba no saber cuándo era la modificación de inscripción.
// Los dos datos vivían en la misma base. El calendario se publica en prosa
// ("Fecha límite para retiro parcial") y las capacidades se deciden sobre
// identificadores tipados; sin esta traducción, ninguna etapa se cierra nunca y
// la regla "no saber nunca apaga nada" se cumple al pie de la letra para
// siempre.
//
// Es puro: sin base, sin red y sin leer el reloj. Cada regla se prueba por lo
// que es, una tabla de casos.
//
// Lo que NO matchea no se acomoda a la regla más parecida: se descarta y se
// puede reportar. Media docena de fechas ciertas valen más que veinte
// aproximadas, y una etapa apagada por una fecha mal mapeada es peor que una
// etapa que dice no saber.

export type CalendarRow = {
  id: string;
  title: string;
  startsOn: string;
  endsOn: string;
};

// Una fecha del calendario ya interpretada: qué etapa nombra, de qué ciclo, y
// si aporta la apertura o el cierre de la ventana.
export type CalendarPhaseHit = {
  id: string;
  event: TermEventId;
  // El STRM cuando el título lo nombra ("para el Ciclo 1940"). Null cuando hay
  // que deducirlo por las fechas del ciclo.
  termCode: string | null;
  startsOn: string | null;
  endsOn: string | null;
  title: string;
};

// Qué aporta una fecha suelta. El calendario publica sobre todo "fecha límite
// para X", que es el CIERRE de una ventana cuya apertura no publica. Media
// ventana conocida es un dato honesto y termPhase ya la soporta.
type Aporte = 'ventana' | 'cierre' | 'apertura';

type Regla = {
  event: TermEventId;
  aporte: Aporte;
  // Se evalúa sobre el título normalizado (sin acentos, minúsculas, un espacio).
  match: RegExp;
};

// El orden importa: la primera regla que matchea gana. Las más específicas van
// primero, porque "fecha limite para retiro total" también contiene "retiro".
const REGLAS: readonly Regla[] = [
  // La modificación es la única que el calendario publica como rango real.
  { event: 'modificacion-inscripcion', aporte: 'ventana', match: /^modificacion a la inscripcion$/ },
  // "Pago tardío de selección de asignaturas (Inscripciones tardías...)" es la
  // fecha en que el portal deja inscribir con recargo.
  { event: 'inscripcion-tardia', aporte: 'ventana', match: /inscripciones tardias/ },
  // La formalización es el acto que cierra la inscripción regular del ciclo: es
  // el último día en que el portal acepta la selección de asignaturas.
  { event: 'inscripcion-regular', aporte: 'cierre', match: /formalizacion de la inscripcion/ },
  { event: 'retiro-parcial', aporte: 'cierre', match: /^fecha limite para retiro parcial$/ },
  { event: 'retiro-total', aporte: 'cierre', match: /^fecha limite para retiro total$/ },
  { event: 'notas', aporte: 'apertura', match: /^inicio periodo de reporte de calificaciones finales$/ },
  { event: 'notas', aporte: 'cierre', match: /fecha limite para solicitar revision de calificaciones finales/ },
];

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// PUCMM nombra el ciclo dentro del propio título cuando la fecha no es del
// ciclo en curso ("Fecha límite para modificar preinscripción para el Ciclo
// 1940"). Cuando lo hace, es la atribución más confiable que existe: no hay que
// deducir nada de un rango de fechas.
const CICLO_EN_TITULO = /\bciclo (\d{4})\b/;

export function termCodeInTitle(title: string): string | null {
  return normalizeTitle(title).match(CICLO_EN_TITULO)?.[1] ?? null;
}

/**
 * Traduce una fila del calendario oficial a la etapa que nombra.
 *
 * Devuelve null cuando el título no corresponde a ninguna etapa que gobierne
 * una capacidad, que es el caso de la mayoría del calendario: asuetos, pagos de
 * matrícula, graduaciones y evaluación profesoral no deciden qué puede hacer la
 * app.
 */
export function matchCalendarEvent(row: CalendarRow): CalendarPhaseHit | null {
  const normalized = normalizeTitle(row.title);
  const regla = REGLAS.find((candidate) => candidate.match.test(normalized));
  if (!regla) return null;
  const base = { id: row.id, event: regla.event, termCode: termCodeInTitle(row.title), title: row.title };
  if (regla.aporte === 'ventana') return { ...base, startsOn: row.startsOn, endsOn: row.endsOn };
  if (regla.aporte === 'cierre') return { ...base, startsOn: null, endsOn: row.endsOn };
  return { ...base, startsOn: row.startsOn, endsOn: null };
}

// El calendario publica el arranque administrativo de cada ciclo nombrándolo
// ("Inicio de Ciclo 1930"), y esa fila es el mejor delimitador que existe: un
// ciclo va desde su propio inicio hasta el inicio del siguiente.
//
// Hace falta porque las fechas de inscripción CAEN ANTES de que el ciclo
// empiece. La formalización del 1930 es el 25 de agosto y la docencia arranca
// el 1 de septiembre: atribuir por la ventana del término dejaría fuera
// justamente la fecha que cierra la inscripción, que es la que más decide.
const ANCLA_DE_CICLO = /^inicio de ciclo (\d{4})$/;

export type TermAnchor = { code: string; startsOn: string };

export function termAnchors(rows: readonly CalendarRow[]): TermAnchor[] {
  const byCode = new Map<string, string>();
  for (const row of rows) {
    const code = normalizeTitle(row.title).match(ANCLA_DE_CICLO)?.[1];
    if (!code) continue;
    const previous = byCode.get(code);
    if (!previous || row.startsOn < previous) byCode.set(code, row.startsOn);
  }
  return [...byCode.entries()]
    .map(([code, startsOn]) => ({ code, startsOn }))
    .sort((a, b) => a.startsOn.localeCompare(b.startsOn));
}

/**
 * Las etapas que el calendario oficial aporta para UN ciclo.
 *
 * `termCode` es el STRM del ciclo que se está resolviendo y `termWindow` sus
 * fechas. Una fila que nombra OTRO ciclo se descarta siempre, aunque caiga
 * dentro de la ventana: el título es más autoritativo que el rango.
 *
 * Dos filas de la misma etapa se funden en una ventana: es lo que une "inicio
 * del período de reporte de calificaciones" con "fecha límite para solicitar
 * revisión" en una sola etapa de notas.
 */
export function calendarEventsForTerm(
  rows: readonly CalendarRow[],
  { termCode, termWindow }: { termCode: string | null; termWindow: { startDate: string | null; endDate: string | null } }
): CalendarPhaseHit[] {
  const span = administrativeSpan(rows, termCode);
  const byEvent = new Map<TermEventId, CalendarPhaseHit>();
  for (const row of rows) {
    const hit = matchCalendarEvent(row);
    if (!hit) continue;
    if (hit.termCode) {
      if (hit.termCode !== termCode) continue;
    } else if (!within(row, span ?? { ...termWindow, endExclusive: false })) {
      continue;
    }
    const previous = byEvent.get(hit.event);
    byEvent.set(hit.event, previous ? mergeHits(previous, hit) : hit);
  }
  return [...byEvent.values()];
}

// De "Inicio de Ciclo N" hasta el día anterior a "Inicio de Ciclo N+1". Sin
// ancla para este ciclo se devuelve null y quien llama cae en la ventana de
// docencia, que es peor pero sigue siendo un dato real.
function administrativeSpan(rows: readonly CalendarRow[], termCode: string | null): Span | null {
  if (!termCode) return null;
  const anchors = termAnchors(rows);
  const index = anchors.findIndex((anchor) => anchor.code === termCode);
  if (index === -1) return null;
  return { startDate: anchors[index].startsOn, endDate: anchors[index + 1]?.startsOn ?? null, endExclusive: true };
}

// El tramo al que se atribuye una fila. `endExclusive` distingue los dos
// orígenes: el arranque del ciclo siguiente NO es de este ciclo, pero el último
// día de docencia SÍ lo es.
type Span = { startDate: string | null; endDate: string | null; endExclusive: boolean };

// Una fila sin ciclo en el título pertenece al ciclo cuyo tramo la contiene.
// Sin ninguno de los dos bordes no se puede atribuir, y hacerlo por cercanía
// sería inventar: se descarta.
function within(row: CalendarRow, { startDate, endDate, endExclusive }: Span): boolean {
  if (!startDate && !endDate) return false;
  if (startDate && row.endsOn < startDate) return false;
  if (endDate && (endExclusive ? row.startsOn >= endDate : row.startsOn > endDate)) return false;
  return true;
}

// Al fundir dos filas de la misma etapa, cada una aporta el extremo que sabe.
// La apertura más temprana y el cierre más tardío, que es la misma regla de
// ensanchado que termPhase aplica entre sesiones.
function mergeHits(a: CalendarPhaseHit, b: CalendarPhaseHit): CalendarPhaseHit {
  const earliest = (x: string | null, y: string | null) => (x === null ? y : y === null ? x : x < y ? x : y);
  const latest = (x: string | null, y: string | null) => (x === null ? y : y === null ? x : x > y ? x : y);
  return {
    ...a,
    startsOn: earliest(a.startsOn, b.startsOn),
    endsOn: latest(a.endsOn, b.endsOn),
    // El título compuesto deja ver de qué dos filas salió la ventana.
    title: a.title === b.title ? a.title : `${a.title} · ${b.title}`,
  };
}
