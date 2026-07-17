import { termSortKey } from './gpa.ts';

// El modelo de tiempo de la app. PeopleSoft nombra un término de dos formas que
// nada cruza: un código STRM ("1930") en el class search y las inscripciones, y
// una etiqueta en español ("Septiembre de 2026") en el histórico de notas. Este
// módulo es puro y testeado (es el gate de la Fase 6): decide, contra la fecha
// real, cuál ciclo corre hoy y cuál es el siguiente, con o sin fechas exactas.
//
// El calendario de PUCMM son tres ciclos al año, nombrados por su mes de inicio:
// Enero (ene–abr), Abril (may–ago) y Septiembre (sep–dic). termSortKey ya lleva
// "Enero de 2026" a "2026-01"; acá ese mes es la llave del ciclo.

export type Term = {
  code: string | null;
  label: string | null;
  startDate: string | null; // ISO "YYYY-MM-DD"
  endDate: string | null;
};

export type ResolvedTerm = Term & {
  sortKey: string | null; // "YYYY-MM" para ordenar; null si la etiqueta no matchea
  isCurrent: boolean;
  isNext: boolean;
};

export type TermResolution = {
  terms: ResolvedTerm[]; // ordenados cronológicamente (los sin fecha, al final)
  current: ResolvedTerm | null; // el ciclo que contiene a hoy; null si estás entre ciclos
  next: ResolvedTerm | null; // el primer ciclo que empieza después de hoy
};

// Un día como número entero (días desde epoch, en UTC) para comparar fechas sin
// que la zona horaria meta un día de diferencia: acá solo importa el calendario.
function dayNumber(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

// "2026-09-01" → su número de día. Se parsea el string a mano (no `new Date`)
// para no arrastrar la hora ni la zona: un término es fechas de calendario.
function isoToDayNumber(iso: string): number | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return dayNumber(Number(m[1]), Number(m[2]), Number(m[3]));
}

// Cualquier mes del año → la etiqueta del ciclo al que pertenece. Sirve para
// derivar la etiqueta de un STRM cuando solo tenemos su fecha de inicio: una
// inscripción que arranca el 1 de septiembre es del ciclo "Septiembre".
export function cycleLabel(month: number, year: number): string {
  if (month <= 4) return `Enero de ${year}`;
  if (month <= 8) return `Abril de ${year}`;
  return `Septiembre de ${year}`;
}

// La ventana aproximada de un ciclo a partir de su sortKey ("YYYY-MM"). El mes
// es el del NOMBRE del ciclo (Enero=01, Abril=04, Septiembre=09), no el de la
// mitad del ciclo: el ciclo "Abril" corre may–ago, no en abril. Es el fallback
// cuando el término no trae fechas reales; las tres ventanas parten el año sin
// huecos ni solapes, así que todo día cae en exacto un ciclo. Devuelve
// [primer día, último día] como números de día.
function impliedWindow(sortKey: string): [number, number] | null {
  const m = sortKey.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month === 1) return [dayNumber(year, 1, 1), dayNumber(year, 4, 30)]; // Enero: ene–abr
  if (month === 4) return [dayNumber(year, 5, 1), dayNumber(year, 8, 31)]; // Abril: may–ago
  if (month === 9) return [dayNumber(year, 9, 1), dayNumber(year, 12, 31)]; // Septiembre: sep–dic
  return null; // una etiqueta que no es de los tres ciclos no se ubica en el año
}

// La etiqueta de un término: la que traiga, o una derivada de su fecha de inicio
// (un STRM inscrito sin etiqueta, pero con MTG_DATES, sí se puede nombrar).
export function labelFor(term: Term): string | null {
  if (term.label) return term.label;
  if (term.startDate) {
    const m = term.startDate.match(/^(\d{4})-(\d{2})/);
    if (m) return cycleLabel(Number(m[2]), Number(m[1]));
  }
  return null;
}

function sortKeyFor(term: Term): string | null {
  const label = labelFor(term);
  return label ? termSortKey(label) : null;
}

// La ventana [inicio, fin] de un término: sus fechas reales si las tiene, si no
// la ventana implícita del ciclo. null si no hay ni fechas ni etiqueta ubicable.
function windowFor(term: Term, sortKey: string | null): [number, number] | null {
  if (term.startDate && term.endDate) {
    const start = isoToDayNumber(term.startDate);
    const end = isoToDayNumber(term.endDate);
    if (start !== null && end !== null) return [start, end];
  }
  return sortKey ? impliedWindow(sortKey) : null;
}

// Resuelve, contra `today`, cuál término corre hoy y cuál es el siguiente.
//
//   current = el término cuya ventana contiene a hoy. Si hoy cae en un hueco
//             entre ciclos (posible solo con fechas reales), current es null:
//             mostrar un ciclo ya terminado como "actual" sería mentir.
//   next    = el primer término que empieza estrictamente después de hoy.
//
// Un término sin fecha ni etiqueta ubicable (sortKey null) no puede resolverse:
// queda en la lista pero nunca es current ni next.
export function resolveTerms(input: Term[], today: Date = new Date()): TermResolution {
  const todayNum = dayNumber(today.getFullYear(), today.getMonth() + 1, today.getDate());

  const annotated = input.map((term) => {
    const sortKey = sortKeyFor(term);
    const window = windowFor(term, sortKey);
    return { term, sortKey, window, label: labelFor(term) };
  });

  // current: entre los que contienen a hoy, gana el de fechas reales y luego el
  // de inicio más tardío (si dos ventanas implícitas se tocaran en un borde).
  const containing = annotated.filter((a) => a.window && a.window[0] <= todayNum && todayNum <= a.window[1]);
  containing.sort((a, b) => {
    const aReal = a.term.startDate ? 1 : 0;
    const bReal = b.term.startDate ? 1 : 0;
    if (aReal !== bReal) return bReal - aReal;
    return b.window![0] - a.window![0];
  });
  const currentEntry = containing[0] ?? null;

  // next: entre los que empiezan después de hoy, el de inicio más temprano.
  const upcoming = annotated
    .filter((a) => a.window && a.window[0] > todayNum && a !== currentEntry)
    .sort((a, b) => a.window![0] - b.window![0]);
  const nextEntry = upcoming[0] ?? null;

  const terms: ResolvedTerm[] = annotated
    .map((a) => ({
      code: a.term.code,
      label: a.label,
      startDate: a.term.startDate,
      endDate: a.term.endDate,
      sortKey: a.sortKey,
      isCurrent: a === currentEntry,
      isNext: a === nextEntry,
    }))
    .sort((a, b) => {
      // Cronológico; los que no tienen sortKey van al final, estables por etiqueta.
      if (a.sortKey === null) return b.sortKey === null ? 0 : 1;
      if (b.sortKey === null) return -1;
      return a.sortKey.localeCompare(b.sortKey);
    });

  return {
    terms,
    current: terms.find((t) => t.isCurrent) ?? null,
    next: terms.find((t) => t.isNext) ?? null,
  };
}
