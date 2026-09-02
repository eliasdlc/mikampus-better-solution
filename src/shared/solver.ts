import type { Meeting } from './schemas.ts';
import { meetingsOverlap, toMinutes, type DayCode } from './meetings.ts';
import type { CampusCode } from './campus.ts';

// Solver del builder (plan §2 y §5.4): enumera las combinaciones de secciones
// sin choque y las rankea por heurísticas configurables. Backtracking simple
// con poda por choque: con 8 materias × 6 secciones el espacio es diminuto y
// se resuelve local en <10ms — sin librerías, sin worker, sin red.
//
// El solver es deliberadamente tonto respecto a candados: el caller (builder)
// fija una sección dejándola como única candidata de su materia. Así "candado"
// no es un concepto más acá adentro.

export type CandidateSection = {
  id: number;
  courseId: number;
  code: string;
  title: string;
  classNbr: string;
  section: string | null;
  component: string | null;
  instructor: string | null;
  meetings: Meeting[];
  // Opcional porque no todo caller lo tiene (el builder arma candidatas desde
  // el plan, que no siempre pasó por el catálogo). Sin campus, un filtro por
  // campus no puede excluir la sección: no saber nunca descarta.
  campus?: CampusCode | null;
};

export type CandidateCourse = {
  courseId: number;
  code: string;
  title: string;
  sections: CandidateSection[];
};

// Los tres sliders del builder. Pesos 0–1; 0 apaga la heurística.
export type Weights = {
  gaps: number; // huecos muertos entre clases
  earlyStarts: number; // madrugones (clases antes de las 9:00)
  fewDays: number; // compactar en pocos días (días libres completos)
};

export const DEFAULT_WEIGHTS: Weights = { gaps: 0.5, earlyStarts: 0.5, fewDays: 0.5 };

// Las condiciones DURAS, que son otra cosa que los pesos. Un peso dice "prefiero
// menos huecos" y siempre devuelve algo; una condición dice "no puedo antes de
// las 10" y hace que un horario que la viola deje de existir. Mezclarlas sería
// prometer un horario imposible con penalización alta.
//
// Todo campo en null o vacío es "sin condición": el estudiante que no pide nada
// obtiene exactamente el comportamiento de antes.
export type ScheduleConstraints = {
  earliestStart: string | null; // "HH:MM": nada arranca antes
  latestEnd: string | null; // "HH:MM": nada termina después
  freeDays: DayCode[]; // días que quiero libres enteros
  maxDays: number | null; // cuántos días estoy dispuesto a ir al campus
  campuses: CampusCode[] | null; // campus aceptados; null es todos
};

export const NO_CONSTRAINTS: ScheduleConstraints = {
  earliestStart: null,
  latestEnd: null,
  freeDays: [],
  maxDays: null,
  campuses: null,
};

// Por qué una sección quedó fuera. Se devuelve en vez de descartarse en
// silencio: "no hay combinación" sin decir qué condición la mató es una pantalla
// que no se puede accionar.
export type ConstraintReason = 'antes-de-la-hora' | 'despues-de-la-hora' | 'dia-que-querias-libre' | 'otro-campus';

export const CONSTRAINT_LABELS = {
  'antes-de-la-hora': 'empieza antes de tu hora mínima',
  'despues-de-la-hora': 'termina después de tu hora máxima',
  'dia-que-querias-libre': 'cae en un día que pediste libre',
  'otro-campus': 'es de un campus que excluiste',
} as const satisfies Record<ConstraintReason, string>;

// Evalúa UNA sección contra las condiciones. Devuelve el motivo del descarte o
// null si pasa. Un meeting sin hora (TBA) no puede violar una condición de
// hora: no se sabe cuándo es, y no saber no descarta.
export function sectionViolation(
  section: CandidateSection,
  constraints: ScheduleConstraints
): ConstraintReason | null {
  if (constraints.campuses && section.campus != null && !constraints.campuses.includes(section.campus)) {
    return 'otro-campus';
  }
  const min = constraints.earliestStart ? toMinutes(constraints.earliestStart) : null;
  const max = constraints.latestEnd ? toMinutes(constraints.latestEnd) : null;
  for (const meeting of section.meetings) {
    for (const day of meeting.days) {
      if (constraints.freeDays.includes(day as DayCode)) return 'dia-que-querias-libre';
    }
    if (!meeting.start || !meeting.end) continue;
    if (min != null && toMinutes(meeting.start) < min) return 'antes-de-la-hora';
    if (max != null && toMinutes(meeting.end) > max) return 'despues-de-la-hora';
  }
  return null;
}

// Lo que una materia perdió al aplicar las condiciones. `blocked` es el caso
// que importa: la materia tenía secciones y ninguna sobrevivió, así que el
// estudiante tiene que aflojar una condición o resignar la materia.
export type CourseFilterResult = {
  courses: CandidateCourse[];
  dropped: Array<{ code: string; classNbr: string; reason: ConstraintReason }>;
  blocked: Array<{ code: string; title: string; reasons: ConstraintReason[] }>;
};

