// Señales (Fase 10, §12.7): hechos descriptivos sobre el histórico, no consejos.
// Cada señal sale con un número al lado y NUNCA se emite por debajo de su umbral
// de datos — una señal de tendencia con dos términos, o de área con una sola
// materia, mentiría por falta de muestra. computeInsights devuelve solo las que
// se ganaron su lugar; la UI mapea sin decidir nada.
//
// Todo es puro y se calcula con la misma aritmética verificada de gpa.ts, así
// que ninguna señal puede contradecir al índice que muestra el resto de la app.

import { GRADE_POINTS, countsTowardGpa, roundGpa, termSortKey } from './gpa.ts';

export type InsightCourse = {
  code: string;
  subject: string;
  term: string | null;
  grade: string | null;
  units: number | null;
  status: string;
};

export type InsightTerm = {
  term: string;
  sortKey: string | null;
  gpa: number | null;
  unitsTowardGpa: number;
};

// Los metadatos que ordenan las señales (P5 §7). Son deterministas: dos
// historiales iguales producen el mismo orden, siempre.
//
//   severity      qué tan mal pinta. 'risk' solo ante deterioro real —el color
//                 de alarma se gana, no se reparte.
//   recency       qué tan actual es el hecho. Una caída del último ciclo pesa
//                 más que un patrón de hace tres años.
//   actionability si hay algo que hacer al respecto o es solo contexto.
//   confidence    cuánta muestra hay detrás.
export type InsightSeverity = 'risk' | 'watch' | 'info';
export type InsightRecency = 'current' | 'recent' | 'historical';
export type InsightActionability = 'act' | 'consider' | 'context';
export type InsightConfidence = 'high' | 'medium' | 'low';

export type InsightMeta = {
  severity: InsightSeverity;
  recency: InsightRecency;
  actionability: InsightActionability;
  confidence: InsightConfidence;
};

export type Insight = InsightMeta &
  (
    // El cambio reciente compara el ÚLTIMO ciclo completo contra el anterior.
    // Es una cosa distinta de la tendencia y por eso tiene su propio kind: antes
    // los tres ciclos podían decir "subiendo" con el último ciclo en caída.
    | { kind: 'recent-change'; direction: 'up' | 'down' | 'flat'; delta: number; from: { term: string; gpa: number }; to: { term: string; gpa: number } }
    | { kind: 'rolling-trend'; direction: 'rising' | 'falling' | 'flat'; delta: number; points: { term: string; gpa: number }[] }
    | { kind: 'area-performance'; best: AreaStat; worst: AreaStat }
    | { kind: 'load-vs-result'; heavy: LoadStat; light: LoadStat }
    | { kind: 'repeated-courses'; courses: { code: string; attempts: { term: string | null; grade: string | null }[] }[] }
    | { kind: 'withdrawn-courses'; count: number; codes: string[] }
  );

export type AreaStat = { subject: string; gpa: number; count: number };
export type LoadStat = { avgGpa: number; avgCredits: number; terms: number };

// Grade point de una materia que cuenta al índice, o null si no cuenta (R/S/EXO).
function points(course: InsightCourse): number | null {
  if (course.status !== 'taken' || !countsTowardGpa(course.grade)) return null;
  return GRADE_POINTS[course.grade!.toUpperCase()];
}

// Índice ponderado por créditos de un conjunto de materias calificadas.
function weightedGpa(courses: InsightCourse[]): number | null {
  let units = 0;
  let gp = 0;
  for (const c of courses) {
    const p = points(c);
    if (p === null) continue;
    const u = c.units ?? 0;
    units += u;
    gp += u * p;
  }
  return units > 0 ? gp / units : null;
}

