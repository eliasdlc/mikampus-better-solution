import type { Meeting } from './schemas.ts';
import { meetingsOverlap, toMinutes, type DayCode } from './meetings.ts';

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
  { weights = DEFAULT_WEIGHTS, limit = 5000 }: { weights?: Weights; limit?: number } = {}
): { combinations: Combination[]; truncated: boolean } {
  const candidates = courses.filter((c) => c.sections.length > 0);
  if (candidates.length === 0) return { combinations: [], truncated: false };

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
    .sort((a, b) => a.penalty - b.penalty);

  return { combinations, truncated };
}