export function applyConstraints(
  courses: CandidateCourse[],
  constraints: ScheduleConstraints
): CourseFilterResult {
  const dropped: CourseFilterResult['dropped'] = [];
  const blocked: CourseFilterResult['blocked'] = [];
  const kept: CandidateCourse[] = [];

  for (const course of courses) {
    const survivors: CandidateSection[] = [];
    const reasons = new Set<ConstraintReason>();
    for (const section of course.sections) {
      const violation = sectionViolation(section, constraints);
      if (!violation) {
        survivors.push(section);
        continue;
      }
      dropped.push({ code: course.code, classNbr: section.classNbr, reason: violation });
      reasons.add(violation);
    }
    if (survivors.length === 0 && course.sections.length > 0) {
      blocked.push({ code: course.code, title: course.title, reasons: [...reasons] });
      continue;
    }
    kept.push({ ...course, sections: survivors });
  }

  return { courses: kept, dropped, blocked };
}

export type ComboMetrics = {
  gapMinutes: number; // suma de huecos entre clases del mismo día
  earlyMinutes: number; // suma de minutos antes de las 9:00
  daysUsed: number; // días distintos con clase
};

export type Combination = {
  sections: CandidateSection[];
  metrics: ComboMetrics;
  penalty: number; // menor = mejor
};

const EARLY_CUTOFF = 9 * 60;
// Un día extra de campus "cuesta" como tres horas de huecos: pone las tres
// heurísticas en la misma unidad (minutos) para que los sliders se peleen
// en igualdad de condiciones.
const MINUTES_PER_EXTRA_DAY = 180;

function sectionsClash(a: CandidateSection, b: CandidateSection): boolean {
  for (const ma of a.meetings) {
    for (const mb of b.meetings) {
      if (meetingsOverlap(ma, mb)) return true;
    }
  }
  return false;
}

export function computeMetrics(sections: CandidateSection[]): ComboMetrics {
  const byDay = new Map<DayCode, Array<{ start: number; end: number }>>();
  for (const section of sections) {
    for (const meeting of section.meetings) {
      if (!meeting.start || !meeting.end) continue; // TBA no ocupa el día
      for (const day of meeting.days) {
        const list = byDay.get(day as DayCode) ?? [];
        list.push({ start: toMinutes(meeting.start), end: toMinutes(meeting.end) });
        byDay.set(day as DayCode, list);
      }
    }
  }

  let gapMinutes = 0;
  let earlyMinutes = 0;
  for (const intervals of byDay.values()) {
    intervals.sort((a, b) => a.start - b.start);
    earlyMinutes += Math.max(0, EARLY_CUTOFF - intervals[0].start);
    for (let i = 1; i < intervals.length; i++) {
      // end acumulado y no el del intervalo anterior: dos clases solapadas
      // (un choque que el caller decidió permitir) no generan hueco negativo.
      gapMinutes += Math.max(0, intervals[i].start - Math.max(...intervals.slice(0, i).map((x) => x.end)));
    }
  }

  return { gapMinutes, earlyMinutes, daysUsed: byDay.size };
}

export function penaltyOf(metrics: ComboMetrics, weights: Weights): number {
  return (
    weights.gaps * metrics.gapMinutes +
    weights.earlyStarts * metrics.earlyMinutes +
    weights.fewDays * metrics.daysUsed * MINUTES_PER_EXTRA_DAY
  );
}

// Enumera todas las combinaciones válidas (una sección por materia, sin
// choques) y las devuelve rankeadas de mejor a peor según los pesos.
// `limit` corta la ENUMERACIÓN, no el ranking: es una red de seguridad para
// un catálogo patológico, no paginación — de ahí el flag `truncated` para que
// la UI avise que el ranking podría no ser global.
export function solveCombinations(
  courses: CandidateCourse[],
  {
    weights = DEFAULT_WEIGHTS,
    limit = 5000,
    constraints = NO_CONSTRAINTS,
  }: { weights?: Weights; limit?: number; constraints?: ScheduleConstraints } = {}
): {
  combinations: Combination[];
  truncated: boolean;
  dropped: CourseFilterResult['dropped'];
  blocked: CourseFilterResult['blocked'];
} {
  // Las condiciones se aplican ANTES de enumerar: filtrar acá poda el árbol en
  // vez de generar miles de combinaciones para tirarlas después, y además deja
  // decir qué materia quedó sin salida y por qué.
  const filtered = applyConstraints(courses, constraints);
  const candidates = filtered.courses.filter((c) => c.sections.length > 0);
  if (candidates.length === 0) {
    return { combinations: [], truncated: false, dropped: filtered.dropped, blocked: filtered.blocked };
  }

  // Materias con menos secciones primero: poda el árbol antes.
  const ordered = [...candidates].sort((a, b) => a.sections.length - b.sections.length);

  const found: CandidateSection[][] = [];
  let truncated = false;
  const chosen: CandidateSection[] = [];

  const backtrack = (level: number) => {
    if (found.length >= limit) {
      truncated = true;
      return;
    }
    if (level === ordered.length) {
      found.push([...chosen]);
      return;
    }
    for (const section of ordered[level].sections) {
      if (chosen.some((other) => sectionsClash(section, other))) continue;
      chosen.push(section);
      backtrack(level + 1);
      chosen.pop();
      if (truncated) return;
    }
  };
  backtrack(0);

  const combinations = found
    .map((sections) => {
      const metrics = computeMetrics(sections);
      return { sections, metrics, penalty: penaltyOf(metrics, weights) };
    })
    // maxDays es la única condición que no se puede evaluar por sección: cuántos
    // días vas al campus depende de la combinación entera.
    .filter((combo) => constraints.maxDays == null || combo.metrics.daysUsed <= constraints.maxDays)
    .sort((a, b) => a.penalty - b.penalty);

  return { combinations, truncated, dropped: filtered.dropped, blocked: filtered.blocked };
}