function gradedInOrder(terms: InsightTerm[]): InsightTerm[] {
  return terms
    .filter((t) => t.gpa !== null && t.sortKey !== null)
    .slice()
    .sort((a, b) => a.sortKey!.localeCompare(b.sortKey!));
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

// El cambio reciente: último ciclo completo contra el anterior. Umbral: dos
// ciclos calificados. Es la señal que la persona siente —"me fue peor este
// cuatrimestre"— y es justamente la que la tendencia de tres podía tapar.
export function recentChange(terms: InsightTerm[]): Insight | null {
  const graded = gradedInOrder(terms);
  if (graded.length < 2) return null;

  const previous = graded[graded.length - 2];
  const latest = graded[graded.length - 1];
  const delta = round3(roundGpa(latest.gpa!) - roundGpa(previous.gpa!));
  const direction = Math.abs(delta) < 0.1 ? 'flat' : delta > 0 ? 'up' : 'down';

  // Una caída reciente es lo único de este módulo que se gana el color de
  // alarma, y solo si es material: 0.3 sobre una escala de 4 es medio punto de
  // letra, no ruido de redondeo.
  const severity: InsightSeverity = direction === 'down' ? (delta <= -0.3 ? 'risk' : 'watch') : 'info';

  return {
    kind: 'recent-change',
    direction,
    delta,
    from: { term: previous.term, gpa: roundGpa(previous.gpa!) },
    to: { term: latest.term, gpa: roundGpa(latest.gpa!) },
    severity,
    recency: 'current',
    actionability: direction === 'down' ? 'act' : 'context',
    confidence: 'high',
  };
}

// La tendencia de mediano plazo: tres ciclos. NO se llama cambio reciente y no
// puede sustituirlo — se puede venir subiendo tres ciclos y haber caído el
// último, y las dos cosas son ciertas a la vez.
export function rollingTrend(terms: InsightTerm[]): Insight | null {
  const graded = gradedInOrder(terms);
  if (graded.length < 3) return null;

  const last3 = graded.slice(-3);
  const delta = round3(roundGpa(last3[2].gpa!) - roundGpa(last3[0].gpa!));
  const direction = Math.abs(delta) < 0.1 ? 'flat' : delta > 0 ? 'rising' : 'falling';
  return {
    kind: 'rolling-trend',
    direction,
    delta,
    points: last3.map((t) => ({ term: t.term, gpa: roundGpa(t.gpa!) })),
    // Nunca 'risk': un promedio de tres ciclos no es una emergencia de hoy.
    severity: direction === 'falling' ? 'watch' : 'info',
    recency: 'recent',
    actionability: 'consider',
    confidence: 'medium',
  };
}

// Rendimiento por área: subjects con al menos dos materias calificadas, con su
// índice. Umbral: al menos dos áreas comparables, y que la mejor y la peor
// difieran de verdad (≥0.3) — si todo tu historial rinde parejo, no hay señal.
export function areaPerformance(courses: InsightCourse[]): Insight | null {
  const bySubject = new Map<string, InsightCourse[]>();
  for (const c of courses) {
    if (points(c) === null) continue;
    if (!bySubject.has(c.subject)) bySubject.set(c.subject, []);
    bySubject.get(c.subject)!.push(c);
  }

  const areas: AreaStat[] = [];
  for (const [subject, list] of bySubject) {
    if (list.length < 2) continue;
    const gpa = weightedGpa(list);
    if (gpa === null) continue;
    areas.push({ subject, gpa: roundGpa(gpa), count: list.length });
  }
  if (areas.length < 2) return null;

  areas.sort((a, b) => b.gpa - a.gpa);
  const best = areas[0];
  const worst = areas[areas.length - 1];
  if (best.gpa - worst.gpa < 0.3) return null;
  return {
    kind: 'area-performance',
    best,
    worst,
    // Saber en qué área rendís distinto es contexto para elegir carga, no una
    // alarma: nada de esto exige una acción hoy.
    severity: 'info',
    recency: 'historical',
    actionability: 'consider',
    confidence: areas.length >= 4 ? 'high' : 'medium',
  };
}

// Carga vs. resultado: se parten los términos calificados en más cargados / menos
// cargados (por la mediana de créditos) y se comparan sus índices promedio.
// Umbral: cuatro términos calificados, un rango de carga real (≥3 cr entre el
// más liviano y el más pesado) y una diferencia de índice discernible (≥0.2). Se
// reporta el hecho sin afirmar causa: dos números, no una moraleja.
export function loadVsResult(terms: InsightTerm[]): Insight | null {
  const graded = terms.filter((t) => t.gpa !== null && t.unitsTowardGpa > 0);
  if (graded.length < 4) return null;

  const credits = graded.map((t) => t.unitsTowardGpa).sort((a, b) => a - b);
  if (credits[credits.length - 1] - credits[0] < 3) return null;
  const median = credits[Math.floor(credits.length / 2)];

  const heavy = graded.filter((t) => t.unitsTowardGpa >= median);
  const light = graded.filter((t) => t.unitsTowardGpa < median);
  if (!heavy.length || !light.length) return null;

  const stat = (group: InsightTerm[]): LoadStat => ({
    avgGpa: roundGpa(group.reduce((s, t) => s + t.gpa!, 0) / group.length),
    avgCredits: Math.round((group.reduce((s, t) => s + t.unitsTowardGpa, 0) / group.length) * 10) / 10,
    terms: group.length,
  });
  const heavyStat = stat(heavy);
  const lightStat = stat(light);
  if (Math.abs(heavyStat.avgGpa - lightStat.avgGpa) < 0.2) return null;
  return {
    kind: 'load-vs-result',
    heavy: heavyStat,
    light: lightStat,
    severity: 'info',
    recency: 'historical',
    actionability: 'consider',
    confidence: graded.length >= 6 ? 'high' : 'medium',
  };
}

// Materias repetidas: mismo código con más de un intento que cuenta al índice.
// Bajo el promedio de PUCMM (verificado), el intento viejo sigue pesando, así
// que es un hecho relevante para el estudiante. Umbral: al menos una.
export function repeatedCourses(courses: InsightCourse[]): Insight | null {
  const byCode = new Map<string, InsightCourse[]>();
  for (const c of courses) {
    if (c.status !== 'taken' || !c.grade) continue;
    if (!byCode.has(c.code)) byCode.set(c.code, []);
    byCode.get(c.code)!.push(c);
  }
  const repeated = [...byCode.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([code, list]) => ({
      code,
      attempts: list
        .slice()
        // Cronológico por el ciclo, no por la etiqueta: "Abril" va después de
        // "Enero" del mismo año aunque alfabéticamente vaya antes.
        .sort((a, b) => (termSortKey(a.term ?? '') ?? '').localeCompare(termSortKey(b.term ?? '') ?? ''))
        .map((c) => ({ term: c.term, grade: c.grade })),
    }));
  if (!repeated.length) return null;
  return {
    kind: 'repeated-courses',
    courses: repeated,
    // Bajo el promedio de PUCMM el intento viejo sigue pesando: es un hecho con
    // consecuencia sobre el índice, pero ya ocurrido y sin acción posible.
    severity: 'watch',
    recency: 'historical',
    actionability: 'context',
    confidence: 'high',
  };
}

// Materias retiradas (nota R): no cuentan al índice, pero sí son créditos
// cursados sin avanzar. Umbral: al menos una.
export function withdrawnCourses(courses: InsightCourse[]): Insight | null {
  const codes = courses.filter((c) => (c.grade ?? '').toUpperCase() === 'R').map((c) => c.code);
  if (!codes.length) return null;
  return {
    kind: 'withdrawn-courses',
    count: codes.length,
    codes,
    severity: 'info',
    recency: 'historical',
    actionability: 'context',
    confidence: 'high',
  };
}

// El orden es determinista y sale de los metadatos, no de la posición en la
// que alguien escribió las funciones (P5 §7): acción inmediata → deterioro
// reciente → riesgo vigente → contexto. Empate se rompe por actualidad y
// después por confianza, así que dos historiales iguales ordenan igual.
const SEVERITY_RANK: Record<InsightSeverity, number> = { risk: 0, watch: 1, info: 2 };
const RECENCY_RANK: Record<InsightRecency, number> = { current: 0, recent: 1, historical: 2 };
const ACTION_RANK: Record<InsightActionability, number> = { act: 0, consider: 1, context: 2 };
const CONFIDENCE_RANK: Record<InsightConfidence, number> = { high: 0, medium: 1, low: 2 };

export function rankInsight(insight: Insight): number {
  return (
    ACTION_RANK[insight.actionability] * 1000 +
    SEVERITY_RANK[insight.severity] * 100 +
    RECENCY_RANK[insight.recency] * 10 +
    CONFIDENCE_RANK[insight.confidence]
  );
}

// Todas las señales que se ganaron su umbral, ordenadas por prioridad real.
export function computeInsights(terms: InsightTerm[], courses: InsightCourse[]): Insight[] {
  return [
    recentChange(terms),
    rollingTrend(terms),
    areaPerformance(courses),
    loadVsResult(terms),
    repeatedCourses(courses),
    withdrawnCourses(courses),
  ]
    .filter((s): s is Insight => s !== null)
    .sort((a, b) => rankInsight(a) - rankInsight(b));
}
